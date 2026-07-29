// Connection doctor: verifies your Endpoint Central configuration end to end
// by driving the real MCP server over stdio, exactly as an MCP client would.
//
// Usage:
//   node --env-file=.env scripts/check-connection.mjs
//   ENDPOINT_CENTRAL_BASE_URL=... ENDPOINT_CENTRAL_API_TOKEN=... node scripts/check-connection.mjs
//
// Never prints the API token.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const serverPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

const missing = ["ENDPOINT_CENTRAL_BASE_URL", "ENDPOINT_CENTRAL_API_TOKEN"].filter(
  (k) => !process.env[k]?.trim()
);
if (missing.length) {
  console.error(`✗ Missing required environment variable(s): ${missing.join(", ")}`);
  console.error("  Copy .env.example to .env, fill it in, then run:");
  console.error("    node --env-file=.env scripts/check-connection.mjs");
  process.exit(1);
}

console.log(`Server:      ${process.env.ENDPOINT_CENTRAL_BASE_URL}`);
console.log(`Token:       set (${process.env.ENDPOINT_CENTRAL_API_TOKEN.length} chars, not shown)`);
console.log(`Custom CA:   ${process.env.ENDPOINT_CENTRAL_CA_CERT_PATH || "not set (using default trust store)"}`);
console.log(
  `Write tools: ${process.env.ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS === "true" ? "ENABLED" : "disabled (read-only)"}\n`
);

const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* ignore non-JSON noise */
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }
    }, 45000);
  });
}

function fail(headline, hints) {
  console.error(`✗ ${headline}`);
  for (const h of hints) console.error(`  • ${h}`);
  child.kill();
  process.exit(1);
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "check-connection", version: "0.0.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  console.log(`✓ MCP server started — ${tools.result.tools.length} tools registered`);

  // Step 1: server_discover needs no auth, so it isolates reachability/TLS
  // from credential problems and reports how the console authenticates.
  const discover = await rpc("tools/call", { name: "server_discover", arguments: {} });
  const discoverText = discover.result?.content?.[0]?.text ?? "";
  if (discover.result?.isError) {
    if (/Could not reach/.test(discoverText)) {
      const tls = /certificate|self-signed|SELF_SIGNED|UNABLE_TO_VERIFY|altname|CERT/i.test(discoverText);
      fail("Could not reach the Endpoint Central server.", [
        tls
          ? "This looks like a TLS trust failure — export your internal CA (PEM) and set ENDPOINT_CENTRAL_CA_CERT_PATH."
          : "Check ENDPOINT_CENTRAL_BASE_URL (scheme, host, port — on-prem defaults to 8383) and firewall rules.",
        `Raw error: ${discoverText.slice(0, 300)}`,
      ]);
    }
    console.log("• Reachability probe (server_discover) did not answer; continuing to the authenticated check.");
  } else {
    console.log("✓ Reached the Endpoint Central server (unauthenticated probe)");
    try {
      const login = JSON.parse(discoverText).login_data ?? {};
      const domains = login.domain_list?.length ? login.domain_list.join(", ") : "none";
      console.log(
        `  Console auth: ${login.is_local_authentication_only ? "local accounts only" : "Active Directory enabled"}` +
          ` | AD domains: ${domains}` +
          (login.default_domain ? ` | default: ${login.default_domain}` : "")
      );
    } catch {
      /* shape varies by build; the probe succeeding is the signal that matters */
    }
  }

  // Step 2: an authenticated call proves the API token itself works.
  const call = await rpc("tools/call", { name: "som_summary", arguments: {} });
  const text = call.result?.content?.[0]?.text ?? "";

  if (!call.result?.isError) {
    console.log("✓ Reached Endpoint Central and authenticated successfully");
    console.log("✓ Sample response from som_summary:\n");
    console.log(text.slice(0, 600));
    console.log("\nConfiguration looks good. Point your MCP client at:");
    console.log(`  node ${serverPath}`);
    child.kill();
    process.exit(0);
  }

  if (/\(401\)/.test(text)) {
    fail("Authentication failed (401) — the server was reached, but rejected the token.", [
      "Regenerate the key: Admin → Integrations → API Key Management (log in as the key's own user).",
      "A key is invalidated by regenerating it, or by deleting the user it belongs to.",
      "If the key was created with an expiry date, check whether that date has passed.",
      "Confirm you copied the whole key, with no leading/trailing whitespace.",
      "MFA is not the problem here: the key is a standalone credential, so no OTP is involved at this step.",
    ]);
  } else if (/\(403\)/.test(text)) {
    fail("Access denied (403) — the token is valid but lacks permission for this module.", [
      "Check the role of the account the key belongs to: Admin → User Administration.",
      "The API has no scopes of its own; the account's RBAC role is the entire permission boundary.",
    ]);
  } else if (/Could not reach/.test(text)) {
    const tls = /certificate|self-signed|SELF_SIGNED|UNABLE_TO_VERIFY|altname|CERT/i.test(text);
    fail("Could not reach the Endpoint Central server.", [
      tls
        ? "This looks like a TLS trust failure — export your internal CA (PEM) and set ENDPOINT_CENTRAL_CA_CERT_PATH."
        : "Check ENDPOINT_CENTRAL_BASE_URL (scheme, host, port — on-prem defaults to 8383) and firewall rules.",
      "Verify from this host: curl -sS -o /dev/null -w '%{http_code}' <base-url>/api/1.4/som/summary",
      `Raw error: ${text.slice(0, 300)}`,
    ]);
  } else {
    fail("The call failed for an unexpected reason.", [text.slice(0, 500)]);
  }
} catch (err) {
  fail(err.message, [
    "The server did not respond. Run `npm run build` first, then retry.",
  ]);
}
