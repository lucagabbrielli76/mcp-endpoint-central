/**
 * Endpoint Central list responses return dozens of raw, DB-style fields per
 * record (e.g. "resourcemac.dhcp_server_ip_address"). Passed straight through,
 * a single list call can dump tens of KB of noise into an LLM's context.
 * These helpers trim responses down to a curated field set by default, with
 * a `raw` escape hatch left to each tool's input schema for full fidelity.
 */

export function projectRecord(
  record: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in record) {
      out[field] = record[field];
    }
  }
  return out;
}

export function projectList(
  records: readonly Record<string, unknown>[],
  fields: readonly string[]
): Record<string, unknown>[] {
  return records.map((r) => projectRecord(r, fields));
}

export interface PaginationMeta {
  total?: number;
  page?: number;
  limit?: number;
}

export function paginationNote(meta: PaginationMeta): string | undefined {
  const { total, page, limit } = meta;
  if (total === undefined || page === undefined || limit === undefined) return undefined;

  const shown = Math.max(0, Math.min(limit, total - (page - 1) * limit));
  const remaining = total - page * limit;

  if (remaining <= 0) {
    return `Showing ${shown} of ${total} total (page ${page}, last page).`;
  }
  return (
    `Showing ${shown} of ${total} total (page ${page}). ` +
    `${remaining} more available — call again with page: ${page + 1} to continue.`
  );
}

export function toToolResult(payload: unknown, note?: string) {
  const text = note
    ? `${note}\n\n${JSON.stringify(payload, null, 2)}`
    : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

export function toErrorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}
