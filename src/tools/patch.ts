import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Read-only tools for the Patch Management module (/api/1.4/patch/*).
 * Write actions (install/uninstall/approve/decline/APD tasks/scan triggers)
 * live in a separate module — nothing here mutates server state.
 */

// ---------------------------------------------------------------------------
// Shared filter inputs (query param value meanings taken from the spec)
// ---------------------------------------------------------------------------

const pageInput = z.number().int().min(1).optional().describe("Page number to retrieve. Default is 1.");

const pageLimitInput = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe("Max records per page (server cap is 1000). Defaults to the server's configured default page size.");

const rawInput = z
  .boolean()
  .optional()
  .describe("Return the full, unprojected record for each row instead of the curated default field set.");

const domainFilterInput = z
  .string()
  .optional()
  .describe("Filter by NetBIOS domain name (domain list is available from the desktop serverproperties API).");

const branchOfficeFilterInput = z
  .string()
  .optional()
  .describe("Filter by remote/branch office name (list available from the desktop serverproperties API).");

const customGroupFilterInput = z
  .string()
  .optional()
  .describe("Filter by custom group (list available from the desktop serverproperties API).");

const platformFilterInput = z
  .enum(["Windows", "Mac", "Linux"])
  .optional()
  .describe("Filter by OS platform: Windows, Mac, or Linux.");

// severityfilter: 0 unrated, 1 low, 2 moderate, 3 important, 4 critical
const severityFilterInput = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .optional()
  .describe(
    "Filter by patch severity: 0 Unrated (no severity assigned), 1 Low (minimal impact), 2 Moderate (average " +
      "impact), 3 Important (significant impact), 4 Critical (high impact or security risk)."
  );
type SeverityFilter = 0 | 1 | 2 | 3 | 4;

// patchstatusfilter: 201 installed, 202 missing
const patchStatusFilterInput = z
  .union([z.literal(201), z.literal(202)])
  .optional()
  .describe("Filter by patch install status: 201 Installed (already installed), 202 Missing (not installed).");
type PatchStatusFilter = 201 | 202;

// approvalstatusfilter: 211 approved, 0 not approved (pending), 212 declined
const approvalStatusFilterInput = z
  .union([z.literal(0), z.literal(211), z.literal(212)])
  .optional()
  .describe(
    "Filter by approval status: 211 Approved (approved for deployment), 0 Not Approved (approval pending), " +
      "212 Declined."
  );
type ApprovalStatusFilter = 0 | 211 | 212;

// healthfilter: 0 unknown, 1 healthy, 2 vulnerable, 3 highly vulnerable
const healthFilterInput = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .optional()
  .describe(
    "Filter by system patch health: 0 Unknown (patch status not available), 1 Healthy (up-to-date), 2 Vulnerable " +
      "(has missing patches), 3 Highly Vulnerable (has critical or high-risk missing patches)."
  );
type HealthFilter = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// patch_summary
// ---------------------------------------------------------------------------

interface PatchSummaryResponse {
  message_response: { summary: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// patch_all_patches_list
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/allpatches records. Raw rows
 * carry extra i18n/image/DB-join noise; `raw: true` still exposes everything.
 * severity: 0 unrated..4 critical; status_id: 211 approved/212 declined/0 not
 * approved; download_status: 221 downloaded; patch_noreboot: 1 = no reboot
 * required; patch_uninstall_status: 1 = uninstall supported.
 */
const ALL_PATCHES_FIELDS = [
  "patch_id",
  "patch_name",
  "patch_description",
  "bulletin_id",
  "update_name",
  "platform_name",
  "vendor_name",
  "severity",
  "severity_name",
  "status_id",
  "label",
  "installed",
  "missing",
  "failed",
  "download_status",
  "patch_size",
  "patch_released_time",
  "patch_noreboot",
  "patch_uninstall_status",
  "superceded_by",
] as const;

const allPatchesInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  patchId: z.number().int().positive().optional().describe("Filter to the patch with this patch_id."),
  bulletinId: z.string().optional().describe("Filter to patches with this bulletin ID, e.g. MS18-JAN9 or TU-058."),
  patchStatusFilter: patchStatusFilterInput,
  approvalStatusFilter: approvalStatusFilterInput,
  severityFilter: severityFilterInput,
  platformFilter: platformFilterInput,
  domainFilter: domainFilterInput,
  branchOfficeFilter: branchOfficeFilterInput,
  customGroupFilter: customGroupFilterInput,
  raw: rawInput,
};

type AllPatchesArgs = {
  page?: number;
  pageLimit?: number;
  patchId?: number;
  bulletinId?: string;
  patchStatusFilter?: PatchStatusFilter;
  approvalStatusFilter?: ApprovalStatusFilter;
  severityFilter?: SeverityFilter;
  platformFilter?: "Windows" | "Mac" | "Linux";
  domainFilter?: string;
  branchOfficeFilter?: string;
  customGroupFilter?: string;
  raw?: boolean;
};

interface AllPatchesResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    allpatches?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_all_patch_details
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/allpatchdetails records (one row
 * per applicable computer for the given patch). Dotted names ("resource.name")
 * are the API's own DB-join field names, not nested objects.
 */
const ALL_PATCH_DETAILS_FIELDS = [
  "resource_id",
  "resource.name",
  "resource.domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "os_name",
  "service_pack",
  "agent_version",
  "patch_id",
  "patch_name",
  "bulletin_id",
  "patch_description",
  "severity",
  "pmseverity.name",
  "patch_status",
  "affectedpatchstatusdefn.label",
  "deployment_status",
  "deploy_remarks",
  "installed_time",
] as const;

const allPatchDetailsInput = {
  patchId: z
    .number()
    .int()
    .positive()
    .describe("patch_id of the patch to report on (required; from patch_all_patches_list or patch_supported_patches_list)."),
  page: pageInput,
  pageLimit: pageLimitInput,
  patchStatusFilter: patchStatusFilterInput,
  severityFilter: severityFilterInput,
  platformFilter: platformFilterInput,
  domainFilter: domainFilterInput,
  branchOfficeFilter: branchOfficeFilterInput,
  customGroupFilter: customGroupFilterInput,
  raw: rawInput,
};

type AllPatchDetailsArgs = {
  patchId: number;
  page?: number;
  pageLimit?: number;
  patchStatusFilter?: PatchStatusFilter;
  severityFilter?: SeverityFilter;
  platformFilter?: "Windows" | "Mac" | "Linux";
  domainFilter?: string;
  branchOfficeFilter?: string;
  customGroupFilter?: string;
  raw?: boolean;
};

interface AllPatchDetailsResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    allpatchdetails?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_all_systems_list
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/allsystems records.
 * resource_health_status: 0 unknown, 1 healthy, 2 vulnerable, 3 highly
 * vulnerable; scan_status: 226 failed, 227 in progress, 228 success, 229 not
 * scanned; computer_live_status: 1 live, 2 down.
 */
const ALL_SYSTEMS_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "os_name",
  "os_platform_name",
  "resource_health_status",
  "scan_status",
  "scan_remarks",
  "computer_live_status",
  "agent_last_contact_time",
  "last_successful_scan",
  "last_patched_time",
  "missing_ms_patches",
  "missing_tp_patches",
  "total_ms_patches",
  "total_tp_patches",
  "critical_patch_count",
  "important_patch_count",
  "moderate_patch_count",
  "low_patch_count",
] as const;

const allSystemsInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  resId: z.number().int().positive().optional().describe("Filter to the system with this resource_id."),
  healthFilter: healthFilterInput,
  platformFilter: platformFilterInput,
  domainFilter: domainFilterInput,
  branchOfficeFilter: branchOfficeFilterInput,
  customGroupFilter: customGroupFilterInput,
  raw: rawInput,
};

type AllSystemsArgs = {
  page?: number;
  pageLimit?: number;
  resId?: number;
  healthFilter?: HealthFilter;
  platformFilter?: "Windows" | "Mac" | "Linux";
  domainFilter?: string;
  branchOfficeFilter?: string;
  customGroupFilter?: string;
  raw?: boolean;
};

interface AllSystemsResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    allsystems?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_approval_settings / patch_db_update_status / patch_health_policy
// ---------------------------------------------------------------------------

interface ApprovalSettingsResponse {
  message_response: { approvalsettings: Record<string, unknown> };
}

interface DbUpdateStatusResponse {
  message_response: { dbupdatestatus: Record<string, unknown> };
}

interface HealthPolicyResponse {
  message_response: { healthpolicy: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// patch_deployment_policies_list
// ---------------------------------------------------------------------------

/** Default projected fields for /api/1.4/patch/deploymentpolicies records. */
const DEPLOYMENT_POLICY_FIELDS = [
  "template_id",
  "template_name",
  "is_template_alive",
  "set_as_default",
  "creation_time",
  "modified_time",
  "first_name",
  "modifieduser.first_name",
  "user_id",
] as const;

interface DeploymentPoliciesResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    deploymentpolicies?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_downloaded_patches_list
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/downloadedpatches records.
 * download_status: 221 downloaded.
 */
const DOWNLOADED_PATCHES_FIELDS = [
  "patch_id",
  "patch_name",
  "patch_description",
  "bulletin_id",
  "platform_name",
  "patch_size",
  "download_status",
  "patch_download_status_label",
  "download_time",
  "download_remarks",
  "patch_released_time",
  "patch_supported_time",
  "superceded_by",
] as const;

interface DownloadedPatchesResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    downloadedpatches?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_scan_details
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/scandetails records. Dotted
 * names are the API's own DB-join field names. scan_status: 226 failed,
 * 227 in progress, 228 success, 229 not scanned; installation_status:
 * 21 agent not installed, 22 agent installed.
 */
const SCAN_DETAILS_FIELDS = [
  "resource_id",
  "resource.name",
  "resource.domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "os_name",
  "os_platform_name",
  "service_pack",
  "resource_health_status",
  "installation_status",
  "computer_live_status",
  "agent_version",
  "scan_status",
  "scan_remarks",
  "patchstatusdefn.label",
  "last_scan_time",
  "last_successful_scan",
  "agentcontact.last_contact_time",
  "owner",
] as const;

const scanDetailsInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  resId: z.number().int().positive().optional().describe("Filter to the system with this resource_id."),
  healthFilter: healthFilterInput,
  agentInstallationStatusFilter: z
    .union([z.literal(21), z.literal(22)])
    .optional()
    .describe("Filter by agent installation status: 21 Not Installed, 22 Installed."),
  liveStatusFilter: z
    .union([z.literal(1), z.literal(2)])
    .optional()
    .describe("Filter by agent live status: 1 Agent Live (running), 2 Agent Down (not responding)."),
  platformFilter: platformFilterInput,
  domainFilter: domainFilterInput,
  branchOfficeFilter: branchOfficeFilterInput,
  customGroupFilter: customGroupFilterInput,
  raw: rawInput,
};

type ScanDetailsArgs = {
  page?: number;
  pageLimit?: number;
  resId?: number;
  healthFilter?: HealthFilter;
  agentInstallationStatusFilter?: 21 | 22;
  liveStatusFilter?: 1 | 2;
  platformFilter?: "Windows" | "Mac" | "Linux";
  domainFilter?: string;
  branchOfficeFilter?: string;
  customGroupFilter?: string;
  raw?: boolean;
};

interface ScanDetailsResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    scandetails?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_supported_patches_list
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/supportedpatches records.
 * patch_status: 211 approved, 212 declined; patch_noreboot: 1 = no reboot
 * required; patch_uninstall_status: 1 = uninstall supported.
 */
const SUPPORTED_PATCHES_FIELDS = [
  "patch_id",
  "patch_name",
  "patch_description",
  "bulletin_id",
  "update_name",
  "platform_name",
  "vendor_name",
  "severity",
  "pmseverity.name",
  "patch_status",
  "download_status",
  "patch_size",
  "patch_released_time",
  "patch_supported_time",
  "patch_noreboot",
  "patch_uninstall_status",
  "superceded_by",
] as const;

const supportedPatchesInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  patchId: z.number().int().positive().optional().describe("Filter to the patch with this patch_id."),
  bulletinId: z.string().optional().describe("Filter to patches with this bulletin ID, e.g. MS18-JAN9 or TU-075."),
  approvalStatusFilter: approvalStatusFilterInput,
  severityFilter: severityFilterInput,
  platformFilter: platformFilterInput,
  raw: rawInput,
};

type SupportedPatchesArgs = {
  page?: number;
  pageLimit?: number;
  patchId?: number;
  bulletinId?: string;
  approvalStatusFilter?: ApprovalStatusFilter;
  severityFilter?: SeverityFilter;
  platformFilter?: "Windows" | "Mac" | "Linux";
  raw?: boolean;
};

interface SupportedPatchesResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    supportedpatches?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_system_report
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/systemreport records (one row
 * per patch applicable to the given system). affected_patch_status: 201
 * installed, 202 missing, 206 failed to install; patch_status: 211 approved,
 * 212 declined, 0 not approved.
 */
const SYSTEM_REPORT_FIELDS = [
  "patch_id",
  "patch_name",
  "patch_description",
  "bulletin_id",
  "update_name",
  "platform_name",
  "vendor_name",
  "severity",
  "pmseverity.name",
  "patch_status",
  "affected_patch_status",
  "affectedpatchstatusdefn.label",
  "deployment_status",
  "deploy_remarks",
  "installed_time",
  "collection.collection_name",
  "download_status",
  "patch_noreboot",
  "superceded_by",
  "patch_released_time",
] as const;

const systemReportInput = {
  resId: z
    .number()
    .int()
    .positive()
    .describe("resource_id of the computer to report on (required; from patch_all_systems_list or som_computers_list)."),
  page: pageInput,
  pageLimit: pageLimitInput,
  patchStatusFilter: patchStatusFilterInput,
  approvalStatusFilter: approvalStatusFilterInput,
  severityFilter: severityFilterInput,
  platformFilter: platformFilterInput,
  raw: rawInput,
};

type SystemReportArgs = {
  resId: number;
  page?: number;
  pageLimit?: number;
  patchStatusFilter?: PatchStatusFilter;
  approvalStatusFilter?: ApprovalStatusFilter;
  severityFilter?: SeverityFilter;
  platformFilter?: "Windows" | "Mac" | "Linux";
  raw?: boolean;
};

interface SystemReportResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    systemreport?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// patch_view_config
// ---------------------------------------------------------------------------

/**
 * Default projected fields for /api/1.4/patch/viewconfig records (patch
 * deployment configurations and their execution status). Dotted names are
 * the API's own DB-join field names.
 */
const VIEW_CONFIG_FIELDS = [
  "collection_id",
  "collection.collection_name",
  "configuration.config_id",
  "os_platform_name",
  "statuslabel",
  "collectionstatus.status",
  "collectionstatussummary.total_target_count",
  "collectionstatussummary.success_count",
  "collectionstatussummary.failed_count",
  "collectionstatussummary.yet_to_apply_count",
  "collectionstatussummary.not_applicable_count",
  "collectionstatussummary.retry_inprogress_count",
  "collectionstatussummary.status_count_desc",
  "first_name",
  "collection.modified_time",
] as const;

// The spec's comma-separated value list reads "InProgress Draft,Executed,..."
// — almost certainly a missing comma between InProgress and Draft, so both
// are offered as separate values here.
const CONFIG_STATUS_VALUES = [
  "InProgress",
  "Draft",
  "Executed",
  "Suspended",
  "Deployed",
  "RetryInProgress",
  "Expired",
] as const;

const viewConfigInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  configStatusFilter: z
    .enum(CONFIG_STATUS_VALUES)
    .optional()
    .describe(
      "Filter by configuration execution status: InProgress, Draft, Executed, Suspended, Deployed, " +
        "RetryInProgress, or Expired."
    ),
  domainFilter: domainFilterInput,
  branchOfficeFilter: branchOfficeFilterInput,
  raw: rawInput,
};

type ViewConfigArgs = {
  page?: number;
  pageLimit?: number;
  configStatusFilter?: (typeof CONFIG_STATUS_VALUES)[number];
  domainFilter?: string;
  branchOfficeFilter?: string;
  raw?: boolean;
};

interface ViewConfigResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    viewconfig?: Record<string, unknown>[];
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Fields of /api/1.3/patch/apdTaskListdetails records. */
const APD_TASK_FIELDS = [
  "task_name",
  "task_id",
  "task_type",
  "os_platform_name",
  "os_platform_id",
  "total_target",
  "collection_id",
  "collection_status",
  "template_id",
  "scheduler_class_id",
  "first_name",
  "user_id",
  "task_creation_time",
  "task_modified_time",
  "remarks",
] as const;

interface ApdTaskListResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    apdtasklistdetails?: Record<string, unknown>[];
  };
}

export function registerPatchTools(server: McpServer): void {
  server.registerTool(
    "patch_summary",
    {
      title: "Patch module summary",
      description:
        "Retrieves the patch module summary: installed/missing/applicable patch counts, missing-patch severity " +
        "breakdown, system health summary, scan summary, APD task summary, and vulnerability DB update status.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<PatchSummaryResponse>("/api/1.4/patch/summary");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "patch_all_patches_list",
    {
      title: "List all applicable patches",
      description:
        "Retrieves the complete list of patches applicable to managed systems, with per-patch installed/missing/" +
        "failed system counts, severity, approval status, and download status. Supports filtering and pagination.",
      inputSchema: allPatchesInput,
      annotations: READ_ONLY,
    },
    async (args: AllPatchesArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<AllPatchesResponse>("/api/1.4/patch/allpatches", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        patchid: args.patchId,
        bulletinid: args.bulletinId,
        patchstatusfilter: args.patchStatusFilter,
        approvalstatusfilter: args.approvalStatusFilter,
        severityfilter: args.severityFilter,
        platformfilter: args.platformFilter,
        domainfilter: args.domainFilter,
        branchofficefilter: args.branchOfficeFilter,
        customgroupfilter: args.customGroupFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.allpatches ?? [];
      const shaped = args.raw ? records : projectList(records, ALL_PATCHES_FIELDS);
      return toToolResult({ total, page, limit, patches: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_all_patch_details",
    {
      title: "Per-computer status of one patch",
      description:
        "Retrieves the installation status of a specific patch (by patch_id) on every applicable computer: which " +
        "systems have it installed, which are missing it, and deployment remarks. Supports filtering and pagination.",
      inputSchema: allPatchDetailsInput,
      annotations: READ_ONLY,
    },
    async (args: AllPatchDetailsArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<AllPatchDetailsResponse>("/api/1.4/patch/allpatchdetails", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        patchid: args.patchId,
        patchstatusfilter: args.patchStatusFilter,
        severityfilter: args.severityFilter,
        platformfilter: args.platformFilter,
        domainfilter: args.domainFilter,
        branchofficefilter: args.branchOfficeFilter,
        customgroupfilter: args.customGroupFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.allpatchdetails ?? [];
      const shaped = args.raw ? records : projectList(records, ALL_PATCH_DETAILS_FIELDS);
      return toToolResult({ total, page, limit, patchDetails: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_all_systems_list",
    {
      title: "List systems with patch health",
      description:
        "Retrieves all managed systems with their patch health status (healthy/vulnerable/highly vulnerable), " +
        "missing and installed patch counts by type and severity, and last scan/patch times. Supports filtering " +
        "and pagination.",
      inputSchema: allSystemsInput,
      annotations: READ_ONLY,
    },
    async (args: AllSystemsArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<AllSystemsResponse>("/api/1.4/patch/allsystems", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        resid: args.resId,
        healthfilter: args.healthFilter,
        platformfilter: args.platformFilter,
        domainfilter: args.domainFilter,
        branchofficefilter: args.branchOfficeFilter,
        customgroupfilter: args.customGroupFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.allsystems ?? [];
      const shaped = args.raw ? records : projectList(records, ALL_SYSTEMS_FIELDS);
      return toToolResult({ total, page, limit, systems: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_approval_settings",
    {
      title: "Patch approval settings",
      description:
        "Retrieves the current patch approval settings — whether newly supported patches are approved " +
        "automatically or require manual approval.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<ApprovalSettingsResponse>("/api/1.4/patch/approvalsettings");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "patch_db_update_status",
    {
      title: "Patch DB update status",
      description:
        "Retrieves the status of the ongoing or most recent vulnerability/patch database update: last update " +
        "status and time, next scheduled update, and whether automatic DB updates are disabled.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<DbUpdateStatusResponse>("/api/1.4/patch/dbupdatestatus");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "patch_deployment_policies_list",
    {
      title: "List patch deployment policies",
      description:
        "Retrieves all patch deployment policies (deployment templates) configured in Endpoint Central, with " +
        "their IDs, names, default flag, and creation/modification metadata. Supports pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: { page?: number; pageLimit?: number; raw?: boolean }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DeploymentPoliciesResponse>("/api/1.4/patch/deploymentpolicies", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.deploymentpolicies ?? [];
      const shaped = args.raw ? records : projectList(records, DEPLOYMENT_POLICY_FIELDS);
      return toToolResult({ total, page, limit, deploymentPolicies: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_downloaded_patches_list",
    {
      title: "List downloaded patches",
      description:
        "Retrieves the details of all patch binaries downloaded to the Endpoint Central server, including " +
        "download status, time, size, and remarks. Supports pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: { page?: number; pageLimit?: number; raw?: boolean }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DownloadedPatchesResponse>("/api/1.4/patch/downloadedpatches", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.downloadedpatches ?? [];
      const shaped = args.raw ? records : projectList(records, DOWNLOADED_PATCHES_FIELDS);
      return toToolResult({ total, page, limit, downloadedPatches: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_health_policy",
    {
      title: "System health policy",
      description:
        "Retrieves the configured system health policy: the missing-patch count thresholds per severity that " +
        "classify a system as vulnerable or highly vulnerable, plus advanced settings (exclude third-party apps, " +
        "consider only approved patches).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<HealthPolicyResponse>("/api/1.4/patch/healthpolicy");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "patch_scan_details",
    {
      title: "List systems with patch scan status",
      description:
        "Retrieves all systems with their patch scan status (success/failed/in progress/not scanned), scan " +
        "remarks, last scan times, agent details, and patch health. Supports filtering and pagination.",
      inputSchema: scanDetailsInput,
      annotations: READ_ONLY,
    },
    async (args: ScanDetailsArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<ScanDetailsResponse>("/api/1.4/patch/scandetails", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        resid: args.resId,
        healthfilter: args.healthFilter,
        agentinstallationstatusfilter: args.agentInstallationStatusFilter,
        livestatusfilter: args.liveStatusFilter,
        platformfilter: args.platformFilter,
        domainfilter: args.domainFilter,
        branchofficefilter: args.branchOfficeFilter,
        customgroupfilter: args.customGroupFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.scandetails ?? [];
      const shaped = args.raw ? records : projectList(records, SCAN_DETAILS_FIELDS);
      return toToolResult({ total, page, limit, scanDetails: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_supported_patches_list",
    {
      title: "List supported patches",
      description:
        "Retrieves the catalog of all patches supported and manageable by Endpoint Central (not just those " +
        "applicable to current systems), with severity, approval status, and download status. Supports filtering " +
        "and pagination.",
      inputSchema: supportedPatchesInput,
      annotations: READ_ONLY,
    },
    async (args: SupportedPatchesArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<SupportedPatchesResponse>("/api/1.4/patch/supportedpatches", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        patchid: args.patchId,
        bulletinid: args.bulletinId,
        approvalstatusfilter: args.approvalStatusFilter,
        severityfilter: args.severityFilter,
        platformfilter: args.platformFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.supportedpatches ?? [];
      const shaped = args.raw ? records : projectList(records, SUPPORTED_PATCHES_FIELDS);
      return toToolResult({ total, page, limit, supportedPatches: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_system_report",
    {
      title: "Patch report for one system",
      description:
        "Retrieves every patch applicable to a specific computer (by resource_id) with its install status " +
        "(installed/missing/failed), approval status, severity, deployment remarks, and install time. Supports " +
        "filtering and pagination.",
      inputSchema: systemReportInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<SystemReportResponse>("/api/1.4/patch/systemreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        resid: args.resId,
        patchstatusfilter: args.patchStatusFilter,
        approvalstatusfilter: args.approvalStatusFilter,
        severityfilter: args.severityFilter,
        platformfilter: args.platformFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.systemreport ?? [];
      const shaped = args.raw ? records : projectList(records, SYSTEM_REPORT_FIELDS);
      return toToolResult({ total, page, limit, systemReport: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_view_config",
    {
      title: "List patch deployment configurations",
      description:
        "Retrieves all patch deployment configurations with their execution status and per-target success/" +
        "failure/yet-to-apply counts. Supports filtering by execution status and pagination.",
      inputSchema: viewConfigInput,
      annotations: READ_ONLY,
    },
    async (args: ViewConfigArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<ViewConfigResponse>("/api/1.4/patch/viewconfig", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        configstatusfilter: args.configStatusFilter,
        domainfilter: args.domainFilter,
        branchofficefilter: args.branchOfficeFilter,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.viewconfig ?? [];
      const shaped = args.raw ? records : projectList(records, VIEW_CONFIG_FIELDS);
      return toToolResult({ total, page, limit, configurations: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "patch_apd_tasks_list",
    {
      title: "List Automatic Patch Deployment tasks",
      description:
        "Retrieves all Automatic Patch Deployment (APD) tasks with their task name, ID, platform, target count, " +
        "collection status, creator, and creation/modification times. Use this to discover the task_name values " +
        "required by the APD suspend/resume/delete tools. On-premise only — this endpoint does not exist on " +
        "Endpoint Central Cloud.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: { page?: number; pageLimit?: number; raw?: boolean }) => {
      const { defaultPageLimit } = loadConfig();
      // Note: this operation is served under API version 1.3, not 1.4.
      const data = await httpClient.get<ApdTaskListResponse>("/api/1.3/patch/apdTaskListdetails", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const records = data.message_response.apdtasklistdetails ?? [];
      const shaped = args.raw ? records : projectList(records, APD_TASK_FIELDS);
      return toToolResult({ total, page, limit, apdTasks: shaped }, paginationNote({ total, page, limit }));
    }
  );
}
