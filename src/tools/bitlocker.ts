import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * BitLocker read tools: drive-level encryption reports, recovery key details,
 * and TPM status. All three are GET-only.
 *
 * Spec note: the spec declares no page/pagelimit params for
 * /bitlocker/bitlockerreports and /bitlocker/tpmreport, yet both response
 * examples carry the standard total/limit/page pagination envelope — so the
 * server clearly paginates. We expose page/pageLimit anyway, matching every
 * other Endpoint Central list GET.
 */

/**
 * Default projected fields for /api/1.4/bitlocker/bitlockerreports records.
 * Drops internal duplicates (resource_id_string, resource.resource_id,
 * managedcomputer.friendly_name, customer_id, encryption_flag_id,
 * persistent_volume_id) — `raw: true` still exposes everything.
 */
const BITLOCKER_REPORT_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "os_name",
  "bitlockerdrive.drive_letter",
  "device_id",
  "volume_type",
  "drive_size",
  "encryption_status",
  "encryption_method",
  "protection_status",
  "lock_status",
  "version",
] as const;

/**
 * Default projected fields for /api/1.4/bitlocker/recoverykeydetails records.
 * Deliberately EXCLUDES `recovery_key` (the actual recovery password) — key
 * material is only returned with `raw: true`. Do not add it here.
 */
const RECOVERY_KEY_FIELDS = [
  "key_protector_id",
  "drive_letter",
  "name",
  "resource_id",
  "domain_netbios_name",
] as const;

/** Default projected fields for /api/1.4/bitlocker/tpmreport records. */
const TPM_REPORT_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "blmtpmvendor.manufacturer_name",
  "manufacturer_id_txt",
  "manufacturer_version",
  "spec_version",
  "is_enabled",
  "is_activated",
  "is_owned",
] as const;

interface BitlockerReportsResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    bitlockerreports?: Record<string, unknown>[];
  };
}

interface RecoveryKeyDetailsResponse {
  message_response: {
    recoverykeydetails?: Record<string, unknown>[];
  };
}

interface TpmReportResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    tpmreport?: Record<string, unknown>[];
  };
}

const bitlockerReportsListInput = {
  page: z.number().int().min(1).optional().describe("Page number to retrieve. Default is 1."),
  pageLimit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max records per page (server cap is 1000). Defaults to the server's configured default page size."),
  residFilter: z.string().optional().describe("Filter to a specific computer by its resource_id (from som_computers_list)."),
  domainFilter: z.string().optional().describe("Filter by NetBIOS domain name."),
  raw: z
    .boolean()
    .optional()
    .describe("Return the full, unprojected record for each drive instead of the curated default field set."),
};

type BitlockerReportsListArgs = {
  page?: number;
  pageLimit?: number;
  residFilter?: string;
  domainFilter?: string;
  raw?: boolean;
};

const recoveryKeyDetailsInput = {
  keyProtectorId: z
    .string()
    .optional()
    .describe("Filter to a single key protector by its key protector ID (GUID)."),
  compName: z.string().optional().describe("Filter by computer name."),
  domainFilter: z.string().optional().describe("Filter by NetBIOS domain name."),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Set to true to include the recovery_key field (the actual BitLocker recovery password) in each record. " +
        "Off by default so key material is never exposed unless genuinely required."
    ),
};

type RecoveryKeyDetailsArgs = {
  keyProtectorId?: string;
  compName?: string;
  domainFilter?: string;
  raw?: boolean;
};

const tpmReportInput = {
  page: z.number().int().min(1).optional().describe("Page number to retrieve. Default is 1."),
  pageLimit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max records per page (server cap is 1000). Defaults to the server's configured default page size."),
  residFilter: z.string().optional().describe("Filter to a specific computer by its resource_id (from som_computers_list)."),
  domainFilter: z.string().optional().describe("Filter by NetBIOS domain name."),
  raw: z
    .boolean()
    .optional()
    .describe("Return the full, unprojected record for each computer instead of the curated default field set."),
};

type TpmReportArgs = {
  page?: number;
  pageLimit?: number;
  residFilter?: string;
  domainFilter?: string;
  raw?: boolean;
};

export function registerBitlockerTools(server: McpServer): void {
  server.registerTool(
    "bitlocker_reports_list",
    {
      title: "List drive-level BitLocker reports",
      description:
        "Retrieves drive-level BitLocker encryption details across managed computers: encryption status, " +
        "protection status, encryption method, lock status, drive letter, and drive size per volume. " +
        "Supports filtering by computer resource_id or domain.",
      inputSchema: bitlockerReportsListInput,
      annotations: READ_ONLY,
    },
    async (args: BitlockerReportsListArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<BitlockerReportsResponse>("/api/1.4/bitlocker/bitlockerreports", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        residfilter: args.residFilter,
        domainfilter: args.domainFilter,
      });
      const { total, limit, page, bitlockerreports } = data.message_response;
      const shaped = args.raw ? bitlockerreports ?? [] : projectList(bitlockerreports ?? [], BITLOCKER_REPORT_FIELDS);
      return toToolResult({ total, page, limit, drives: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "bitlocker_recovery_key_details",
    {
      title: "BitLocker recovery key details",
      description:
        "Retrieves BitLocker recovery key records (key protector ID, drive letter, computer, domain) for managed " +
        "computers, filterable by key protector ID, computer name, or domain. " +
        "SENSITIVE: this endpoint returns BitLocker recovery keys — secrets that unlock encrypted drives. Only " +
        "use it when key retrieval is genuinely needed (e.g. recovering a locked-out drive), never for routine " +
        "reporting. The default response deliberately omits the recovery_key field; set raw: true to expose the " +
        "actual key material.",
      inputSchema: recoveryKeyDetailsInput,
      annotations: READ_ONLY,
    },
    async (args: RecoveryKeyDetailsArgs) => {
      const data = await httpClient.get<RecoveryKeyDetailsResponse>("/api/1.4/bitlocker/recoverykeydetails", {
        keyProtectorId: args.keyProtectorId,
        compName: args.compName,
        domainfilter: args.domainFilter,
      });
      const records = data.message_response.recoverykeydetails ?? [];
      const shaped = args.raw ? records : projectList(records, RECOVERY_KEY_FIELDS);
      const note = args.raw
        ? "Response includes actual BitLocker recovery keys — handle as secrets and do not persist or echo them unnecessarily."
        : "recovery_key values are omitted by default. Re-run with raw: true only if the actual recovery key is genuinely required.";
      return toToolResult({ recoveryKeyDetails: shaped }, note);
    }
  );

  server.registerTool(
    "bitlocker_tpm_report",
    {
      title: "TPM report",
      description:
        "Retrieves Trusted Platform Module (TPM) details across managed computers: manufacturer, version, spec " +
        "version, and whether the TPM is enabled, activated, and owned. Supports filtering by computer " +
        "resource_id or domain.",
      inputSchema: tpmReportInput,
      annotations: READ_ONLY,
    },
    async (args: TpmReportArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<TpmReportResponse>("/api/1.4/bitlocker/tpmreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        residfilter: args.residFilter,
        domainfilter: args.domainFilter,
      });
      const { total, limit, page, tpmreport } = data.message_response;
      const shaped = args.raw ? tpmreport ?? [] : projectList(tpmreport ?? [], TPM_REPORT_FIELDS);
      return toToolResult({ total, page, limit, computers: shaped }, paginationNote({ total, page, limit }));
    }
  );
}
