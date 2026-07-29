import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { assertConfirmed } from "../errors.js";
import { toToolResult } from "../shaping.js";
import { WRITE, DESTRUCTIVE } from "./annotations.js";

/**
 * Mutating Patch Management tools: approve/unapprove/decline, patch scans,
 * install/uninstall configurations, and Automatic Patch Deployment (APD)
 * tasks. Every tool in this module changes server state, so the whole module
 * is gated behind ENDPOINT_CENTRAL_ENABLE_WRITE_TOOLS and every handler is
 * confirm-gated via assertConfirmed.
 *
 * Read-only patch endpoints (summary, allpatches, deploymentpolicies, ...)
 * live in src/tools/patch.ts, not here.
 *
 * Note on the spec: /api/1.4/patch/installpatch appears three times in
 * spec/oas-dc.json under "installpatch?api1/?api2/?api3" — that suffix is an
 * OpenAPI dedup artifact, not a real query string. All three variants POST to
 * the same /api/1.4/patch/installpatch path and differ only by request body;
 * they are modeled as three distinct tools below.
 */

const confirmInput = z
  .boolean()
  .optional()
  .describe("Safety gate: must be explicitly set to true to perform this mutating action.");

const patchIdsInput = z
  .array(z.number().int().positive())
  .min(1)
  .describe("Patch IDs to act on (patch_id values from the patch read tools, e.g. patch allpatches).");

const resourceIdsInput = z
  .array(z.number().int().positive())
  .min(1)
  .describe("resource_id values of the target computers (from som_computers_list or patch allsystems).");

type PatchIdsArgs = { patchIds: number[]; confirm?: boolean };

/**
 * Retry settings shared by the install-patch variants. Field names here are
 * already the API's exact body field names, so the object passes through to
 * the request body unchanged.
 */
const retrySettingsInput = z
  .object({
    enableRetrySettings: z
      .boolean()
      .optional()
      .describe("true to redeploy on failed targets (the server enables retries by default; set false to disable)."),
    noOfRetries: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Total number of retries (1-10). Should equal logonStartupMinRetry + refreshMinRetry."),
    logonStartupMinRetry: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe("Number of retries attempted during system logon/startup."),
    refreshMinRetry: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe("Number of retries attempted during the agent refresh cycle."),
  })
  .optional()
  .describe("Retry behavior for targets where deployment fails. Passed through as the API's retrySettings object.");

interface RetrySettingsArgs {
  enableRetrySettings?: boolean;
  noOfRetries?: number;
  logonStartupMinRetry?: number;
  refreshMinRetry?: number;
}

/**
 * Deployment fields shared by all three install-patch variants (spec schema
 * install_Uninstall_Patch). Input names are camelCase; buildInstallBody maps
 * them to the API's exact (mixed-case) body field names.
 */
const installCommonInput = {
  configName: z
    .string()
    .describe('Name for the Install Patch configuration this call creates, e.g. "API install patch 2026-07".'),
  configDescription: z.string().optional().describe("Description for the Install Patch configuration."),
  actionToPerform: z
    .enum(["Deploy", "DeployImmediately", "Draft"])
    .describe(
      "Deploy: deployment starts on each agent's next contact with the server. DeployImmediately: pushed " +
        "instantly without waiting for agent contact. Draft: save the configuration without deploying."
    ),
  deploymentPolicyTemplateId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "template_id of a deployment policy (from the patch deployment-policies read tool). Mandatory when " +
        "deploymentType is 0 (deploy only, the default) or 2; ignored when publishing to the Self Service Portal only."
    ),
  deploymentType: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .describe(
      "0 deploy only (default), 1 publish to the Self Service Portal only (end users trigger installation " +
        "themselves), 2 both deploy and publish."
    ),
  deadlineTime: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Epoch timestamp after which patches are force-deployed to systems still unpatched (max 1 year ahead), " +
        "e.g. 1691393760."
    ),
  expiryTime: z
    .string()
    .optional()
    .describe("Do not apply the configuration after this time. Format: yyyy-MM-dd HH:MM."),
  installAfterTime: z
    .string()
    .optional()
    .describe("Begin installation only after this scheduled time. Format: yyyy-MM-dd HH:MM."),
  forceRebootOption: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional()
    .describe("Force reboot: 0 not configured, 1 within the deployment/reboot window, 2 outside the window."),
  retrySettings: retrySettingsInput,
  confirm: confirmInput,
};

interface InstallCommonArgs {
  configName: string;
  configDescription?: string;
  actionToPerform: "Deploy" | "DeployImmediately" | "Draft";
  deploymentPolicyTemplateId?: number;
  deploymentType?: 0 | 1 | 2;
  deadlineTime?: number;
  expiryTime?: string;
  installAfterTime?: string;
  forceRebootOption?: 0 | 1 | 2;
  retrySettings?: RetrySettingsArgs;
  confirm?: boolean;
}

/**
 * Maps camelCase tool inputs to the API's exact body field names for
 * /api/1.4/patch/installpatch. undefined values are dropped by
 * JSON.stringify in the HTTP client.
 */
function buildInstallBody(args: InstallCommonArgs): Record<string, unknown> {
  return {
    ConfigName: args.configName,
    ConfigDescription: args.configDescription,
    actionToPerform: args.actionToPerform,
    DeploymentPolicyTemplateID: args.deploymentPolicyTemplateId,
    deploymentType: args.deploymentType,
    deadlineTime: args.deadlineTime,
    expirytime: args.expiryTime,
    installaftertime: args.installAfterTime,
    forceRebootOption: args.forceRebootOption,
    retrySettings: args.retrySettings,
  };
}

const apdTaskNameInput = {
  taskName: z.string().describe("Name of the Automatic Patch Deployment (APD) task, as shown in the console."),
  confirm: confirmInput,
};

type ApdTaskNameArgs = { taskName: string; confirm?: boolean };

const apdSettingsInput = z
  .record(z.unknown())
  .optional()
  .describe(
    "Additional APD task settings, merged into the request's settings object. Keys mirror the console's " +
      "Automate Patch Deployment task form (Patch Mgmt -> Automated Patch Deploy): update-type flags as " +
      '"true"/"false" strings (security_update, non_security_update, thirdparty_update, definition_update, ' +
      "servicepack_update, featurepack_update, rollups, optional_updates), application scoping " +
      "(include_os_app_type, os_applications, include_tp_app_type, tp_applications), deployment targets " +
      "(target_type: DOMAIN/REMOTE_OFFICE/CUSTOM_GROUP, target_list), notifications (email, " +
      "failure_notify_enable, report_notify_enable, attachment formats), and scheduling (EXPIRY_TIME, " +
      "delay_deployment_by_approved_time/delay_deployment_by_released_time)."
  );

export function registerPatchActionTools(server: McpServer): void {
  const { enableWriteTools } = loadConfig();
  if (!enableWriteTools) return;

  // ---- Patch approval workflow -------------------------------------------

  server.registerTool(
    "patch_approve",
    {
      title: "Approve patches",
      description:
        "Approves the given patches for deployment across all computers managed by Endpoint Central, making " +
        "them eligible for installation by deployment tasks and APD. Mutating action: requires confirm: true.",
      inputSchema: { patchIds: patchIdsInput, confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: PatchIdsArgs) => {
      assertConfirmed(args.confirm, "Approving patches for deployment");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/approvepatch", {
        patchids: args.patchIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_unapprove",
    {
      title: "Unapprove patches",
      description:
        "Revokes approval for the given patches across all managed computers, so approval-restricted deployment " +
        "tasks will no longer install them. Mutating action: requires confirm: true.",
      inputSchema: { patchIds: patchIdsInput, confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: PatchIdsArgs) => {
      assertConfirmed(args.confirm, "Unapproving patches");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/unapprovepatch", {
        patchids: args.patchIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_decline",
    {
      title: "Decline patches",
      description:
        "Declines the given patches across all managed computers, excluding them from patch deployment and " +
        "compliance reports until they are re-included. Mutating action: requires confirm: true.",
      inputSchema: { patchIds: patchIdsInput, confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: PatchIdsArgs) => {
      assertConfirmed(args.confirm, "Declining patches");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/declinepatch", {
        patchids: args.patchIds,
      });
      return toToolResult(data);
    }
  );

  // ---- Patch scans -------------------------------------------------------

  server.registerTool(
    "patch_scan_computers",
    {
      title: "Scan computers for patches",
      description:
        "Triggers a patch scan on the given computers to refresh their missing/installed patch data. The scan " +
        "runs on the endpoints via their agents. Mutating action: requires confirm: true.",
      inputSchema: { resourceIds: resourceIdsInput, confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: { resourceIds: number[]; confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Initiating a patch scan on the selected computers");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/computers/scan", {
        resourceids: args.resourceIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_scan_all_computers",
    {
      title: "Scan all computers for patches",
      description:
        "Triggers a patch scan on every computer managed by the Endpoint Central server. This queues scan " +
        "activity network-wide. Mutating action: requires confirm: true.",
      inputSchema: { confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: { confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Initiating a patch scan on all managed computers");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/computers/scanall");
      return toToolResult(data);
    }
  );

  // ---- Patch database / binary downloads ---------------------------------

  server.registerTool(
    "patch_db_update",
    {
      title: "Update the patch database",
      description:
        "Initiates a patch database update on the Endpoint Central server, refreshing its catalog of known " +
        "patches and vulnerabilities from ManageEngine. Check progress with patch_db_update_status. " +
        "On-premise only. Mutating action: requires confirm: true.",
      inputSchema: { confirm: confirmInput },
      annotations: WRITE,
    },
    async (args: { confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Initiating a patch database update");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/updatedb");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_download",
    {
      title: "Download patches to the server",
      description:
        "Initiates download of the given patch binaries to the Endpoint Central server so they are staged for " +
        "later deployment. This downloads for all computers and consumes server bandwidth and disk, but does " +
        "not install anything. On-premise only. Mutating action: requires confirm: true.",
      inputSchema: {
        patchIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe("patch_id values of the patches to download (from patch_all_patches_list)."),
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: { patchIds: number[]; confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Initiating a patch download on the server");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/downloadpatch", {
        patchids: args.patchIds,
      });
      return toToolResult(data);
    }
  );

  // ---- Install / uninstall patch configurations --------------------------

  server.registerTool(
    "patch_install_on_all_systems",
    {
      title: "Install specific patches on all systems",
      description:
        "Creates and (unless saved as Draft) deploys an Install Patch configuration that installs the given " +
        "patches on ALL applicable managed systems in the network. Mutating action: requires confirm: true.",
      inputSchema: { patchIds: patchIdsInput, ...installCommonInput },
      annotations: WRITE,
    },
    async (args: InstallCommonArgs & { patchIds: number[] }) => {
      assertConfirmed(args.confirm, "Installing the specified patches on all applicable systems");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/installpatch", {
        ...buildInstallBody(args),
        PatchIDs: args.patchIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_install_on_specific_systems",
    {
      title: "Install specific patches on specific systems",
      description:
        "Creates and (unless saved as Draft) deploys an Install Patch configuration that installs the given " +
        "patches on the given computers only. Mutating action: requires confirm: true.",
      inputSchema: { patchIds: patchIdsInput, resourceIds: resourceIdsInput, ...installCommonInput },
      annotations: WRITE,
    },
    async (args: InstallCommonArgs & { patchIds: number[]; resourceIds: number[] }) => {
      assertConfirmed(args.confirm, "Installing the specified patches on the selected systems");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/installpatch", {
        ...buildInstallBody(args),
        PatchIDs: args.patchIds,
        ResourceIDs: args.resourceIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_install_all_missing_on_systems",
    {
      title: "Install all missing patches on specific systems",
      description:
        "Creates and (unless saved as Draft) deploys an Install Patch configuration that installs ALL missing " +
        "patches detected on the given computers — potentially a large deployment. Mutating action: requires " +
        "confirm: true.",
      inputSchema: {
        resourceIds: resourceIdsInput,
        onlyApproved: z
          .boolean()
          .optional()
          .describe("If true, install only approved missing patches; if false, install all missing patches."),
        ...installCommonInput,
      },
      annotations: WRITE,
    },
    async (args: InstallCommonArgs & { resourceIds: number[]; onlyApproved?: boolean }) => {
      assertConfirmed(args.confirm, "Installing all missing patches on the selected systems");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/installpatch", {
        ...buildInstallBody(args),
        ResourceIDs: args.resourceIds,
        // The API types this as the string "true"/"false", not a boolean.
        isOnlyApproved: args.onlyApproved === undefined ? undefined : String(args.onlyApproved),
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "patch_uninstall",
    {
      title: "Uninstall specific patches on all systems",
      description:
        "Creates and (unless saved as Draft) deploys an Uninstall Patch configuration that removes the given " +
        "patches from all systems where they are installed, reverting those fixes network-wide. Destructive " +
        "action: requires confirm: true.",
      inputSchema: {
        patchIds: patchIdsInput,
        configName: z.string().describe("Name for the Uninstall Patch configuration this call creates."),
        configDescription: z.string().optional().describe("Description for the Uninstall Patch configuration."),
        actionToPerform: z
          .enum(["Deploy", "DeployImmediately", "Draft"])
          .describe(
            "Deploy: deployment starts on each agent's next contact with the server. DeployImmediately: pushed " +
              "instantly without waiting for agent contact. Draft: save the configuration without deploying."
          ),
        deploymentPolicyTemplateId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("template_id of a deployment policy (from the patch deployment-policies read tool)."),
        confirm: confirmInput,
      },
      annotations: DESTRUCTIVE,
    },
    async (args: {
      patchIds: number[];
      configName: string;
      configDescription?: string;
      actionToPerform: "Deploy" | "DeployImmediately" | "Draft";
      deploymentPolicyTemplateId?: number;
      confirm?: boolean;
    }) => {
      assertConfirmed(args.confirm, "Uninstalling the specified patches from all systems");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/uninstallpatch", {
        PatchIDs: args.patchIds,
        ConfigName: args.configName,
        ConfigDescription: args.configDescription,
        actionToPerform: args.actionToPerform,
        // The spec's uninstall example sends this ID as a string, unlike install.
        DeploymentPolicyTemplateID:
          args.deploymentPolicyTemplateId === undefined ? undefined : String(args.deploymentPolicyTemplateId),
      });
      return toToolResult(data);
    }
  );

  // ---- Automatic Patch Deployment (APD) tasks ----------------------------

  server.registerTool(
    "apd_task_create",
    {
      title: "Create APD task",
      description:
        "Creates an Automatic Patch Deployment (APD) task that will continuously deploy matching patches to its " +
        "targets on the configured schedule. Mutating action: requires confirm: true.",
      inputSchema: {
        taskName: z.string().describe("Name for the new APD task (mandatory)."),
        templateName: z
          .string()
          .describe(
            'Name of the deployment template the task uses (mandatory), e.g. "Force reboot excluding servers" ' +
              'or "Deploy any time at the earliest".'
          ),
        platform: z
          .enum(["Windows", "Mac", "Linux"])
          .optional()
          .describe("Target OS platform for the task."),
        settings: apdSettingsInput,
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: {
      taskName: string;
      templateName: string;
      platform?: "Windows" | "Mac" | "Linux";
      settings?: Record<string, unknown>;
      confirm?: boolean;
    }) => {
      assertConfirmed(args.confirm, "Creating an Automatic Patch Deployment task");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/createAPDTask", {
        settings: {
          ...(args.settings ?? {}),
          taskName: args.taskName,
          templateName: args.templateName,
          ...(args.platform === undefined ? {} : { platform: args.platform }),
        },
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "apd_task_modify",
    {
      title: "Modify APD task",
      description:
        "Modifies an existing Automatic Patch Deployment (APD) task, changing how and where it deploys patches " +
        "from its next run onward. Mutating action: requires confirm: true.",
      inputSchema: {
        taskName: z.string().describe("Name of the existing APD task to modify."),
        settings: apdSettingsInput,
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: { taskName: string; settings?: Record<string, unknown>; confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Modifying an Automatic Patch Deployment task");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/modifyAPDTask", {
        taskname: args.taskName,
        settings: args.settings ?? {},
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "apd_task_delete",
    {
      title: "Delete APD task",
      description:
        "Permanently deletes the named Automatic Patch Deployment (APD) task; its scheduled automatic patch " +
        "deployments stop. Destructive action: requires confirm: true.",
      inputSchema: apdTaskNameInput,
      annotations: DESTRUCTIVE,
    },
    async (args: ApdTaskNameArgs) => {
      assertConfirmed(args.confirm, "Deleting an Automatic Patch Deployment task");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/deleteAPDTask", undefined, {
        taskname: args.taskName,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "apd_task_suspend",
    {
      title: "Suspend APD task",
      description:
        "Suspends the named Automatic Patch Deployment (APD) task, pausing its automatic patch deployments until " +
        "it is resumed. Mutating action: requires confirm: true.",
      inputSchema: apdTaskNameInput,
      annotations: WRITE,
    },
    async (args: ApdTaskNameArgs) => {
      assertConfirmed(args.confirm, "Suspending an Automatic Patch Deployment task");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/suspendAPDTask", undefined, {
        taskname: args.taskName,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "apd_task_resume",
    {
      title: "Resume APD task",
      description:
        "Resumes the named suspended Automatic Patch Deployment (APD) task; its automatic patch deployments start " +
        "running again on schedule. Mutating action: requires confirm: true.",
      inputSchema: apdTaskNameInput,
      annotations: WRITE,
    },
    async (args: ApdTaskNameArgs) => {
      assertConfirmed(args.confirm, "Resuming an Automatic Patch Deployment task");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/patch/resumeAPDTask", undefined, {
        taskname: args.taskName,
      });
      return toToolResult(data);
    }
  );
}
