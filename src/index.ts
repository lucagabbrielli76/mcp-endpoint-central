#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";

async function main(): Promise<void> {
  try {
    loadConfig();
  } catch (err) {
    console.error(`[mcp-endpoint-central] Startup failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const server = new McpServer({
    name: "endpoint-central",
    version: "0.1.0",
  });

  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp-endpoint-central] Fatal error:", err);
  process.exit(1);
});
