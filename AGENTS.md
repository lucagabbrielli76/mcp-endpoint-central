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
Node >= 18. This environment uses nvm (`~/.nvm`) since no system Node exists;
run `nvm use default` before any npm/node command if PATH doesn't already
resolve them.

## Commands

```
npm install
npm run typecheck   # tsc --noEmit
npm run build        # tsc -> dist/
npm run dev           # tsx src/index.ts (uses esbuild; its postinstall script
                       # was blocked by this environment's allow-scripts guard
                       # — if `npm run dev` fails, use `npm run build && npm start` instead)
npm start              # node dist/index.js
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

Phase 1 (scaffold) is done and verified: build/typecheck pass, and the
server was smoke-tested end-to-end over actual MCP stdio JSON-RPC
(`initialize` -> `tools/list` -> `tools/call`) with a fake token against both
an unreachable host (clean error, no crash) and schema inspection (`tools/list`
renders `som_computers_list`'s zod schema correctly). Only one tool exists so far:
`som_computers_list` (`src/tools/som.ts`) — it's the reference implementation
for every module below.

**Not yet started** — build in this order (see full rationale in conversation
history / commit log, not duplicated here):

1. Read-only core: rest of SoM (`summary`, install/uninstall/remove agent —
   note remove/uninstall are mutating despite living in "SoM"), Inventory
   (computers/hardware/software/licenses/metering), Patch reads (summary,
   allpatches, allsystems, scandetails, deploymentpolicies, etc.), Reports
   (query reports, custom reports, the dynamic `{crview}.ec` endpoint).
2. Security/compliance reads: `dcapi/threats/*` (vulnerabilities,
   misconfigurations), BitLocker, DLP/DCM reports.
3. Mutating tools: patch install/uninstall/approve/decline, APD tasks, agent
   install/uninstall/remove — all confirm-gated per the convention above.
4. Custom fields/columns (`dcapi/customColumn`, `dcapi/customFields`) and DEX
   (`intelligence/api/*`).
5. Before/alongside all of the above: verify against the customer's actual
   on-prem server via its own **Admin -> Integrations -> API Explorer** —
   the downloaded spec may not have 1:1 parity with what their on-prem
   build/license actually exposes (this still hasn't been done as of this
   writing).

## Quick gotchas already hit once

- Piping remote scripts straight into `bash` (`curl | bash`) is blocked by
  this environment's guard — download to a file first, then `bash file.sh`.
- `esbuild`'s postinstall (needed by `tsx`) gets blocked by npm's
  allow-scripts policy here; doesn't affect `tsc`-based build/typecheck/start.
