import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig } from "./config.js";
import { EndpointCentralApiError } from "./errors.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;

let cachedAgent: Agent | undefined;

/**
 * Only built with a custom CA when ENDPOINT_CENTRAL_CA_CERT_PATH is set.
 * Without it, requests use Node's default trust store — the on-prem server's
 * certificate must already be trusted by the OS/Node in that case.
 */
function getAgent(): Agent | undefined {
  const { caCert } = loadConfig();
  if (!caCert) return undefined;
  if (!cachedAgent) {
    cachedAgent = new Agent({ connect: { ca: caCert } });
  }
  return cachedAgent;
}

/**
 * SSRF guard: tool code must only ever pass a hardcoded, relative API path
 * here (e.g. "/api/1.4/som/computers"), never a full URL or anything derived
 * from model/user input. Rejecting absolute URLs and protocol markers means
 * even a future bug that accidentally wires untrusted input into `path`
 * cannot redirect requests to an arbitrary host.
 */
function buildUrl(path: string, query?: QueryParams): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw new Error(
      `Refusing to build a request from an absolute/protocol-relative path: ${path}. ` +
        `Tool code must pass a relative API path only.`
    );
  }

  const { baseUrl } = loadConfig();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * For endpoints where a path segment is dynamic (e.g. the custom-report
 * "{crview}.ec" endpoint, keyed by report ID/name), validate the segment
 * against a strict allowlist before interpolating it into a URL. This
 * prevents path traversal or smuggling extra path/query structure through
 * a value that ultimately originates from tool input.
 */
export function assertSafePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}". Only letters, digits, dot, underscore, and hyphen are allowed.`
    );
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: { query?: QueryParams; body?: unknown } = {}
): Promise<T> {
  const { apiToken, baseUrl } = loadConfig();
  const url = buildUrl(path, opts.query);

  let res;
  try {
    res = await undiciFetch(url, {
      method,
      headers: {
        // On-prem Endpoint Central expects the raw token, not "Bearer <token>".
        Authorization: apiToken,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      dispatcher: getAgent(),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.cause ?? err.message : String(err);
    throw new Error(
      `Could not reach Endpoint Central server at ${baseUrl} (path ${path}). ` +
        `Check ENDPOINT_CENTRAL_BASE_URL, network connectivity, and TLS/CA configuration. Cause: ${cause}`
    );
  }

  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON response body — surface as raw text.
    }
  }

  if (!res.ok) {
    throw new EndpointCentralApiError(res.status, path, parsed);
  }

  return parsed as T;
}

export const httpClient = {
  get: <T>(path: string, query?: QueryParams) => request<T>("GET", path, { query }),
  post: <T>(path: string, body?: unknown, query?: QueryParams) =>
    request<T>("POST", path, { body, query }),
  put: <T>(path: string, body?: unknown, query?: QueryParams) =>
    request<T>("PUT", path, { body, query }),
  delete: <T>(path: string, query?: QueryParams) => request<T>("DELETE", path, { query }),
};
