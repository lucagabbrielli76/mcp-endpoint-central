import { readFileSync } from "node:fs";

// Security note: `apiToken` and `caCert` must never be logged, included in
// thrown error messages, or echoed back in a tool result. Only httpClient.ts
// may read Config.apiToken, and only to set the Authorization header.
export interface Config {
  baseUrl: string;
  apiToken: string;
  caCert?: Buffer;
  defaultPageLimit: number;
  /**
   * Least-privilege default: mutating tools (patch install, agent uninstall,
   * APD task changes, custom-field writes, ...) are not even registered unless
   * ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS=true. A read-only deployment therefore
   * exposes no write surface at all to the connected LLM client.
   */
  enableWriteTools: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for setup instructions.`
    );
  }
  return value;
}

function loadCaCert(path: string | undefined): Buffer | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(
      `Failed to read CA certificate at ${path} (from ENDPOINT_CENTRAL_CA_CERT_PATH): ${(err as Error).message}`
    );
  }
}

function loadBooleanFlag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  throw new Error(`${name} must be "true" or "false" (got "${process.env[name]}").`);
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const baseUrl = required("ENDPOINT_CENTRAL_BASE_URL").replace(/\/+$/, "");
  const apiToken = required("ENDPOINT_CENTRAL_API_TOKEN");
  const caCert = loadCaCert(process.env.ENDPOINT_CENTRAL_CA_CERT_PATH);

  const defaultPageLimit = Number(process.env.ENDPOINT_CENTRAL_DEFAULT_PAGE_LIMIT ?? 50);
  if (!Number.isInteger(defaultPageLimit) || defaultPageLimit < 1 || defaultPageLimit > 1000) {
    throw new Error(
      "ENDPOINT_CENTRAL_DEFAULT_PAGE_LIMIT must be an integer between 1 and 1000 (the server's own page-size cap)."
    );
  }

  const enableWriteTools = loadBooleanFlag("ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS");

  cached = { baseUrl, apiToken, caCert, defaultPageLimit, enableWriteTools };
  return cached;
}
