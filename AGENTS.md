# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, etc.) picking up this repo.

## What this is

An MCP (Model Context Protocol) server exposing the **ManageEngine Endpoint
Central (on-premise)** REST API as tools for LLM agents. The customer runs
Endpoint Central self-hosted, not the cloud SaaS product — this repo targets
on-prem auth and behavior specifically; do not assume Zoho OAuth2 applies.

The full OpenAPI spec (110 operations, downloaded from ManageEngine's cloud
docs — closest available reference, on-prem parity not guaranteed for every
endpoint) lives at `spec/oas-dc.json`.

## Stack

TypeScript, `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport),
`zod` for input schemas, `undici` for HTTP (needed for custom-CA TLS support).
Node >= 18. In this dev environment Node lives at `~/.local/bin/node` (no nvm,
no system Node).

## Commands

```
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc -> dist/
npm run dev           # tsx src/index.ts (uses esbuild; its postinstall script
                       # was blocked by this environment's allow-scripts guard
                       # — if `npm run dev` fails, use `npm run build && npm start` instead)
npm start              # node dist/index.js
npm run test:smoke      # stdio smoke test, both modes, no real server needed —
                        # run this after any tool/module change
```

Config comes from env vars documented in `.env.example`. Copy it to `.env`
(gitignored) and fill in `ENDPOINT_CENTRAL_BASE_URL` / `ENDPOINT_CENTRAL_API_TOKEN`
before running against a real server. There's no `.env` loader wired in yet
(config.ts reads `process.env` directly) — either export vars in your shell
or add a dotenv step if that becomes annoying.

## Auth model (on-prem, not cloud)

Static API token generated in the Endpoint Central console under
**Admin -> Integrations -> API Key Management**, sent as a raw
`Authorization: <token>` header (not `Bearer`, not `Zoho-oauthtoken`). No
OAuth flow, no refresh, no expiry beyond manual revocation. See
`src/httpClient.ts` and `.env.example` for details. Recommend the token come
from a dedicated least-privileged service account, not an admin login —
on-prem access is governed by that account's RBAC role, since the API itself
has no scope concept of its own.

## Architecture conventions — follow these for every new tool

- **One file per module** under `src/tools/` (e.g. `patch.ts`, `inventory.ts`),
  registered in `src/tools/index.ts` via a `registerXTools(server)` function.
  Follow the pattern in `src/tools/som.ts`.
- **Tool naming**: `<module>_<action>`, e.g. `patch_install_specific_in_specific_systems`.
  Near-1:1 with the spec's real operations (this was an explicit decision —
  not consolidating into fewer mega-tools with action enums).
- **Response shaping is mandatory** for list/report endpoints. Raw Endpoint
  Central responses are wide, DB-shaped objects (`resourcemac.dhcp_server_ip_address`
  style field names) — dozens of fields per record. Use `projectList` /
  `projectRecord` from `src/shaping.ts` to curate a sane default field set,
  and always expose a `raw: true` input option for full fidelity. Use
  `paginationNote` to tell the caller how to page further instead of
  silently truncating.
- **Pagination**: most GETs use `page` / `pagelimit` query params (server
  hard cap: 1000/page). A few endpoints (e.g. `dcapi/threats/detailedinfo/vulnerabilities`)
  use an opaque `cursor` in the POST body instead — check the spec per
  endpoint, don't assume one pagination style for everything.
- **Mutating/destructive tools MUST call `assertConfirmed(args.confirm, "<action description>")`**
  from `src/errors.ts` as the first line of the handler. Applies to patch
  install/uninstall/approve/decline, agent install/uninstall/remove, APD
  task create/modify/delete/suspend/resume, custom field delete/import, etc.
- **Write gating**: mutating tools must only be registered when
  `loadConfig().enableWriteTools` is true — put `const { enableWriteTools } =
  loadConfig(); if (!enableWriteTools) return;` in the register function
  *after* registering the module's read tools, then register write tools below
  it (see `registerSomTools` in `src/tools/som.ts`). Read-only mode must
  expose zero write surface.
- **Annotations**: every tool passes one of the three shared constants from
  `src/tools/annotations.ts` as `annotations`: `READ_ONLY` for all GET-backed
  tools, `WRITE` for mutating-but-recoverable actions (trigger scan, approve
  patch), `DESTRUCTIVE` for uninstall/remove/delete. Don't hand-roll
  annotation objects.
- **httpClient paths must be relative string literals only** — never pass a
  full URL or anything derived from tool input as the `path` argument
  (`buildUrl` in `src/httpClient.ts` throws if you do; this is a deliberate
  SSRF guard, don't work around it). For the one endpoint with a dynamic path
  segment (`/{crview}.ec`, custom reports), run the segment through
  `assertSafePathSegment` before interpolating it.
- **Never log or echo `apiToken` or `caCert`** (see the comment on `Config`
  in `src/config.ts`). Error messages must stay silent about the token even
  on auth failures — `EndpointCentralApiError` already handles 401/403
  messaging correctly; don't bypass it with raw fetch calls in tool code.

## Where things stand

**All planned modules are implemented: 107 tools across 11 modules** (84
read-only, 23 write-gated behind `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS`):
`som`, `inventory`, `patch` (reads), `patchactions`, `threats`, `bitlocker`,
`dcm`, `dlp`, `reports`, `customfields`, `dex` — all registered in
`src/tools/index.ts`. Build/typecheck pass. Smoke-tested end-to-end over MCP
stdio JSON-RPC in both modes: read-only exposes 84 tools and zero write
surface; write mode exposes all 107, and the confirm gate fires before any
network I/O. Verified no token leakage into error output. README.md documents
setup for Claude Code/Desktop, config, the security model, and the full tool
catalog.

Intentionally NOT implemented (multipart file uploads, incompatible with the
JSON-only httpClient — noted in `src/tools/customfields.ts`):
`PUT /dcapi/customFields/computers/{ID}/file`, `PUT /dcapi/customFields/values/file`,
`POST /dcapi/customFields/computers/values/import`.

**Remaining / next steps:**

1. **Verify against the customer's actual on-prem server** via its
   **Admin -> Integrations -> API Explorer** — the downloaded cloud spec may
   not have 1:1 parity with what their on-prem build/license exposes (still
   not done as of this writing). Highest-risk areas: vendor accept headers on
   `/dcapi/*` endpoints, `threats_vulnerability_computers_detail` (spec says
   GET-with-body; implemented as POST), `custom_column_remove` (DELETE with
   JSON body), curated default field sets (derived from spec examples).
2. Consider integration tests with a mocked Endpoint Central HTTP server
   (the smoke test in-repo covers MCP plumbing, not response shaping).
3. Optional: multipart support in httpClient if the file-upload/CSV-import
   endpoints are ever needed.

## Quick gotchas already hit once

- Piping remote scripts straight into `bash` (`curl | bash`) is blocked by
  this environment's guard — download to a file first, then `bash file.sh`.
- `esbuild`'s postinstall (needed by `tsx`) gets blocked by npm's
  allow-scripts policy here; doesn't affect `tsc`-based build/typecheck/start.
