import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Threat & vulnerability read tools (`/dcapi/threats/*`).
 *
 * All ten endpoints are GET-backed reads. Nine use the standard
 * `page`/`pageLimit` query pagination with a `metadata` envelope
 * (`page`, `pageLimit`, `totalRecords`, `totalPages`); the tenth
 * (`detailedinfo/vulnerabilities`) is the bulk-export API and paginates with
 * an opaque base64 `cursor` in the request body plus an
 * `isNextPageAvailable` flag in `metadata` — see the note on
 * `threats_vulnerability_computers_detail` below.
 *
 * Timestamps throughout this API family are epoch milliseconds serialized as
 * strings; severity/status filters are free strings in the spec (documented
 * known values are listed per field), except where the spec gives an explicit
 * closed "Applicable inputs" list, which is modeled as z.enum.
 */

/**
 * The `metadata` envelope shared by the page/pageLimit-based threats
 * endpoints. `totalRecords` arrives as a string in the spec's examples
 * ("2"), so normalize before delegating to paginationNote.
 */
interface ThreatsPageMetadata {
  page?: number;
  pageLimit?: number;
  totalRecords?: number | string;
  totalPages?: number;
}

function threatsPaginationNote(metadata: ThreatsPageMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  const totalRaw = metadata.totalRecords === undefined ? undefined : Number(metadata.totalRecords);
  return paginationNote({
    total: totalRaw !== undefined && Number.isFinite(totalRaw) ? totalRaw : undefined,
    page: metadata.page,
    limit: metadata.pageLimit,
  });
}

// --- Shared zod field builders -------------------------------------------

const pageField = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe("Page number to retrieve. Default is 1.");

function pageLimitField(max: number, extra = ""): z.ZodOptional<z.ZodNumber> {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Max records per page (server cap for this endpoint is ${max}).${extra}`);
}

const rawField = z
  .boolean()
  .optional()
  .describe("Return the full, unprojected record for each entry instead of the curated default field set.");

const epochMsDescribe = (what: string) => `Filter by ${what}, as epoch milliseconds (e.g. "1704363395117").`;

// Spec: "(Applicable inputs: Security Updates, Non-Security Updates, ...)"
const UPDATE_TYPE_VALUES = [
  "Security Updates",
  "Non-Security Updates",
  "Third-Party Updates",
  "Definition Update",
  "Service Packs",
  "Feature Packs",
  "Rollups",
  "Tools",
  "Driver",
  "Optional Updates",
  "Preview Rollups",
  "BIOS",
] as const;

// Spec: "(Applicable inputs: required, not required, autoreboot, may require)"
const REBOOT_REQUIRED_VALUES = ["required", "not required", "autoreboot", "may require"] as const;

// Spec (systemreport/patches): "(Applicable inputs: Missing, Failed, Installed)"
const PATCH_STATUS_VALUES = ["Missing", "Failed", "Installed"] as const;

// Spec (systemreport/patches): "(Applicable inputs: Approved, Unapproved)"
const PATCH_APPROVAL_STATUS_VALUES = ["Approved", "Unapproved"] as const;

// --- threats_vulnerabilities_list ----------------------------------------

const VULNERABILITY_FIELDS = [
  "vulnerabilityid",
  "vulnerabilityname",
  "severity",
  "cveids",
  "cvss_2_0_score",
  "cvss_3_0_score",
  "os_platform",
  "exploit_status",
  "affected_systems",
  "patch_availability",
  "patchid",
  "solution",
  "reboot_required",
  "publishedtime",
  "updatedtime",
] as const;

const vulnerabilitiesListInput = {
  page: pageField,
  pageLimit: pageLimitField(1000),
  severity: z
    .string()
    .optional()
    .describe(
      "Filter by vulnerability severity. Known values: Critical, Important, Moderate, Low (the spec models this as a free string, not a closed enum)."
    ),
  vulnerabilityId: z
    .string()
    .optional()
    .describe("Filter by vulnerability ID — a numeric ID or comma-separated list, e.g. \"24480\" or \"24480,25109\"."),
  vulnerabilityName: z.string().optional().describe("Filter to vulnerabilities whose name contains this text."),
  cveIds: z.string().optional().describe("Filter by CVE ID, e.g. \"CVE-2019-0981\"."),
  cvss2Score: z.number().optional().describe("Filter by CVSS 2.0 score (numeric)."),
  cvss3Score: z.number().optional().describe("Filter by CVSS 3.0 score (numeric)."),
  osPlatform: z.string().optional().describe("Filter by OS platform name, e.g. Windows, Mac, Linux."),
  exploitStatus: z
    .string()
    .optional()
    .describe('Filter by public exploit status. Known values: "available", "not available".'),
  patchAvailability: z
    .string()
    .optional()
    .describe('Filter by whether a fixing patch exists. Known values: "available", "not available".'),
  patchId: z.string().optional().describe("Filter by fixing patch ID — numeric ID or comma-separated list."),
  solution: z.string().optional().describe("Filter by the solution/fix text (e.g. a patch file name)."),
  rebootRequired: z
    .string()
    .optional()
    .describe('Filter by reboot behavior of the fix. Known values: "required", "not required", "autoreboot", "may require".'),
  publishedTime: z.string().optional().describe(epochMsDescribe("the vulnerability's published time")),
  updatedTime: z.string().optional().describe(epochMsDescribe("the vulnerability's last-updated time")),
  supportedTime: z.string().optional().describe(epochMsDescribe("the time support/detection for the vulnerability was added")),
  raw: rawField,
};

type VulnerabilitiesListArgs = {
  page?: number;
  pageLimit?: number;
  severity?: string;
  vulnerabilityId?: string;
  vulnerabilityName?: string;
  cveIds?: string;
  cvss2Score?: number;
  cvss3Score?: number;
  osPlatform?: string;
  exploitStatus?: string;
  patchAvailability?: string;
  patchId?: string;
  solution?: string;
  rebootRequired?: string;
  publishedTime?: string;
  updatedTime?: string;
  supportedTime?: string;
  raw?: boolean;
};

interface VulnerabilitiesResponse {
  metadata?: ThreatsPageMetadata;
  message_response?: { vulnerabilities?: Record<string, unknown>[] };
}

// --- threats_vulnerability_computers_detail ------------------------------

const VULN_COMPUTER_DETAIL_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "ip_address",
  "vulnerabilityid",
  "vulnerabilityname",
  "severity",
  "vulnerability_status",
  "cveids",
  "cvss_2_score",
  "cvss_3_score",
  "exploitscount",
  "patchid",
  "patch_description",
  "updatedtime",
] as const;

const vulnComputersDetailInput = {
  pageLimit: pageLimitField(
    10000,
    " The server default for this bulk endpoint is 5000; this tool defaults to the configured page limit to keep responses readable."
  ),
  page: pageField,
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque base64 cursor returned in the previous call's metadata. Omit on the first call; pass the returned cursor unchanged to fetch the next batch."
    ),
  updatedTime: z
    .string()
    .optional()
    .describe(
      "Epoch milliseconds; only vulnerability-computer records updated after this time are returned. Useful for incremental syncs."
    ),
  raw: rawField,
};

type VulnComputersDetailArgs = {
  pageLimit?: number;
  page?: number;
  cursor?: string;
  updatedTime?: string;
  raw?: boolean;
};

interface VulnComputersDetailResponse {
  metadata?: {
    cursor?: string;
    pageLimit?: number;
    totalRecords?: number | string;
    isNextPageAvailable?: boolean;
  };
  message_response?: { data?: Record<string, unknown>[] };
}

// --- threats_patches_list ------------------------------------------------

const THREAT_PATCH_FIELDS = [
  "patchid",
  "patchname",
  "severity",
  "update_type",
  "patch_description",
  "kb_number",
  "bulletinid",
  "vendor_name",
  "platform_name",
  "patch_status",
  "download_status",
  "reboot_required",
  "patch_released_time",
  "missing_system_count",
  "installed_system_count",
  "failed_system_count",
] as const;

const threatsPatchesListInput = {
  page: pageField,
  pageLimit: pageLimitField(1000),
  patchId: z.string().optional().describe("Filter by patch ID — numeric ID or comma-separated list."),
  patchName: z.string().optional().describe("Filter to patches whose name contains this text."),
  severity: z
    .string()
    .optional()
    .describe(
      "Filter by patch severity. Known values: Critical, Important, Moderate, Low, Unrated (free string in the spec)."
    ),
  updateType: z
    .enum(UPDATE_TYPE_VALUES)
    .optional()
    .describe("Filter by the type of patch (the spec's closed 'Applicable inputs' list)."),
  patchDescription: z.string().optional().describe("Filter to patches whose description contains this text."),
  kbNumber: z.string().optional().describe("Filter by Microsoft KB number (digits only, e.g. \"2565063\")."),
  vendorName: z.string().optional().describe("Filter by vendor name, e.g. Microsoft, Adobe."),
  platformName: z.string().optional().describe("Filter by platform, e.g. Windows, Mac, Linux."),
  downloadStatus: z.string().optional().describe("Filter by the patch binary's download status on the server."),
  patchStatus: z
    .string()
    .optional()
    .describe('Filter by patch status. Example value from the spec: "approved" (free string, no closed list documented).'),
  patchUninstall: z
    .string()
    .optional()
    .describe('Filter by vendor uninstall support. Known values: "supported", "not supported".'),
  rebootRequired: z
    .enum(REBOOT_REQUIRED_VALUES)
    .optional()
    .describe("Filter by the post-deployment reboot option configured for the patch."),
  approvedUserFirstName: z
    .string()
    .optional()
    .describe(
      "Filter by the first name of the user who approved the patch (the spec's own description for this parameter is a mislabeled copy of reboot_required)."
    ),
  cveIds: z.string().optional().describe("Filter by CVE ID, e.g. \"CVE-2019-0981\"."),
  updatedTime: z.string().optional().describe(epochMsDescribe("the patch's approved/updated time")),
  patchReleasedTime: z.string().optional().describe(epochMsDescribe("the patch's release date")),
  patchSupportedTime: z.string().optional().describe(epochMsDescribe("the patch's support date")),
  patchSize: z.string().optional().describe("Filter by patch size in bytes (digits only)."),
  raw: rawField,
};

type ThreatsPatchesListArgs = {
  page?: number;
  pageLimit?: number;
  patchId?: string;
  patchName?: string;
  severity?: string;
  updateType?: (typeof UPDATE_TYPE_VALUES)[number];
  patchDescription?: string;
  kbNumber?: string;
  vendorName?: string;
  platformName?: string;
  downloadStatus?: string;
  patchStatus?: string;
  patchUninstall?: string;
  rebootRequired?: (typeof REBOOT_REQUIRED_VALUES)[number];
  approvedUserFirstName?: string;
  cveIds?: string;
  updatedTime?: string;
  patchReleasedTime?: string;
  patchSupportedTime?: string;
  patchSize?: string;
  raw?: boolean;
};

interface ThreatsPatchesResponse {
  metadata?: ThreatsPageMetadata;
  message_response?: { patches?: Record<string, unknown>[] };
}

// --- threats_server_misconfigurations_list -------------------------------

const SERVER_MISCONFIG_FIELDS = [
  "hardeningid",
  "hardeningname",
  "category",
  "severity",
  "os_platform_name",
  "affected_systems",
  "description",
  "resolution",
  "published_time",
  "updated_time",
] as const;

const serverMisconfigListInput = {
  page: pageField,
  pageLimit: pageLimitField(1000),
  severity: z
    .string()
    .optional()
    .describe(
      "Filter by severity. Known values: Critical, Important, Moderate, Low, Info (free string in the spec)."
    ),
  osPlatformName: z.string().optional().describe("Filter by platform, e.g. Windows, Mac, Linux."),
  hardeningId: z.string().optional().describe("Filter by hardening ID — numeric ID or comma-separated list."),
  hardeningName: z.string().optional().describe("Filter to misconfigurations whose hardening name contains this text."),
  category: z.string().optional().describe('Filter by category, e.g. "Session hijacking", "Default Contents".'),
  description: z.string().optional().describe("Filter to misconfigurations whose description contains this text."),
  resolution: z.string().optional().describe("Filter to misconfigurations whose resolution text contains this text."),
  publishedTime: z.string().optional().describe(epochMsDescribe("the misconfiguration's published time")),
  updatedTime: z.string().optional().describe(epochMsDescribe("the misconfiguration's last-updated time")),
  raw: rawField,
};

type ServerMisconfigListArgs = {
  page?: number;
  pageLimit?: number;
  severity?: string;
  osPlatformName?: string;
  hardeningId?: string;
  hardeningName?: string;
  category?: string;
  description?: string;
  resolution?: string;
  publishedTime?: string;
  updatedTime?: string;
  raw?: boolean;
};

interface ServerMisconfigResponse {
  metadata?: ThreatsPageMetadata;
  message_response?: { servermisconfigurations?: Record<string, unknown>[] };
}

// --- threats_system_misconfigurations_list -------------------------------

const SYSTEM_MISCONFIG_FIELDS = [
  "misconfigid",
  "misconfig_name",
  "category",
  "severity",
  "os_platform",
  "affected_systems",
  "fix_availability",
  "solution",
  "reboot_required",
  "post_deployment_issues",
  "undo_supported",
  "potential_impact",
  "description",
] as const;

const systemMisconfigListInput = {
  page: pageField,
  pageLimit: pageLimitField(1000),
  severity: z
    .string()
    .optional()
    .describe(
      "Filter by severity. Known values: Critical, Important, Moderate, Low, Info (free string in the spec)."
    ),
  osPlatform: z.string().optional().describe("Filter by platform, e.g. Windows, Mac, Linux."),
  fixAvailability: z
    .string()
    .optional()
    .describe('Filter by fix availability. Known values: "available", "not available".'),
  misconfigId: z.string().optional().describe("Filter by misconfiguration ID — numeric ID or comma-separated list."),
  misconfigName: z.string().optional().describe("Filter to misconfigurations whose name contains this text."),
  category: z.string().optional().describe('Filter by category, e.g. "Windows Firewall", "BitLocker Encryption".'),
  description: z.string().optional().describe("Filter to misconfigurations whose description contains this text."),
  solution: z.string().optional().describe("Filter by the documented solution text."),
  rebootRequired: z
    .string()
    .optional()
    .describe('Filter by reboot option. Known values: "required", "not required", "autoreboot", "may require".'),
  postDeploymentIssues: z
    .string()
    .optional()
    .describe('Filter by known post-deployment impact of fixing, e.g. "No Impact".'),
  undoSupported: z
    .boolean()
    .optional()
    .describe("Filter by whether the fix is reversible (true) or not (false)."),
  potentialImpact: z
    .boolean()
    .optional()
    .describe("Filter by whether fixing the misconfiguration carries a potential impact flag."),
  raw: rawField,
};

type SystemMisconfigListArgs = {
  page?: number;
  pageLimit?: number;
  severity?: string;
  osPlatform?: string;
  fixAvailability?: string;
  misconfigId?: string;
  misconfigName?: string;
  category?: string;
  description?: string;
  solution?: string;
  rebootRequired?: string;
  postDeploymentIssues?: string;
  undoSupported?: boolean;
  potentialImpact?: boolean;
  raw?: boolean;
};

interface SystemMisconfigResponse {
  metadata?: ThreatsPageMetadata;
  message_response?: { systemmisconfigurations?: Record<string, unknown>[] };
}

// --- systemreport family --------------------------------------------------

/**
 * Every /dcapi/threats/systemreport* endpoint returns
 * message_response.systemreport: an array of per-computer records keyed by
 * resource_id, each embedding the relevant nested arrays (vulnerabilities,
 * patches, servermisconfigurations, systemmisconfigurations). Projection here
 * keeps resource_id plus the endpoint's nested array(s); nested items are the
 * payload and pass through unprojected.
 */
interface SystemReportResponse {
  metadata?: ThreatsPageMetadata;
  message_response?: { systemreport?: Record<string, unknown>[] };
}

const SYSTEM_REPORT_FIELDS = [
  "resource_id",
  "vulnerabilities",
  "patches",
  "servermisconfigurations",
  "systemmisconfigurations",
] as const;

const resourceIdFilterField = z
  .string()
  .optional()
  .describe('Filter by resource ID — a numeric ID or comma-separated list, e.g. "304" or "304,305".');

const systemReportInput = {
  page: pageField,
  pageLimit: pageLimitField(500),
  resourceId: resourceIdFilterField,
  raw: rawField,
};

type SystemReportArgs = { page?: number; pageLimit?: number; resourceId?: string; raw?: boolean };

const systemReportPatchesInput = {
  page: pageField,
  pageLimit: pageLimitField(500),
  resourceId: resourceIdFilterField,
  severity: z
    .string()
    .optional()
    .describe("Filter by patch severity. Known values: Critical, Important, Moderate, Low, Unrated."),
  patchName: z.string().optional().describe("Filter to systems having patches whose name contains this text."),
  updateType: z
    .enum(UPDATE_TYPE_VALUES)
    .optional()
    .describe("Filter by the type of patch (the spec's closed 'Applicable inputs' list)."),
  patchId: z.string().optional().describe("Filter by patch ID — numeric ID or comma-separated list."),
  patchDescription: z.string().optional().describe("Filter to patches whose description contains this text."),
  vendorName: z.string().optional().describe("Filter by vendor name, e.g. Microsoft."),
  installErrorCode: z.string().optional().describe("Filter by the patch installation error code."),
  fqdnName: z.string().optional().describe("Filter by the system's fully qualified domain name."),
  patchReleasedTime: z.string().optional().describe(epochMsDescribe("the patch's release date")),
  installedTime: z.string().optional().describe(epochMsDescribe("the patch installation time")),
  rebootRequired: z
    .enum(REBOOT_REQUIRED_VALUES)
    .optional()
    .describe("Filter by the post-deployment reboot option configured for the patch."),
  platformName: z.string().optional().describe("Filter by platform, e.g. Windows, Mac, Linux."),
  cveIds: z.string().optional().describe("Filter by CVE ID, e.g. \"CVE-2019-0981\"."),
  patchStatus: z
    .enum(PATCH_STATUS_VALUES)
    .optional()
    .describe("Filter by per-system patch status: Missing, Failed, or Installed."),
  patchApprovalStatus: z
    .enum(PATCH_APPROVAL_STATUS_VALUES)
    .optional()
    .describe("Filter by patch approval status: Approved or Unapproved."),
  raw: rawField,
};

type SystemReportPatchesArgs = {
  page?: number;
  pageLimit?: number;
  resourceId?: string;
  severity?: string;
  patchName?: string;
  updateType?: (typeof UPDATE_TYPE_VALUES)[number];
  patchId?: string;
  patchDescription?: string;
  vendorName?: string;
  installErrorCode?: string;
  fqdnName?: string;
  patchReleasedTime?: string;
  installedTime?: string;
  rebootRequired?: (typeof REBOOT_REQUIRED_VALUES)[number];
  platformName?: string;
  cveIds?: string;
  patchStatus?: (typeof PATCH_STATUS_VALUES)[number];
  patchApprovalStatus?: (typeof PATCH_APPROVAL_STATUS_VALUES)[number];
  raw?: boolean;
};

const systemReportServerMisconfigInput = {
  page: pageField,
  pageLimit: pageLimitField(500),
  resourceId: resourceIdFilterField,
  hardeningId: z.string().optional().describe("Filter by hardening ID — numeric ID or comma-separated list."),
  hardeningStatus: z
    .string()
    .optional()
    .describe('Filter by per-system hardening status, e.g. "open".'),
  updatedTime: z.string().optional().describe(epochMsDescribe("the record's last-updated time")),
  raw: rawField,
};

type SystemReportServerMisconfigArgs = {
  page?: number;
  pageLimit?: number;
  resourceId?: string;
  hardeningId?: string;
  hardeningStatus?: string;
  updatedTime?: string;
  raw?: boolean;
};

const systemReportSystemMisconfigInput = {
  page: pageField,
  pageLimit: pageLimitField(500),
  resourceId: resourceIdFilterField,
  misconfigId: z.string().optional().describe("Filter by misconfiguration ID — numeric ID or comma-separated list."),
  misconfigStatus: z
    .string()
    .optional()
    .describe('Filter by per-system misconfiguration status, e.g. "open".'),
  globalGpo: z
    .string()
    .optional()
    .describe('Filter by global GPO state for the misconfiguration, e.g. "applied", "not applied".'),
  updatedTime: z.string().optional().describe(epochMsDescribe("the record's last-updated time")),
  raw: rawField,
};

type SystemReportSystemMisconfigArgs = {
  page?: number;
  pageLimit?: number;
  resourceId?: string;
  misconfigId?: string;
  misconfigStatus?: string;
  globalGpo?: string;
  updatedTime?: string;
  raw?: boolean;
};

const systemReportVulnerabilitiesInput = {
  page: pageField,
  pageLimit: pageLimitField(500),
  resourceId: resourceIdFilterField,
  vulnerabilityId: z.string().optional().describe("Filter by vulnerability ID — numeric ID or comma-separated list."),
  vulnerabilityName: z.string().optional().describe("Filter to vulnerabilities whose name contains this text."),
  severity: z
    .string()
    .optional()
    .describe("Filter by severity. Known values: Critical, Important, Moderate, Low."),
  vulnerabilityStatus: z
    .string()
    .optional()
    .describe('Filter by per-system vulnerability status, e.g. "open".'),
  updatedTime: z.string().optional().describe(epochMsDescribe("the record's last-updated time")),
  raw: rawField,
};

type SystemReportVulnerabilitiesArgs = {
  page?: number;
  pageLimit?: number;
  resourceId?: string;
  vulnerabilityId?: string;
  vulnerabilityName?: string;
  severity?: string;
  vulnerabilityStatus?: string;
  updatedTime?: string;
  raw?: boolean;
};

function shapeSystemReport(
  data: SystemReportResponse,
  raw: boolean | undefined,
  fields: readonly string[]
) {
  const metadata = data.metadata;
  const systems = data.message_response?.systemreport ?? [];
  const shaped = raw ? systems : projectList(systems, fields);
  return toToolResult(
    { total: metadata?.totalRecords, page: metadata?.page, limit: metadata?.pageLimit, systems: shaped },
    threatsPaginationNote(metadata)
  );
}

/** Effective default page size for the systemreport endpoints (server cap 500). */
function systemReportDefaultLimit(): number {
  return Math.min(loadConfig().defaultPageLimit, 500);
}

// --- Registration ---------------------------------------------------------

export function registerThreatsTools(server: McpServer): void {
  server.registerTool(
    "threats_vulnerabilities_list",
    {
      title: "List detected vulnerabilities",
      description:
        "Retrieves the network-wide list of detected vulnerabilities with severity, CVE IDs, CVSS scores, exploit " +
        "status, affected-system counts, and fixing-patch availability. Supports extensive filtering and pagination.",
      inputSchema: vulnerabilitiesListInput,
      annotations: READ_ONLY,
    },
    async (args: VulnerabilitiesListArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<VulnerabilitiesResponse>("/dcapi/threats/vulnerabilities", {
        page: args.page,
        pageLimit: args.pageLimit ?? defaultPageLimit,
        severity: args.severity,
        vulnerabilityid: args.vulnerabilityId,
        vulnerabilityname: args.vulnerabilityName,
        cveids: args.cveIds,
        cvss_2_score: args.cvss2Score,
        cvss_3_score: args.cvss3Score,
        os_platform: args.osPlatform,
        exploit_status: args.exploitStatus,
        patch_availability: args.patchAvailability,
        patchid: args.patchId,
        solution: args.solution,
        reboot_required: args.rebootRequired,
        publishedtime: args.publishedTime,
        updatedtime: args.updatedTime,
        supportedtime: args.supportedTime,
      });
      const metadata = data.metadata;
      const vulnerabilities = data.message_response?.vulnerabilities ?? [];
      const shaped = args.raw ? vulnerabilities : projectList(vulnerabilities, VULNERABILITY_FIELDS);
      return toToolResult(
        { total: metadata?.totalRecords, page: metadata?.page, limit: metadata?.pageLimit, vulnerabilities: shaped },
        threatsPaginationNote(metadata)
      );
    }
  );

  server.registerTool(
    "threats_vulnerability_computers_detail",
    {
      title: "Detailed vulnerability-computer mapping (bulk, cursor-paged)",
      description:
        "Retrieves the detailed vulnerability-to-computer mapping: every record pairs one computer with one " +
        "vulnerability (resource, FQDN, IP, CVEs, CVSS, status). Built for bulk export and paginated by an opaque " +
        "cursor: the first call needs no cursor; if the result says more data is available, call again passing the " +
        "returned cursor. Requires Endpoint Central 11.3.2430.01+; not supported on Endpoint Central MSP.",
      inputSchema: vulnComputersDetailInput,
      annotations: READ_ONLY,
    },
    async (args: VulnComputersDetailArgs) => {
      const { defaultPageLimit } = loadConfig();
      // The spec documents this operation as GET with a required JSON request
      // body carrying the cursor — a shape fetch() cannot send. Per AGENTS.md
      // the cursor travels in a POST body, so this is issued as POST; the
      // operation itself is a pure read (hence READ_ONLY).
      const body: Record<string, string> = {};
      if (args.cursor !== undefined) body.cursor = args.cursor;
      if (args.updatedTime !== undefined) body.updatedTime = args.updatedTime;
      const data = await httpClient.post<VulnComputersDetailResponse>(
        "/dcapi/threats/detailedinfo/vulnerabilities",
        body,
        {
          pageLimit: args.pageLimit ?? defaultPageLimit,
          page: args.page,
        }
      );
      const metadata = data.metadata;
      const records = data.message_response?.data ?? [];
      const shaped = args.raw ? records : projectList(records, VULN_COMPUTER_DETAIL_FIELDS);
      const note =
        metadata?.isNextPageAvailable && metadata.cursor
          ? `Returned ${shaped.length} records (totalRecords: ${metadata.totalRecords ?? "unknown"}). ` +
            `More available — call again with cursor: "${metadata.cursor}" to continue.`
          : `Returned ${shaped.length} records (totalRecords: ${metadata?.totalRecords ?? "unknown"}). ` +
            `No further pages (isNextPageAvailable is not true).`;
      return toToolResult(
        {
          totalRecords: metadata?.totalRecords,
          isNextPageAvailable: metadata?.isNextPageAvailable,
          cursor: metadata?.cursor,
          data: shaped,
        },
        note
      );
    }
  );

  server.registerTool(
    "threats_patches_list",
    {
      title: "List applicable patches (threat view)",
      description:
        "Retrieves all patches applicable to managed systems from the threats module, with severity, KB/bulletin " +
        "IDs, vendor, missing/installed/failed system counts, and approval status. Supports extensive filtering and " +
        "pagination.",
      inputSchema: threatsPatchesListInput,
      annotations: READ_ONLY,
    },
    async (args: ThreatsPatchesListArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<ThreatsPatchesResponse>("/dcapi/threats/patches", {
        page: args.page,
        pageLimit: args.pageLimit ?? defaultPageLimit,
        patchid: args.patchId,
        patchname: args.patchName,
        severity: args.severity,
        update_type: args.updateType,
        patch_description: args.patchDescription,
        kb_number: args.kbNumber,
        vendor_name: args.vendorName,
        platform_name: args.platformName,
        download_status: args.downloadStatus,
        patch_status: args.patchStatus,
        patch_uninstall: args.patchUninstall,
        reboot_required: args.rebootRequired,
        approveduser_first_name: args.approvedUserFirstName,
        cveids: args.cveIds,
        updated_time: args.updatedTime,
        patch_released_time: args.patchReleasedTime,
        patch_supported_time: args.patchSupportedTime,
        patch_size: args.patchSize,
      });
      const metadata = data.metadata;
      const patches = data.message_response?.patches ?? [];
      const shaped = args.raw ? patches : projectList(patches, THREAT_PATCH_FIELDS);
      return toToolResult(
        { total: metadata?.totalRecords, page: metadata?.page, limit: metadata?.pageLimit, patches: shaped },
        threatsPaginationNote(metadata)
      );
    }
  );

  server.registerTool(
    "threats_server_misconfigurations_list",
    {
      title: "List web server misconfigurations",
      description:
        "Retrieves web-server hardening misconfigurations (e.g. Tomcat/IIS/Apache issues) detected across the " +
        "network, with severity, category, affected-system counts, and resolution guidance. Supports filtering and " +
        "pagination.",
      inputSchema: serverMisconfigListInput,
      annotations: READ_ONLY,
    },
    async (args: ServerMisconfigListArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<ServerMisconfigResponse>("/dcapi/threats/servermisconfigurations", {
        page: args.page,
        pageLimit: args.pageLimit ?? defaultPageLimit,
        severity: args.severity,
        os_platform_name: args.osPlatformName,
        hardeningid: args.hardeningId,
        hardeningname: args.hardeningName,
        category: args.category,
        description: args.description,
        resolution: args.resolution,
        published_time: args.publishedTime,
        updated_time: args.updatedTime,
      });
      const metadata = data.metadata;
      const misconfigurations = data.message_response?.servermisconfigurations ?? [];
      const shaped = args.raw ? misconfigurations : projectList(misconfigurations, SERVER_MISCONFIG_FIELDS);
      return toToolResult(
        {
          total: metadata?.totalRecords,
          page: metadata?.page,
          limit: metadata?.pageLimit,
          serverMisconfigurations: shaped,
        },
        threatsPaginationNote(metadata)
      );
    }
  );

  server.registerTool(
    "threats_system_misconfigurations_list",
    {
      title: "List system misconfigurations",
      description:
        "Retrieves OS/system-level misconfigurations (e.g. firewall disabled, BitLocker off) detected across the " +
        "network, with severity, category, fix availability, reversibility, and affected-system counts. Supports " +
        "filtering and pagination.",
      inputSchema: systemMisconfigListInput,
      annotations: READ_ONLY,
    },
    async (args: SystemMisconfigListArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<SystemMisconfigResponse>("/dcapi/threats/systemmisconfigurations", {
        page: args.page,
        pageLimit: args.pageLimit ?? defaultPageLimit,
        severity: args.severity,
        os_platform: args.osPlatform,
        fix_availability: args.fixAvailability,
        misconfigid: args.misconfigId,
        misconfig_name: args.misconfigName,
        category: args.category,
        description: args.description,
        solution: args.solution,
        reboot_required: args.rebootRequired,
        post_deployment_issues: args.postDeploymentIssues,
        undo_supported: args.undoSupported,
        potential_impact: args.potentialImpact,
      });
      const metadata = data.metadata;
      const misconfigurations = data.message_response?.systemmisconfigurations ?? [];
      const shaped = args.raw ? misconfigurations : projectList(misconfigurations, SYSTEM_MISCONFIG_FIELDS);
      return toToolResult(
        {
          total: metadata?.totalRecords,
          page: metadata?.page,
          limit: metadata?.pageLimit,
          systemMisconfigurations: shaped,
        },
        threatsPaginationNote(metadata)
      );
    }
  );

  server.registerTool(
    "threats_system_report",
    {
      title: "Per-system threat report (all threat types)",
      description:
        "Retrieves the combined per-computer threat report: each record is one system (resource_id) with its nested " +
        "vulnerabilities, applicable patches, server misconfigurations, and system misconfigurations. Filter by " +
        "resource ID to inspect specific systems.",
      inputSchema: systemReportInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportArgs) => {
      const data = await httpClient.get<SystemReportResponse>("/dcapi/threats/systemreport", {
        page: args.page,
        pageLimit: args.pageLimit ?? systemReportDefaultLimit(),
        resource_id: args.resourceId,
      });
      return shapeSystemReport(data, args.raw, SYSTEM_REPORT_FIELDS);
    }
  );

  server.registerTool(
    "threats_system_report_patches",
    {
      title: "Per-system patch details",
      description:
        "Retrieves systems with their per-system patch details (status Missing/Failed/Installed, approval status, " +
        "install errors, installed time). Each record is one system (resource_id) with a nested patches array. " +
        "Supports extensive filtering and pagination.",
      inputSchema: systemReportPatchesInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportPatchesArgs) => {
      const data = await httpClient.get<SystemReportResponse>("/dcapi/threats/systemreport/patches", {
        page: args.page,
        pageLimit: args.pageLimit ?? systemReportDefaultLimit(),
        resource_id: args.resourceId,
        severity: args.severity,
        patchname: args.patchName,
        update_type: args.updateType,
        patch_id: args.patchId,
        patch_description: args.patchDescription,
        vendor_name: args.vendorName,
        install_error_code: args.installErrorCode,
        fqdn_name: args.fqdnName,
        patch_released_time: args.patchReleasedTime,
        installed_time: args.installedTime,
        reboot_required: args.rebootRequired,
        platform_name: args.platformName,
        cveids: args.cveIds,
        patch_status: args.patchStatus,
        patch_approval_status: args.patchApprovalStatus,
      });
      return shapeSystemReport(data, args.raw, ["resource_id", "patches"]);
    }
  );

  server.registerTool(
    "threats_system_report_server_misconfigurations",
    {
      title: "Per-system web server misconfiguration details",
      description:
        "Retrieves systems with their per-system web-server misconfiguration instances (hardening ID, status, " +
        "affected file path). Each record is one system (resource_id) with a nested servermisconfigurations array.",
      inputSchema: systemReportServerMisconfigInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportServerMisconfigArgs) => {
      const data = await httpClient.get<SystemReportResponse>(
        "/dcapi/threats/systemreport/servermisconfigurations",
        {
          page: args.page,
          pageLimit: args.pageLimit ?? systemReportDefaultLimit(),
          resource_id: args.resourceId,
          hardeningid: args.hardeningId,
          hardening_status: args.hardeningStatus,
          updatedtime: args.updatedTime,
        }
      );
      return shapeSystemReport(data, args.raw, ["resource_id", "servermisconfigurations"]);
    }
  );

  server.registerTool(
    "threats_system_report_system_misconfigurations",
    {
      title: "Per-system misconfiguration details",
      description:
        "Retrieves systems with their per-system OS misconfiguration instances (misconfiguration ID, status, global " +
        "GPO state). Each record is one system (resource_id) with a nested systemmisconfigurations array.",
      inputSchema: systemReportSystemMisconfigInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportSystemMisconfigArgs) => {
      const data = await httpClient.get<SystemReportResponse>(
        "/dcapi/threats/systemreport/systemmisconfigurations",
        {
          page: args.page,
          pageLimit: args.pageLimit ?? systemReportDefaultLimit(),
          resource_id: args.resourceId,
          misconfigid: args.misconfigId,
          misconfig_status: args.misconfigStatus,
          global_gpo: args.globalGpo,
          updated_time: args.updatedTime,
        }
      );
      return shapeSystemReport(data, args.raw, ["resource_id", "systemmisconfigurations"]);
    }
  );

  server.registerTool(
    "threats_system_report_vulnerabilities",
    {
      title: "Per-system vulnerability details",
      description:
        "Retrieves systems affected by known vulnerabilities. Each record is one system (resource_id) with a nested " +
        "vulnerabilities array (vulnerability ID/name, severity, status, last-updated time). Supports filtering and " +
        "pagination.",
      inputSchema: systemReportVulnerabilitiesInput,
      annotations: READ_ONLY,
    },
    async (args: SystemReportVulnerabilitiesArgs) => {
      const data = await httpClient.get<SystemReportResponse>("/dcapi/threats/systemreport/vulnerabilities", {
        page: args.page,
        pageLimit: args.pageLimit ?? systemReportDefaultLimit(),
        resource_id: args.resourceId,
        vulnerabilityid: args.vulnerabilityId,
        vulnerabilityname: args.vulnerabilityName,
        severity: args.severity,
        vulnerability_status: args.vulnerabilityStatus,
        updatedtime: args.updatedTime,
      });
      return shapeSystemReport(data, args.raw, ["resource_id", "vulnerabilities"]);
    }
  );
}
