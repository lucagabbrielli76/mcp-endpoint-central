import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Device Control Management (DCM) report tools — the nine read-only GETs under
 * /api/1.4/reports/dcm/*. Every endpoint returns the standard pagination
 * envelope with its record array under the `dcm` key.
 */

// devicetype filter values shared by most DCM endpoints (numeric strings in the spec).
const DEVICE_TYPE_VALUES = [
  "2",
  "3",
  "4",
  "5",
  "9",
  "19",
  "20",
  "21",
  "24",
  "26",
  "37",
  "42",
  "46",
  "49",
  "100",
  "102",
  "103",
  "104",
] as const;

const DEVICE_TYPE_DESCRIPTION =
  "Filter by device type: 2 biometric, 3 Bluetooth, 4 CD-ROM, 5 disk drive, 9 floppy disk, 19 image, " +
  "20 infrared, 21 keyboard, 24 modem, 26 mouse, 37 printer, 42 smart card reader, 46 tape drive, 49 WPD, " +
  "100 WPD Apple devices, 102 serial ports (COM), 103 parallel ports (LPT), 104 wireless adapters.";

// os_platform: 1 Windows, 2 Mac (string-typed in the spec).
const OS_PLATFORM_VALUES = ["1", "2"] as const;

// fileshadow status filter values (numeric strings in the spec).
const FILE_SHADOW_STATUS_VALUES = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;

// Shared input fragments — every field carries a .describe() for the LLM client.
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
  .describe("Return full, unprojected records instead of the curated default field set.");
const periodInput = z
  .number()
  .int()
  .min(0)
  .max(9)
  .optional()
  .describe(
    "Filter by time range: 0 this week, 1 this month, 2 this year, 3 last week, 4 last month, " +
      "5 last 2 months, 6 last 3 months, 7 last 6 months, 8 last 9 months, 9 last year."
  );
const computerInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Filter to a specific computer by its resource_id (from som_computers_list).");
const gidInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Filter to a custom group of computers by its group ID (from the custom group list API).");
const dipIdInput = z.string().optional().describe("Filter by device instance path.");
const osPlatformInput = z.enum(OS_PLATFORM_VALUES).optional().describe("Filter by OS platform: 1 Windows, 2 Mac.");
const domainInput = z.string().optional().describe("Filter by NetBIOS domain name.");
const deviceTypeInput = z.enum(DEVICE_TYPE_VALUES).optional().describe(DEVICE_TYPE_DESCRIPTION);
const isBlockedInput = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe("Filter by block status: 0 allowed, 1 blocked.");
const exemptionStatusInput = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .optional()
  .describe("Filter by exemption status: 0 yet to apply, 1 awaiting schedule, 2 active, 3 expired.");
const numberOfDaysInput = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("Only include activity from the last N days.");

/**
 * Default projected fields for device audit records (deviceaudit,
 * blockdeviceaudit — both return the same shape under `dcm`).
 */
const DEVICE_AUDIT_FIELDS = [
  "deviceaudit_id",
  "computer_resource_id",
  "resource_name",
  "domain_netbios_name",
  "os_platform",
  "userresource.name",
  "device_type",
  "deviceauditevents.target_device_name",
  "vendor_name",
  "product_name",
  "custom_device_name",
  "serial_number",
  "vendor_hex_id",
  "product_hex_id",
  "is_blocked",
  "device_inserted_time",
  "device_removed_time",
  "usage_duration",
] as const;

/** Default projected fields for devicesummary records (no domain field in this report). */
const DEVICE_SUMMARY_FIELDS = [
  "computer_resource_id",
  "resource_name",
  "os_platform",
  "userresource.name",
  "device_type",
  "deviceauditevents.target_device_name",
  "vendor_name",
  "product_name",
  "custom_device_name",
  "serial_number",
  "vendor_hex_id",
  "product_hex_id",
  "is_blocked",
  "connected_count",
  "last_occurrence",
  "device_inserted_time",
  "device_removed_time",
  "usage_duration",
] as const;

/**
 * Default projected fields for computerdevstatus records. Legacy port classes
 * (floppy, tape, infrared, serial/parallel ports) are left to `raw: true`.
 */
const COMPUTER_DEV_STATUS_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "os_platform",
  "agent_logged_on_users",
  "diskdrive.status_id",
  "cdrom.status_id",
  "wpd.status_id",
  "appledevices.status_id",
  "bluetooth.status_id",
  "wirelessnetworkadapters.status_id",
  "printer.status_id",
  "modem.status_id",
  "smartcardreader.status_id",
  "biometric.status_id",
  "image.status_id",
  "mouse.status_id",
  "keyboard.status_id",
] as const;

/** Default projected fields for maccomputerdevstatus records. */
const MAC_COMPUTER_DEV_STATUS_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "os_platform",
  "agent_logged_on_users",
  "diskdrive.status_id",
  "cdrom.status_id",
  "wpd.status_id",
  "appledevices.status_id",
  "bluetooth.status_id",
  "wirelessnetworkadapters.status_id",
  "printer.status_id",
  "image.status_id",
  "mouse.status_id",
] as const;

/** Default projected fields for deviceexemption records. */
const DEVICE_EXEMPTION_FIELDS = [
  "policy_id",
  "policy_name",
  "cr.name",
  "cr.domain_netbios_name",
  "ur.name",
  "os_platform",
  "device_type",
  "custom_device_name",
  "serial_number",
  "vendor_hex_id",
  "product_hex_id",
  "ta_type",
  "duration_type",
  "duration",
  "duration_from",
  "duration_to",
  "applied_time",
  "is_agent_deployed_access",
  "allowed_devices",
] as const;

/** Default projected fields for devicetypeexemption records. */
const DEVICE_TYPE_EXEMPTION_FIELDS = [
  "policy_id",
  "policy_name",
  "cr.name",
  "cr.domain_netbios_name",
  "ur.name",
  "os_platform",
  "device_type",
  "ta_type",
  "duration_type",
  "duration",
  "duration_from",
  "duration_to",
  "applied_time",
  "is_agent_deployed_access",
  "allowed_devices",
] as const;

/** Default projected fields for fileshadow records. */
const FILE_SHADOW_FIELDS = [
  "computerresource.name",
  "computerresource.domain_netbios_name",
  "userresource.name",
  "device_name",
  "custom_device_name",
  "serial_number",
  "file_name",
  "extension",
  "file_length",
  "source_file_path",
  "remote_shadow_path",
  "finalstatus.overall_status",
  "file_shadow_remarks",
  "connected_time",
  "last_modified_time",
] as const;

/** Default projected fields for filetrace records. */
const FILE_TRACE_FIELDS = [
  "resource_name",
  "domain_netbios_name",
  "userresource.name",
  "device_name",
  "file_name",
  "new_file_name",
  "extension",
  "is_directory",
  "file_size",
  "event_type",
  "operation_blocked",
  "process_name",
  "event_notified_time",
  "created_time",
  "modified_time",
  "accessed_time",
] as const;

interface DcmListResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    dcm?: Record<string, unknown>[];
  };
}

/** Shapes the shared DCM response envelope: projection, raw escape hatch, pagination note. */
function shapeDcmResult(
  data: DcmListResponse,
  resultKey: string,
  fields: readonly string[],
  raw: boolean | undefined
) {
  const { total, limit, page, dcm } = data.message_response;
  const shaped = raw ? dcm ?? [] : projectList(dcm ?? [], fields);
  return toToolResult({ total, page, limit, [resultKey]: shaped }, paginationNote({ total, page, limit }));
}

type PagedArgs = { page?: number; pageLimit?: number; raw?: boolean };

type DeviceAuditArgs = PagedArgs & {
  period?: number;
  computer?: number;
  gid?: number;
  dipId?: string;
  osPlatform?: (typeof OS_PLATFORM_VALUES)[number];
  domain?: string;
  deviceType?: (typeof DEVICE_TYPE_VALUES)[number];
};

type ExemptionArgs = PagedArgs & {
  period?: number;
  osPlatform?: (typeof OS_PLATFORM_VALUES)[number];
  domain?: string;
  deviceType?: (typeof DEVICE_TYPE_VALUES)[number];
  status?: 0 | 1 | 2 | 3;
};

const deviceAuditBaseInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  period: periodInput,
  computer: computerInput,
  gid: gidInput,
  dipId: dipIdInput,
  osPlatform: osPlatformInput,
  domain: domainInput,
  deviceType: deviceTypeInput,
  raw: rawInput,
};

const exemptionInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  period: periodInput,
  osPlatform: osPlatformInput,
  domain: domainInput,
  deviceType: deviceTypeInput,
  status: exemptionStatusInput,
  raw: rawInput,
};

const pagedOnlyInput = {
  page: pageInput,
  pageLimit: pageLimitInput,
  raw: rawInput,
};

export function registerDcmTools(server: McpServer): void {
  server.registerTool(
    "dcm_device_audit_list",
    {
      title: "List device activity audit",
      description:
        "Retrieves all device activity events detected across the network (Device Control Management): device " +
        "type, vendor/product, serial number, user, computer, insert/remove times, and whether access was " +
        "blocked. Supports filters for time period, computer, group, device type, block status, OS platform, " +
        "and domain.",
      inputSchema: {
        ...deviceAuditBaseInput,
        isBlocked: isBlockedInput,
      },
      annotations: READ_ONLY,
    },
    async (args: DeviceAuditArgs & { isBlocked?: 0 | 1 }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/deviceaudit", {
        period: args.period,
        computer: args.computer,
        isblocked: args.isBlocked,
        gid: args.gid,
        dipId: args.dipId,
        os_platform: args.osPlatform,
        domain: args.domain,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        devicetype: args.deviceType,
      });
      return shapeDcmResult(data, "deviceEvents", DEVICE_AUDIT_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_block_device_audit_list",
    {
      title: "List blocked device audit",
      description:
        "Retrieves all devices that were blocked across the network (Device Control Management): device type, " +
        "vendor/product, serial number, user, computer, and insert/remove times. Supports filters for time " +
        "period, computer, group, device type, OS platform, and domain.",
      inputSchema: deviceAuditBaseInput,
      annotations: READ_ONLY,
    },
    async (args: DeviceAuditArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/blockdeviceaudit", {
        period: args.period,
        computer: args.computer,
        gid: args.gid,
        dipId: args.dipId,
        os_platform: args.osPlatform,
        domain: args.domain,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        devicetype: args.deviceType,
      });
      return shapeDcmResult(data, "blockedDevices", DEVICE_AUDIT_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_device_summary_list",
    {
      title: "List unique devices detected",
      description:
        "Retrieves the list of unique devices detected in the network (Device Control Management), with " +
        "connection counts, last occurrence, and block status per device. Supports filters for OS platform, " +
        "device type, and block status.",
      inputSchema: {
        ...pagedOnlyInput,
        isBlocked: isBlockedInput,
        osPlatform: osPlatformInput,
        deviceType: deviceTypeInput,
      },
      annotations: READ_ONLY,
    },
    async (
      args: PagedArgs & {
        isBlocked?: 0 | 1;
        osPlatform?: (typeof OS_PLATFORM_VALUES)[number];
        deviceType?: (typeof DEVICE_TYPE_VALUES)[number];
      }
    ) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/devicesummary", {
        isblocked: args.isBlocked,
        os_platform: args.osPlatform,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        devicetype: args.deviceType,
      });
      return shapeDcmResult(data, "devices", DEVICE_SUMMARY_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_computer_device_status_list",
    {
      title: "List Windows computer device status",
      description:
        "Retrieves per-computer device control status for all Windows computers: one record per computer with a " +
        "status ID for each device class (disk drive, CD-ROM, WPD, Bluetooth, printer, etc.). Curated default " +
        "omits legacy port classes; use raw: true for every device class.",
      inputSchema: pagedOnlyInput,
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/computerdevstatus", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDcmResult(data, "computers", COMPUTER_DEV_STATUS_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_mac_computer_device_status_list",
    {
      title: "List Mac computer device status",
      description:
        "Retrieves per-computer device control status for all Mac computers: one record per computer with a " +
        "status ID for each device class (disk drive, CD-ROM, WPD, Bluetooth, printer, etc.).",
      inputSchema: pagedOnlyInput,
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/maccomputerdevstatus", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDcmResult(data, "computers", MAC_COMPUTER_DEV_STATUS_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_device_exemption_list",
    {
      title: "List temporarily exempted devices",
      description:
        "Retrieves devices granted temporary exemptions from device control policies, with the policy, target " +
        "computer/user, exemption window, and status. Supports filters for time period, OS platform, device " +
        "type, exemption status, and domain.",
      inputSchema: exemptionInput,
      annotations: READ_ONLY,
    },
    async (args: ExemptionArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/deviceexemption", {
        period: args.period,
        os_platform: args.osPlatform,
        domain: args.domain,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        devicetype: args.deviceType,
        status: args.status,
      });
      return shapeDcmResult(data, "exemptions", DEVICE_EXEMPTION_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_device_type_exemption_list",
    {
      title: "List temporarily exempted device types",
      description:
        "Retrieves device types (whole classes, e.g. all disk drives) granted temporary exemptions from device " +
        "control policies, with the policy, target computer/user, exemption window, and status. Supports filters " +
        "for time period, OS platform, device type, exemption status, and domain.",
      inputSchema: exemptionInput,
      annotations: READ_ONLY,
    },
    async (args: ExemptionArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/devicetypeexemption", {
        period: args.period,
        os_platform: args.osPlatform,
        domain: args.domain,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        devicetype: args.deviceType,
        status: args.status,
      });
      return shapeDcmResult(data, "exemptions", DEVICE_TYPE_EXEMPTION_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_file_shadow_list",
    {
      title: "List file shadow operations",
      description:
        "Retrieves file shadow (mirror copy) operations performed for files transferred to removable devices: " +
        "source file, shadow path, device, user, computer, and operation status. Supports filters for time " +
        "period, computer, group, domain, shadow status, and last-N-days activity.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        period: periodInput,
        computer: computerInput,
        gid: gidInput,
        domain: domainInput,
        numberOfDays: numberOfDaysInput,
        status: z
          .enum(FILE_SHADOW_STATUS_VALUES)
          .optional()
          .describe(
            "Filter by file shadow status: 1 yet to start, 2 excluded, 3 wait, 4 ready, 5 in progress, " +
              "6 success, 7 failed, 8 cancelled."
          ),
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (
      args: PagedArgs & {
        period?: number;
        computer?: number;
        gid?: number;
        domain?: string;
        numberOfDays?: number;
        status?: (typeof FILE_SHADOW_STATUS_VALUES)[number];
      }
    ) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/fileshadow", {
        period: args.period,
        computer: args.computer,
        gid: args.gid,
        domain: args.domain,
        page: args.page,
        numberOfDays: args.numberOfDays,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        status: args.status,
      });
      return shapeDcmResult(data, "fileShadowOperations", FILE_SHADOW_FIELDS, args.raw);
    }
  );

  server.registerTool(
    "dcm_file_trace_list",
    {
      title: "List file activities",
      description:
        "Retrieves file activities (create, open, modify, delete, rename, move, copy, read) detected on devices " +
        "across the network: file name/size, event type, process, device, user, and computer. Supports filters " +
        "for event type, file extension or extension group, block status, device instance path, time period, " +
        "computer, group, and domain.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        period: periodInput,
        computer: computerInput,
        gid: gidInput,
        dipId: dipIdInput,
        domain: domainInput,
        isBlocked: isBlockedInput,
        numberOfDays: numberOfDaysInput,
        fileExtn: z.string().optional().describe('Filter file activities by file extension, e.g. "pdf".'),
        fileExtnGrp: z.string().optional().describe("Filter file activities by file extension group."),
        event: z
          .number()
          .int()
          .min(0)
          .max(8)
          .optional()
          .describe(
            "Filter by file event type: 0 unknown, 1 create, 2 open, 3 delete, 4 rename, 5 modify, 6 read, " +
              "7 move, 8 copy."
          ),
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (
      args: PagedArgs & {
        period?: number;
        computer?: number;
        gid?: number;
        dipId?: string;
        domain?: string;
        isBlocked?: 0 | 1;
        numberOfDays?: number;
        fileExtn?: string;
        fileExtnGrp?: string;
        event?: number;
      }
    ) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DcmListResponse>("/api/1.4/reports/dcm/filetrace", {
        fileExtnGrp: args.fileExtnGrp,
        period: args.period,
        gid: args.gid,
        fileExtn: args.fileExtn,
        numberOfDays: args.numberOfDays,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        computer: args.computer,
        isblocked: args.isBlocked,
        dipId: args.dipId,
        domain: args.domain,
        page: args.page,
        event: args.event,
      });
      return shapeDcmResult(data, "fileActivities", FILE_TRACE_FIELDS, args.raw);
    }
  );
}
