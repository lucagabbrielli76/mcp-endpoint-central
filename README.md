# mcp-endpoint-central

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for **ManageEngine Endpoint Central — on-premise edition**. It lets MCP clients such as Claude Code, Claude Desktop, and other LLM agents query and (optionally) operate your Endpoint Central server through its REST API: managed computers, inventory, patch status, vulnerabilities, BitLocker, device control, DLP reports, and more.

> **On-prem only.** This server targets the self-hosted Endpoint Central product and its static API-token authentication. It does not implement Zoho OAuth2 and will not work against the Endpoint Central Cloud SaaS API.

## Highlights

- **Read-only by default.** Mutating tools (patch install/uninstall, agent uninstall, task changes, …) are *not registered at all* unless you explicitly opt in with `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS=true`. In the default mode the connected LLM has no write surface to call.
- **Double confirmation on writes.** Even with write tools enabled, every mutating tool refuses to act unless the call includes `confirm: true`, so a client (or model) cannot trigger a destructive action in a single accidental step.
- **MCP tool annotations.** Every tool declares `readOnlyHint` / `destructiveHint` annotations, so clients that implement annotation-based policies (auto-approve reads, always prompt on destructive) work out of the box.
- **Context-friendly responses.** Endpoint Central's raw API returns dozens of DB-style fields per record. List tools project responses down to a curated field set by default (pass `raw: true` for full fidelity) and every paginated tool tells the model exactly how to fetch the next page.
- **Secure by design.** Static token is kept out of logs, error messages, and tool results; request paths are SSRF-guarded; internal-CA TLS is supported without ever disabling certificate verification.

## Requirements

- Node.js ≥ 18
- A reachable ManageEngine Endpoint Central **on-premise** server (default port 8383/HTTPS)
- An API token generated in the Endpoint Central console: **Admin → Integrations → API Key Management**

## Quick start

```bash
git clone <this-repo>
cd mcp-endpoint-central
npm install
npm run build
```

### Claude Code

```bash
claude mcp add endpoint-central \
  --env ENDPOINT_CENTRAL_BASE_URL=https://ec-server.corp.example:8383 \
  --env ENDPOINT_CENTRAL_API_TOKEN=YOUR_TOKEN \
  -- node /absolute/path/to/mcp-endpoint-central/dist/index.js
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "endpoint-central": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-endpoint-central/dist/index.js"],
      "env": {
        "ENDPOINT_CENTRAL_BASE_URL": "https://ec-server.corp.example:8383",
        "ENDPOINT_CENTRAL_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml` (or use `codex mcp add`), then verify with `/mcp` in a session:

```toml
[mcp_servers.endpoint-central]
command = "node"
args = ["/absolute/path/to/mcp-endpoint-central/dist/index.js"]

[mcp_servers.endpoint-central.env]
ENDPOINT_CENTRAL_BASE_URL = "https://ec-server.corp.example:8383"
ENDPOINT_CENTRAL_API_TOKEN = "YOUR_TOKEN"
```

### OpenCode

Add to `opencode.json` in your project root (or globally in `~/.config/opencode/opencode.json`). Note OpenCode wants one `command` array and the key `environment`, not `env`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "endpoint-central": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-endpoint-central/dist/index.js"],
      "enabled": true,
      "environment": {
        "ENDPOINT_CENTRAL_BASE_URL": "https://ec-server.corp.example:8383",
        "ENDPOINT_CENTRAL_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### Hermes Agent

Add to `~/.hermes/config.yaml`, then restart Hermes or run `/reload-mcp` in an active session:

```yaml
mcp_servers:
  endpoint-central:
    command: "node"
    args: ["/absolute/path/to/mcp-endpoint-central/dist/index.js"]
    env:
      ENDPOINT_CENTRAL_BASE_URL: "https://ec-server.corp.example:8383"
      ENDPOINT_CENTRAL_API_TOKEN: "YOUR_TOKEN"
```

Hermes deliberately does not pass your shell environment to MCP subprocesses — only its safe baseline plus what you put in `env`. So every `ENDPOINT_CENTRAL_*` variable you need (including `ENDPOINT_CENTRAL_CA_CERT_PATH` or `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS` if you use them) must be listed explicitly in this block.

### Any other MCP client

The server speaks MCP over stdio. Point your client at `node dist/index.js` with the environment variables below.

### Local development run

```bash
cp .env.example .env      # fill in your values; .env is gitignored
node --env-file=.env dist/index.js
```

### Try it

Once connected, ask your MCP client things like:

- *"List all computers whose agent hasn't contacted the server in over 30 days."*
- *"What critical vulnerabilities affect our network? Which systems are hit worst?"*
- *"Show the patch summary, then the missing patches with severity Important or higher."*
- *"Which computers still have BitLocker disabled on their system drive?"*
- *"What prohibited software was found, and on which machines?"*

## Configuration

All configuration is via environment variables (see `.env.example` for the commented reference):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ENDPOINT_CENTRAL_BASE_URL` | yes | — | Base URL of your on-prem server, e.g. `https://ec-server.corp.example:8383`. No trailing path. |
| `ENDPOINT_CENTRAL_API_TOKEN` | yes | — | Static API token from **Admin → Integrations → API Key Management**. Treat like a password. |
| `ENDPOINT_CENTRAL_CA_CERT_PATH` | no | — | Path to a PEM CA bundle if the server's TLS certificate is issued by an internal/private CA. |
| `ENDPOINT_CENTRAL_DEFAULT_PAGE_LIMIT` | no | `50` | Default page size for list tools (server hard cap: 1000). |
| `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS` | no | `false` | Set `true` to register mutating tools. Leave unset for a read-only deployment. |

### Generating the API token

Endpoint Central on-prem offers two ways to authenticate to its API. **This server uses the static API key**, which is the only one that works unattended:

| | Static API key | Login API (`/api/1.4/desktop/authentication`) |
|---|---|---|
| How you get it | Generated in the console, once | POST username + base64 password each time |
| With MFA enabled | You complete MFA **once**, in the browser, when generating the key | Every login needs a fresh OTP via `.../otpValidate` |
| Suitable for a headless MCP server | ✅ Yes | ❌ No — a human must read the OTP each time |
| Credentials at rest | One revocable key | Your AD account password |

Steps:

1. Decide which account the key belongs to. The key inherits that account's RBAC role — the on-prem API has **no scopes of its own**, so the account's role *is* the entire permission boundary. Prefer a dedicated service account over a person's day-to-day login, and the least-privileged role that still covers the modules you need. (Note: generating an API key requires administrator privilege in the console, so verify with your Endpoint Central admin which roles are available to you.)
2. Log in to the console as that account and complete MFA normally.
3. Go to **Admin → Integrations → API Key Management**, generate the key, and **copy it immediately** — it is typically shown only once. If the form offers an expiry date, note it; the key stops working that day.
4. Put it in `ENDPOINT_CENTRAL_API_TOKEN` and verify with `npm run check` (see below).

A key is invalidated by: regenerating it (the previous key dies immediately), deleting the user it belongs to, or reaching its expiry date if you set one.

### Active Directory + MFA deployments

If your console uses **AD authentication with MFA (email OTP, authenticator app, or similar)**, nothing changes for this server — that's the point of the static key. You authenticate interactively **once** (AD password + OTP) in the browser to generate the key; from then on the key is a self-contained credential and the MCP server never performs an interactive login, never sees your AD password, and never needs an OTP.

Consequences worth planning for:

- **Do not** try to feed AD credentials to this server. It has no username/password mode by design: storing a domain password in an MCP client's config would be a worse credential than a scoped, revocable key, and email OTP would break the flow on every restart anyway.
- **Service account vs. personal account.** A key tied to a person dies when their account is deleted or disabled — including when they leave. Ask your Endpoint Central admin for a dedicated service account where policy allows.
- **AD password rotation.** The key is stored separately from the AD password, but this isn't documented by ManageEngine either way. Test it after your first rotation, and keep `npm run check` handy for a 5-second verdict.
- **Revocation.** To kill access instantly, regenerate the key in the console (or disable the account). Then update `ENDPOINT_CENTRAL_API_TOKEN` wherever it's configured.

### Verify your configuration

```bash
cp .env.example .env    # fill in base URL + token
npm run build
npm run check           # reads .env, starts the server, calls a real endpoint
```

`npm run check` reports exactly where a setup breaks — unreachable host, TLS trust failure, 401 (bad/expired/superseded key), or 403 (valid key, insufficient role) — each with the specific fix. It never prints your token.

### TLS with an internal CA

If your Endpoint Central server uses a certificate from an internal CA, export the CA (PEM) and set `ENDPOINT_CENTRAL_CA_CERT_PATH=/path/to/ca.pem`. The server then trusts that CA **in addition to performing full certificate verification** — there is deliberately no "skip TLS verification" option.

## Tool catalog

**107 tools** across 11 modules: 84 read-only (always registered) and 23 mutating (registered only when `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS=true`). Legend: 🔍 read-only · ✏️ mutating · 🗑️ destructive.

| Module | Tools | Covers |
|---|---|---|
| Scope of Management | 6 | Managed computers, SoM summary, remote offices; agent install/uninstall, computer removal |
| Inventory | 17 | Hardware, software, licenses, prohibited software, software metering, scan status |
| Patch management (read) | 13 | Patch/system status, scan details, deployment policies & configs, approval settings, DB update status |
| Patch management (actions) | 14 | Approve/decline, scans, install/uninstall configurations, APD task lifecycle |
| Threats & vulnerabilities | 10 | CVEs, vulnerability-to-computer mapping, system/web-server misconfigurations, per-system reports |
| BitLocker | 3 | Encryption reports, recovery keys, TPM details |
| Device control (DCM) | 9 | Device/block audits, per-computer device status, exemptions, file trace & shadow |
| Data loss prevention (DLP) | 11 | Endpoint activity, justifications, false positives, deployed rules/devices/domains/printers |
| Reports & groups | 6 | Query reports (+data), custom reports (+data), custom groups, server properties |
| Custom fields | 11 | Custom column/data-type management, per-computer custom field reads & updates |
| Digital Employee Experience | 7 | DEX scores per device/profile, metric breakdowns, score generation times |

<details>
<summary><strong>Scope of Management (som_*)</strong></summary>

- 🔍 `som_computers_list` — managed computers with hostname, IP, OS, agent/live status; rich filters
- 🔍 `som_summary` — network-wide agent installation and live status summary
- 🔍 `som_remote_offices_list` — remote/branch offices with replication and distribution server details
- ✏️ `som_agent_install` — install the agent on computers already visible in SoM
- 🗑️ `som_agent_uninstall` — uninstall the agent from computers
- 🗑️ `som_computer_remove` — remove computers from the Scope of Management

</details>

<details>
<summary><strong>Inventory (inventory_*)</strong></summary>

- 🔍 `inventory_all_summary` — module-wide scan/software/hardware summary
- 🔍 `inventory_computer_details_summary` — per-computer inventory summary
- 🔍 `inventory_filter_params` — valid values for inventory filters
- 🔍 `inventory_hardware_list` / `inventory_software_list` — all detected hardware/software
- 🔍 `inventory_installed_software_list` — software installed on one computer
- 🔍 `inventory_licenses_list` / `inventory_license_software_list` — license records and compliance
- 🔍 `inventory_prohibited_software_list` — prohibited software and where it's installed
- 🔍 `inventory_scan_computers_list` — per-computer inventory scan status
- 🔍 `inventory_software_metering_summary` — metering rules with usage metrics
- 🔍 `inventory_computers_by_software` / `_by_hardware` / `_with_metering` / `_by_licensed_software` / `_by_license` / `_by_prohibited_software` — computers matching a specific inventory entity

</details>

<details>
<summary><strong>Patch management — read (patch_*)</strong></summary>

- 🔍 `patch_summary` — installed/missing/applicable counts and severity breakdown
- 🔍 `patch_all_patches_list` / `patch_all_patch_details` — patch catalog and per-patch computer status
- 🔍 `patch_all_systems_list` — systems with patch health status
- 🔍 `patch_scan_details` — per-system patch scan status
- 🔍 `patch_system_report` — every patch applicable to one computer
- 🔍 `patch_deployment_policies_list` / `patch_view_config` — deployment templates and configurations
- 🔍 `patch_downloaded_patches_list` / `patch_supported_patches_list` — downloaded binaries, supported catalog
- 🔍 `patch_approval_settings` / `patch_health_policy` / `patch_db_update_status` — module settings and DB refresh status

</details>

<details>
<summary><strong>Patch management — actions (patch_*, apd_task_*)</strong> — write-gated</summary>

- ✏️ `patch_approve` / `patch_unapprove` / `patch_decline` — patch approval workflow
- ✏️ `patch_scan_computers` / `patch_scan_all_computers` — trigger patch scans
- ✏️ `patch_install_on_all_systems` / `patch_install_on_specific_systems` / `patch_install_all_missing_on_systems` — create/deploy install configurations
- 🗑️ `patch_uninstall` — deploy an uninstall-patch configuration
- ✏️ `apd_task_create` / `apd_task_modify` / `apd_task_suspend` / `apd_task_resume` — Automatic Patch Deployment task lifecycle
- 🗑️ `apd_task_delete` — permanently delete an APD task

</details>

<details>
<summary><strong>Threats & vulnerabilities (threats_*)</strong></summary>

- 🔍 `threats_vulnerabilities_list` — network-wide CVEs with severity/CVSS, exploit status
- 🔍 `threats_vulnerability_computers_detail` — cursor-paged vulnerability-to-computer bulk export
- 🔍 `threats_patches_list` — applicable patches from the threats module
- 🔍 `threats_server_misconfigurations_list` / `threats_system_misconfigurations_list` — hardening findings
- 🔍 `threats_system_report` (+ `_patches`, `_vulnerabilities`, `_server_misconfigurations`, `_system_misconfigurations`) — per-system threat drill-downs

</details>

<details>
<summary><strong>BitLocker (bitlocker_*)</strong></summary>

- 🔍 `bitlocker_reports_list` — drive-level encryption status
- 🔍 `bitlocker_recovery_key_details` — recovery key records (key material excluded from default output; requires `raw: true`)
- 🔍 `bitlocker_tpm_report` — TPM presence/version details

</details>

<details>
<summary><strong>Device control (dcm_*)</strong></summary>

- 🔍 `dcm_device_audit_list` / `dcm_block_device_audit_list` — device activity and blocked-device events
- 🔍 `dcm_device_summary_list` — unique devices detected in the network
- 🔍 `dcm_computer_device_status_list` / `dcm_mac_computer_device_status_list` — per-computer device control status
- 🔍 `dcm_device_exemption_list` / `dcm_device_type_exemption_list` — temporary exemptions
- 🔍 `dcm_file_trace_list` / `dcm_file_shadow_list` — file activity and shadow-copy operations

</details>

<details>
<summary><strong>Data loss prevention (dlp_*)</strong></summary>

- 🔍 `dlp_endpoint_activity_report` — DLP activities on endpoints
- 🔍 `dlp_justification_report` — user business justifications for overrides
- 🔍 `dlp_network_cbfp_report` / `dlp_network_dcfp_report` — reported false positives
- 🔍 `dlp_network_rules_report` / `dlp_network_device_report` / `dlp_network_email_report` / `dlp_network_printer_report` / `dlp_network_usb_printer_report` / `dlp_network_product_report` / `dlp_network_web_domain_report` — deployed DLP entities with custom-group associations

</details>

<details>
<summary><strong>Reports & groups (reports_*, customgroup_list, server_properties)</strong></summary>

- 🔍 `reports_query_reports_list` / `reports_query_report_data` — SQL query reports and their rows
- 🔍 `reports_custom_reports_list` / `reports_custom_report_data` — custom report views and their rows
- 🔍 `customgroup_list` — custom groups with type and member counts
- 🔍 `server_properties` — domains, custom groups, and branch offices managed by the server

</details>

<details>
<summary><strong>Custom fields (custom_column_*, custom_field_*)</strong></summary>

- 🔍 `custom_column_data_types_list` / `custom_column_udt_length` / `custom_column_udt_name_exists` — custom data type metadata
- 🔍 `custom_field_values_get` / `custom_field_metadata_list` — per-resource custom field values and metadata
- ✏️ `custom_column_add` / `custom_column_modify` / `custom_column_value_modify` / `custom_column_data_type_create` — write-gated field management
- ✏️ `custom_field_computer_update` — update field values on one computer
- 🗑️ `custom_column_remove` — delete a custom field and its stored values

(File-upload endpoints — FILE-type field uploads and bulk CSV import — are intentionally not implemented; they require multipart uploads outside this server's JSON-only HTTP client.)

</details>

<details>
<summary><strong>Digital Employee Experience (dex_*)</strong></summary>

- 🔍 `dex_addon_info` / `dex_meta` — DEX module status and configuration
- 🔍 `dex_device_experience` / `dex_device_experience_metrics` — per-device scores and indicator breakdowns
- 🔍 `dex_latest_experience_scores` — latest score for a profile
- 🔍 `dex_last_score_update_time` / `dex_next_score_update_time` — score generation schedule

</details>

> **On-prem parity note:** the tool surface follows ManageEngine's published API reference. Individual endpoints can vary by on-prem build and license; verify anything critical against your own server's **Admin → Integrations → API Explorer**.

## Working with results

- **Pagination:** list tools accept `page` and `pageLimit`. Results include a note like *"Showing 50 of 3210 total (page 1). 3160 more available — call again with page: 2."* so the model knows how to continue.
- **Curated fields:** list responses are projected to the most useful fields by default. Pass `raw: true` to any list tool for the complete, unprojected records.
- **Mutating tools:** only exist when `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS=true`, and each call must include `confirm: true` or it is refused with an explanation before any network request is made.

## Security model

This server follows MCP security best practices; the design decisions in short:

| Measure | What it does |
|---|---|
| Read-only default | Write tools are not registered unless explicitly enabled — least privilege at the tool-surface level. |
| Per-call confirm gate | Every mutating tool requires `confirm: true`; refusal happens before any API request. |
| Tool annotations | `readOnlyHint`/`destructiveHint` on every tool let clients enforce their own approval policies. |
| Token hygiene | The token is read once from the environment, used only for the `Authorization` header, and never logged, echoed in errors, or returned in tool results. |
| RBAC-scoped account | Recommended setup binds the token to a dedicated least-privileged service account, bounding blast radius if it leaks. |
| SSRF guard | HTTP-layer refuses absolute URLs/protocol-relative paths; tools may only call hardcoded relative API paths against the one configured host. Dynamic path segments are allowlist-validated. |
| TLS verification always on | Internal CAs are supported via an *additional* trust anchor, never by disabling verification. |
| No secrets in the repo | `.env` is gitignored; `.env.example` documents variables without values. |

Additional deployment recommendations:

- Run the server on a host/network segment that is allowed to reach the Endpoint Central console anyway; the server initiates connections only to `ENDPOINT_CENTRAL_BASE_URL`.
- Prefer the read-only default in day-to-day use; enable write tools only in sessions where remediation is intended, then turn them back off.
- BitLocker recovery keys are secrets — the recovery-key tool keeps key material out of its default output; only request it when genuinely needed.
- Review your MCP client's permission settings so destructive-annotated tools always prompt.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Startup fails: `Missing required environment variable` | Set `ENDPOINT_CENTRAL_BASE_URL` / `ENDPOINT_CENTRAL_API_TOKEN` in the client's `env` block (stdio servers don't inherit your shell profile). |
| `Could not reach Endpoint Central server` | Wrong base URL/port, firewall, or TLS failure. For internal CAs set `ENDPOINT_CENTRAL_CA_CERT_PATH`. |
| `Authentication failed (401)` | Token invalid or revoked — regenerate under **Admin → Integrations → API Key Management**. |
| `Access denied (403)` | The token's account lacks the RBAC role for that module — adjust in **Admin → User Administration**. |
| A tool from the docs is missing | Write tools require `ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS=true`. Also, on-prem builds/licenses vary — verify the endpoint exists in your console under **Admin → Integrations → API Explorer**. |
| Mutating call returns "requires confirm: true" | Working as intended — repeat the call with `confirm: true` once you're sure. |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm run dev         # tsx src/index.ts
npm run test:smoke  # stdio smoke test in both modes (no real server needed):
                    # verifies read-only mode exposes zero write tools, all tools
                    # carry annotations, the confirm gate fires before network I/O,
                    # and the token never leaks into error output
```

Project layout:

```
src/
  index.ts          # entrypoint: config check, McpServer + stdio transport
  config.ts         # env-var config (validated once, cached)
  httpClient.ts     # undici-based client: auth header, custom CA, SSRF guard
  errors.ts         # API error mapping + confirm-gate helper
  shaping.ts        # response projection + pagination notes
  tools/
    annotations.ts  # shared READ_ONLY / WRITE / DESTRUCTIVE annotations
    som.ts …        # one module per API area, registered in tools/index.ts
spec/oas-dc.json    # OpenAPI reference for the Endpoint Central API
```

Contributions should follow the conventions in [AGENTS.md](AGENTS.md) — notably: response shaping for every list tool, `assertConfirmed` + write-gating for every mutating tool, and relative-literal API paths only.
