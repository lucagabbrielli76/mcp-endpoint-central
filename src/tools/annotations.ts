/**
 * Standard MCP tool annotations used across every module, so clients can
 * apply their own policy (e.g. auto-approve read-only tools, always prompt
 * on destructive ones). Keep these three shared constants as the only
 * annotation sources — don't hand-roll per-tool annotation objects.
 *
 * openWorldHint is false everywhere: this server only ever talks to the one
 * configured Endpoint Central host, never the open internet.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

/** Mutating but not destructive (e.g. trigger a scan, approve a patch). */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Mutating and destructive/irreversible (uninstall, remove, delete). */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
