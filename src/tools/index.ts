import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSomTools } from "./som.js";
import { registerInventoryTools } from "./inventory.js";
import { registerPatchTools } from "./patch.js";
import { registerPatchActionTools } from "./patchactions.js";
import { registerThreatsTools } from "./threats.js";
import { registerBitlockerTools } from "./bitlocker.js";
import { registerDcmTools } from "./dcm.js";
import { registerDlpTools } from "./dlp.js";
import { registerReportsTools } from "./reports.js";
import { registerCustomFieldTools } from "./customfields.js";
import { registerDexTools } from "./dex.js";

export function registerAllTools(server: McpServer): void {
  registerSomTools(server);
  registerInventoryTools(server);
  registerPatchTools(server);
  registerPatchActionTools(server);
  registerThreatsTools(server);
  registerBitlockerTools(server);
  registerDcmTools(server);
  registerDlpTools(server);
  registerReportsTools(server);
  registerCustomFieldTools(server);
  registerDexTools(server);
}
