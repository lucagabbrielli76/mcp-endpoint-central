// Smoke test: drive the built MCP server over real stdio JSON-RPC against an
// unreachable fake host. Verifies MCP plumbing and the security invariants
// (no write surface in read-only mode, annotations everywhere, confirm gate
// before network I/O, no token leakage) — it does not need, and never talks
// to, a real Endpoint Central server.
// Usage: node scripts/smoke-test.mjs [dist/index.js] [--write]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--write");
const serverPath = args[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const writeMode = process.argv.includes("--write");

const child = spawn("node", [serverPath], {
  env: {
    ...process.env,
    ENDPOINT_CENTRAL_BASE_URL: "https://ec-unreachable.invalid:8383",
    ENDPOINT_CENTRAL_API_TOKEN: "fake-token-for-smoke-test",
    ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS: writeMode ? "true" : "false",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 30000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
});
console.log("initialize ok:", init.result.serverInfo);
notify("notifications/initialized", {});

const tools = await rpc("tools/list", {});
const list = tools.result.tools;
console.log(`tools/list: ${list.length} tools (writeMode=${writeMode})`);

const names = list.map((t) => t.name).sort();
console.log(names.join("\n"));

// Annotation audit: every tool must carry annotations with readOnlyHint set.
const missingAnnotations = list.filter(
  (t) => !t.annotations || typeof t.annotations.readOnlyHint !== "boolean"
);
if (missingAnnotations.length) {
  console.error("TOOLS MISSING ANNOTATIONS:", missingAnnotations.map((t) => t.name));
  process.exit(1);
}
const writes = list.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name);
console.log(`write tools exposed: ${writes.length}`, writes);
if (!writeMode && writes.length > 0) {
  console.error("FAIL: write tools exposed in read-only mode");
  process.exit(1);
}

// Call a read tool against the unreachable host — expect a clean isError result.
const call = await rpc("tools/call", { name: "som_summary", arguments: {} });
const res = call.result;
console.log("som_computers/summary call: isError =", res.isError === true);
const text = (res.content?.[0]?.text ?? "").slice(0, 300);
console.log("error text preview:", text);
if (text.includes("fake-token-for-smoke-test")) {
  console.error("FAIL: token leaked into error output");
  process.exit(1);
}

if (writeMode) {
  // Confirm-gate check: calling a write tool without confirm must refuse
  // BEFORE any network activity (unreachable host would produce a different error).
  const w = await rpc("tools/call", {
    name: "som_agent_uninstall",
    arguments: { resourceIds: [1] },
  });
  const wtext = w.result.content?.[0]?.text ?? "";
  console.log("confirm-gate refusal:", w.result.isError === true, "|", wtext.slice(0, 160));
  if (!/confirm/i.test(wtext) || /Could not reach/i.test(wtext)) {
    console.error("FAIL: confirm gate did not fire before network call");
    process.exit(1);
  }
}

child.kill();
console.log("SMOKE TEST PASSED");
