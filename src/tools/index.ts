import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSomTools } from "./som.js";

export function registerAllTools(server: McpServer): void {
  registerSomTools(server);
  // Further modules (patch, inventory, threats, reports, custom fields, DEX, DLP)
  // register here as they're built out, following the pattern in som.ts.
}
