import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient, type QueryParams } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Inventory module (/api/1.4/inventory/*) — all read-only.
 *
 * Note on the six "computers" tools: the spec lists the path six times
 * ("computers?api1" ... "computers?api6" — an OpenAPI dedup suffix, not a
 * literal path). The real endpoint is always /api/1.4/inventory/computers;
 * the variants differ only by which required query parameter drives them
 * (swid / hwid / swmeruleid / licswid / licid / prohibitedswid) and return
 * differently-shaped records. They are modeled as six distinct tools.
 */

// ---------------------------------------------------------------------------
// Shared input fields
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

const branchOfficeFilterInput = z
  .string()
  .optional()
  .describe("Filter by the remote/branch office the computer is mapped to.");

const customGroupFilterInput = z.string().optional().describe("Filter by custom group name.");

const domainFilterInput = z
  .string()
  .optional()
  .describe("Filter by the NetBIOS domain the computer is mapped to.");

const OS_COMPATIBILITY_VALUES = ["32-bit", "64-bit"] as const;

const osCompatibilityFilterInput = z
  .enum(OS_COMPATIBILITY_VALUES)
  .optional()
  .describe('Filter by OS architecture: "32-bit" or "64-bit".');

const liveStatusFilterInput = z
  .union([z.literal(1), z.literal(2), z.literal(3)])
  .optional()
  .describe("Filter by computer live status: 1 live, 2 down, 3 unknown.");

const accessTypeFilterInput = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .optional()
  .describe("Filter by software access type: 0 not assigned, 1 allowed, 2 prohibited.");

const licenseTypeFilterInput = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .optional()
  .describe("Filter by license type: 0 unidentified, 1 commercial, 2 non-commercial.");

const complianceStatusFilterInput = z
  .union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .optional()
  .describe(
    "Filter by license compliance status: 0 under-licensed, 1 over-licensed, 2 in compliance, 3 expired, -1 not available."
  );

type LiveStatus = 1 | 2 | 3;
type AccessType = 0 | 1 | 2;
type LicenseType = 0 | 1 | 2;
type ComplianceStatus = -1 | 0 | 1 | 2 | 3;

type PagedArgs = { page?: number; pageLimit?: number; raw?: boolean };

// ---------------------------------------------------------------------------
// Curated default field sets (raw records carry many more DB-style fields;
// `raw: true` on each tool returns them unprojected)
// ---------------------------------------------------------------------------

const COMPUTERS_BY_SOFTWARE_FIELDS = [
  "resource_id",
  "resource_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "mac_address",
  "os_name",
  "os_platform",
  "computer_live_status",
  "software_name",
  "software_version",
  "display_name",
  "installed_date",
  "architecture",
  "sw_usage_type",
  "uninstall_status",
  "last_successful_scan",
  "primary_owner_name",
  "agent_logged_on_users",
] as const;

const COMPUTERS_BY_HARDWARE_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "mac_address",
  "computer_live_status",
  "model",
  "servicetag",
  "system_type",
  "no_of_processors",
  "total_ram_memory",
  "copies",
  "warranty_expiry_date",
  "shipping_date",
  "agent_last_contact_time",
  "primary_owner_name",
] as const;

const COMPUTERS_WITH_METERING_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "branch_office_name",
  "computer_live_status",
  "invsoftwaremeteringusagesummary.app_definition_id",
  "invsoftwaremeteringusagesummary.product_name",
  "invsoftwaremeteringusagesummary.product_version",
  "invsoftwaremeteringusagesummary.file_version",
  "invsoftwaremeteringusagesummary.total_run_time",
  "invsoftwaremeteringusagesummary.total_run_count",
  "invsoftwaremeteringusagesummary.last_used",
  "invsoftwaremeteringusagesummary.updated_time",
] as const;

// api4 and api5 return the same record shape (computer + license details).
const COMPUTERS_BY_LICENSE_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "mac_address",
  "os_name",
  "os_version",
  "computer_live_status",
  "license_name",
  "software_name",
  "manufacturer_name",
  "model",
  "servicetag",
  "primary_owner_name",
  "agent_logged_on_users",
] as const;

const COMPUTERS_BY_PROHIBITED_SW_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "os_name",
  "computer_live_status",
  "software_name",
  "software_version",
  "display_name",
  "installed_date",
  "location",
  "total_prohibited_count",
  "total_requested_count",
  "approved_prohibited_count",
  "pending_approval_count",
  "rejected_prohibited_count",
  "not_requested_count",
  "uninstall_status",
] as const;

const HARDWARE_FIELDS = [
  "hardware_id",
  "hardware_name",
  "manufacturer_name",
  "hw_type_description",
  "managed_installations",
  "network_installations",
] as const;

const INSTALLED_SOFTWARE_FIELDS = [
  "software_id",
  "software_name",
  "display_name",
  "software_version",
  "manufacturer_name",
  "sw_category_name",
  "sw_type",
  "architecture",
  "installed_format",
  "installed_date",
  "detected_time",
  "compliant_status",
  "license_owner",
  "total_copies",
  "remaining_copies",
  "is_usage_prohibited",
  "location",
  "uninstall_status",
] as const;

const LICENSES_FIELDS = [
  "license_id",
  "license_name",
  "software_id",
  "software_name",
  "software_version",
  "display_name",
  "manufacturer_name",
  "sw_type",
  "licensed_to",
  "no_of_copies",
  "mapped_resource_count",
  "purchase_date",
  "expiry_date",
  "invswlicenseedition.license_type",
  "invswlicenseedition.edition_name",
  "invswlicenseedition.license_metric",
  "invswlicensedetails.cost",
  "invswlicensedetails.vendor",
  "remarks",
] as const;

const LICENSE_SOFTWARE_FIELDS = [
  "software_id",
  "software_name",
  "display_name",
  "software_version",
  "manufacturer_name",
  "license_id",
  "license_owner",
  "compliant_status",
  "software_compliance_description",
  "total_copies",
  "installed_copies",
  "remaining_copies",
  "network_installations",
  "sw_type",
  "is_usage_prohibited",
  "detected_time",
] as const;

const PROHIBITED_SW_FIELDS = [
  "software_id",
  "software_name",
  "display_name",
  "software_version",
  "manufacturer_id",
  "managed_installations",
  "network_installations",
  "installed_format",
  "is_uninstallable",
  "silent_switch",
  "sw_type",
  "is_usage_prohibited",
] as const;

const SCAN_COMPUTERS_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "branch_office_name",
  "ip_address",
  "mac_address",
  "os_name",
  "os_version",
  "agent_version",
  "installation_status",
  "status_label",
  "scan_status",
  "scan_remarks_en",
  "last_successful_scan",
  "computer_live_status",
  "agent_last_contact_time",
  "agent_logged_on_users",
] as const;

const SOFTWARE_FIELDS = [
  "software_id",
  "software_name",
  "display_name",
  "software_version",
  "manufacturer_name",
  "sw_category_name",
  "sw_type",
  "sw_family",
  "installed_format",
  "managed_installations",
  "network_installations",
  "compliant_status",
  "software_compliance_description",
  "total_copies",
  "remaining_copies",
  "is_usage_prohibited",
  "detected_time",
] as const;

const SW_METERING_SUMMARY_FIELDS = [
  "app_definition_id",
  "definition_name",
  "file_name",
  "original_file_name",
  "product_name",
  "file_version",
  "total_run_time",
  "total_run_count",
  "swm_discovered_count",
  "app_definition_status",
  "added_by",
  "added_time",
  "modified_by",
  "modified_time",
  "comments",
] as const;

// ---------------------------------------------------------------------------
// Response shapes (only the parts each handler touches)
// ---------------------------------------------------------------------------

interface InventoryAllSummaryResponse {
  message_response: { allsummary: Record<string, unknown> };
}

interface InventoryCompDetailsSummaryResponse {
  message_response: { compdetailssummary: Record<string, unknown> };
}

interface InventoryFilterParamsResponse {
  message_response: { filterparams: Record<string, unknown> };
}

interface PagedListMeta {
  total?: number;
  limit?: number;
  page?: number;
}

interface InventoryComputersResponse {
  message_response: PagedListMeta & { computers?: Record<string, unknown>[] };
}

interface InventoryHardwareResponse {
  message_response: PagedListMeta & { hardware?: Record<string, unknown>[] };
}

interface InventoryInstalledSoftwareResponse {
  message_response: PagedListMeta & { installedsoftware?: Record<string, unknown>[] };
}

interface InventoryLicensesResponse {
  message_response: PagedListMeta & { licenses?: Record<string, unknown>[] };
}

interface InventoryLicenseSoftwareResponse {
  message_response: PagedListMeta & { licensesoftware?: Record<string, unknown>[] };
}

interface InventoryProhibitedSwResponse {
  message_response: PagedListMeta & { prohibitedsw?: Record<string, unknown>[] };
}

interface InventoryScanComputersResponse {
  message_response: PagedListMeta & { scancomputers?: Record<string, unknown>[] };
}

interface InventorySoftwareResponse {
  message_response: PagedListMeta & { software?: Record<string, unknown>[] };
}

interface InventorySwMeteringSummaryResponse {
  message_response: PagedListMeta & { swmeteringsummary?: Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------
// Shared handler for the six /inventory/computers variants
// ---------------------------------------------------------------------------

async function inventoryComputersList(
  drivingQuery: QueryParams,
  fields: readonly string[],
  args: PagedArgs
) {
  const { defaultPageLimit } = loadConfig();

  const data = await httpClient.get<InventoryComputersResponse>("/api/1.4/inventory/computers", {
    ...drivingQuery,
    page: args.page,
    pagelimit: args.pageLimit ?? defaultPageLimit,
  });

  const { total, limit, page } = data.message_response;
  const computers = data.message_response.computers ?? [];
  const shaped = args.raw ? computers : projectList(computers, fields);

  return toToolResult({ total, page, limit, computers: shaped }, paginationNote({ total, page, limit }));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerInventoryTools(server: McpServer): void {
  server.registerTool(
    "inventory_all_summary",
    {
      title: "Inventory overall summary",
      description:
        "Retrieves the overall Inventory module summary: scan/audit status counts, software counts (commercial, " +
        "non-commercial, prohibited), license compliance summary, computers by OS, and warranty summary.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<InventoryAllSummaryResponse>("/api/1.4/inventory/allsummary");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "inventory_computer_details_summary",
    {
      title: "Computer inventory summary",
      description:
        "Retrieves the detailed inventory summary for one computer: asset counts, OS details, disk usage, " +
        "hardware summary (model, processor, memory, serial number, warranty), and network adapters.",
      inputSchema: {
        resId: z
          .number()
          .int()
          .positive()
          .describe("resource_id of the computer (from som_computers_list or inventory_scan_computers_list)."),
      },
      annotations: READ_ONLY,
    },
    async (args: { resId: number }) => {
      const data = await httpClient.get<InventoryCompDetailsSummaryResponse>(
        "/api/1.4/inventory/compdetailssummary",
        { resid: args.resId }
      );
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "inventory_filter_params",
    {
      title: "Inventory filter parameters",
      description:
        "Retrieves the valid values for inventory filters: OS names, software categories, software/hardware/computer " +
        "manufacturers, and hardware types. Use these values with the filter inputs of other inventory tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<InventoryFilterParamsResponse>("/api/1.4/inventory/filterParams");
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "inventory_computers_by_software",
    {
      title: "Computers with a specific software",
      description:
        "Retrieves the computers on which a specific software (by software_id from inventory_software_list) is " +
        "installed, with install date, version, and computer details.",
      inputSchema: {
        swId: z
          .number()
          .int()
          .positive()
          .describe("software_id of the software (from inventory_software_list)."),
        branchOfficeFilter: branchOfficeFilterInput,
        customGroupFilter: customGroupFilterInput,
        domainFilter: domainFilterInput,
        osCompatibilityFilter: osCompatibilityFilterInput,
        liveStatusFilter: liveStatusFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      swId: number;
      branchOfficeFilter?: string;
      customGroupFilter?: string;
      domainFilter?: string;
      osCompatibilityFilter?: (typeof OS_COMPATIBILITY_VALUES)[number];
      liveStatusFilter?: LiveStatus;
    }) =>
      inventoryComputersList(
        {
          swid: args.swId,
          branchofficefilter: args.branchOfficeFilter,
          customgroupfilter: args.customGroupFilter,
          domainfilter: args.domainFilter,
          oscompatibilityfilter: args.osCompatibilityFilter,
          livestatusfilter: args.liveStatusFilter,
        },
        COMPUTERS_BY_SOFTWARE_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_computers_by_hardware",
    {
      title: "Computers with a specific hardware",
      description:
        "Retrieves the computers that have a specific hardware component (by hardware_id from " +
        "inventory_hardware_list), with model, service tag, RAM, warranty, and computer details.",
      inputSchema: {
        hwId: z
          .number()
          .int()
          .positive()
          .describe("hardware_id of the hardware component (from inventory_hardware_list)."),
        branchOfficeFilter: branchOfficeFilterInput,
        customGroupFilter: customGroupFilterInput,
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      hwId: number;
      branchOfficeFilter?: string;
      customGroupFilter?: string;
      domainFilter?: string;
    }) =>
      inventoryComputersList(
        {
          hwid: args.hwId,
          branchofficefilter: args.branchOfficeFilter,
          customgroupfilter: args.customGroupFilter,
          domainfilter: args.domainFilter,
        },
        COMPUTERS_BY_HARDWARE_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_computers_with_metering",
    {
      title: "Computers under a software metering rule",
      description:
        "Retrieves the computers tracked by a specific software metering rule (by app_definition_id from " +
        "inventory_software_metering_summary), with per-computer usage: total run time, run count, and last used.",
      inputSchema: {
        swMeRuleId: z
          .number()
          .int()
          .positive()
          .describe(
            "Software metering rule id (app_definition_id, from inventory_software_metering_summary)."
          ),
        branchOfficeFilter: branchOfficeFilterInput,
        customGroupFilter: customGroupFilterInput,
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      swMeRuleId: number;
      branchOfficeFilter?: string;
      customGroupFilter?: string;
      domainFilter?: string;
    }) =>
      inventoryComputersList(
        {
          swmeruleid: args.swMeRuleId,
          branchofficefilter: args.branchOfficeFilter,
          customgroupfilter: args.customGroupFilter,
          domainfilter: args.domainFilter,
        },
        COMPUTERS_WITH_METERING_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_computers_by_licensed_software",
    {
      title: "Computers with a licensed software",
      description:
        "Retrieves the computers associated with a specific licensed software (by licensed software id from " +
        "inventory_license_software_list), including which license each computer maps to.",
      inputSchema: {
        licSwId: z
          .number()
          .int()
          .positive()
          .describe("software_id of the licensed software (from inventory_license_software_list)."),
        licenseFilter: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter to one license by its license_id (from inventory_licenses_list)."),
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { licSwId: number; licenseFilter?: number; domainFilter?: string }) =>
      inventoryComputersList(
        {
          licswid: args.licSwId,
          licensefilter: args.licenseFilter,
          domainfilter: args.domainFilter,
        },
        COMPUTERS_BY_LICENSE_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_computers_by_license",
    {
      title: "Computers under a software license",
      description:
        "Retrieves the computers associated with a specific software license (by license_id from " +
        "inventory_licenses_list), with the license name and computer details.",
      inputSchema: {
        licId: z
          .number()
          .int()
          .positive()
          .describe("license_id of the software license (from inventory_licenses_list)."),
        licenseFilter: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Additional license_id filter (from inventory_licenses_list)."),
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { licId: number; licenseFilter?: number; domainFilter?: string }) =>
      inventoryComputersList(
        {
          licid: args.licId,
          licensefilter: args.licenseFilter,
          domainfilter: args.domainFilter,
        },
        COMPUTERS_BY_LICENSE_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_computers_by_prohibited_software",
    {
      title: "Computers with a prohibited software",
      description:
        "Retrieves the computers on which a specific prohibited software (by software_id from " +
        "inventory_prohibited_software_list) is detected, with install location and exception-request counts " +
        "(approved, pending, rejected, not requested).",
      inputSchema: {
        prohibitedSwId: z
          .number()
          .int()
          .positive()
          .describe("software_id of the prohibited software (from inventory_prohibited_software_list)."),
        branchOfficeFilter: branchOfficeFilterInput,
        customGroupFilter: customGroupFilterInput,
        domainFilter: domainFilterInput,
        osCompatibilityFilter: osCompatibilityFilterInput,
        liveStatusFilter: liveStatusFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      prohibitedSwId: number;
      branchOfficeFilter?: string;
      customGroupFilter?: string;
      domainFilter?: string;
      osCompatibilityFilter?: (typeof OS_COMPATIBILITY_VALUES)[number];
      liveStatusFilter?: LiveStatus;
    }) =>
      inventoryComputersList(
        {
          prohibitedswid: args.prohibitedSwId,
          branchofficefilter: args.branchOfficeFilter,
          customgroupfilter: args.customGroupFilter,
          domainfilter: args.domainFilter,
          oscompatibilityfilter: args.osCompatibilityFilter,
          livestatusfilter: args.liveStatusFilter,
        },
        COMPUTERS_BY_PROHIBITED_SW_FIELDS,
        args
      )
  );

  server.registerTool(
    "inventory_hardware_list",
    {
      title: "List hardware inventory",
      description:
        "Retrieves all detected hardware components across the network with manufacturer, hardware type, and " +
        "managed/network installation counts. Use inventory_filter_params for valid filter values.",
      inputSchema: {
        branchOfficeFilter: branchOfficeFilterInput,
        manufacturerFilter: z
          .string()
          .optional()
          .describe("Filter by hardware manufacturer name (values from inventory_filter_params)."),
        hardwareTypeFilter: z
          .string()
          .optional()
          .describe('Filter by hardware type, e.g. "Bios", "Processor", "Disk Drive" (values from inventory_filter_params).'),
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      branchOfficeFilter?: string;
      manufacturerFilter?: string;
      hardwareTypeFilter?: string;
      domainFilter?: string;
    }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryHardwareResponse>("/api/1.4/inventory/hardware", {
        branchofficefilter: args.branchOfficeFilter,
        manufacturerFilter: args.manufacturerFilter,
        hardwareTypeFilter: args.hardwareTypeFilter,
        domainfilter: args.domainFilter,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const hardware = data.message_response.hardware ?? [];
      const shaped = args.raw ? hardware : projectList(hardware, HARDWARE_FIELDS);
      return toToolResult({ total, page, limit, hardware: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "inventory_installed_software_list",
    {
      title: "List software installed on a computer",
      description:
        "Retrieves the software installed on a specific computer with version, manufacturer, category, install " +
        "format, license/compliance status, and whether usage is prohibited.",
      inputSchema: {
        resId: z
          .number()
          .int()
          .positive()
          .describe("resource_id of the computer (from som_computers_list or inventory_scan_computers_list)."),
        accessTypeFilter: accessTypeFilterInput,
        osCompatibilityFilter: osCompatibilityFilterInput,
        licenseTypeFilter: licenseTypeFilterInput,
        complianceStatusFilter: complianceStatusFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      resId: number;
      accessTypeFilter?: AccessType;
      osCompatibilityFilter?: (typeof OS_COMPATIBILITY_VALUES)[number];
      licenseTypeFilter?: LicenseType;
      complianceStatusFilter?: ComplianceStatus;
    }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryInstalledSoftwareResponse>(
        "/api/1.4/inventory/installedsoftware",
        {
          resid: args.resId,
          accesstypefilter: args.accessTypeFilter,
          oscompatibilityfilter: args.osCompatibilityFilter,
          licensetypefilter: args.licenseTypeFilter,
          compliancestatusfilter: args.complianceStatusFilter,
          page: args.page,
          pagelimit: args.pageLimit ?? defaultPageLimit,
        }
      );
      const { total, limit, page } = data.message_response;
      const installedsoftware = data.message_response.installedsoftware ?? [];
      const shaped = args.raw ? installedsoftware : projectList(installedsoftware, INSTALLED_SOFTWARE_FIELDS);
      return toToolResult(
        { total, page, limit, installedSoftware: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );

  server.registerTool(
    "inventory_licenses_list",
    {
      title: "List licenses of a software",
      description:
        "Retrieves the licenses recorded for a specific software (by software_id) with license name, edition, " +
        "copies, mapped computer count, purchase/expiry dates, and purchase details. License key and file-path " +
        "fields are available via raw: true.",
      inputSchema: {
        swId: z
          .number()
          .int()
          .positive()
          .describe("software_id of the licensed software (from inventory_license_software_list)."),
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { swId: number }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryLicensesResponse>("/api/1.4/inventory/licenses", {
        swid: args.swId,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const licenses = data.message_response.licenses ?? [];
      const shaped = args.raw ? licenses : projectList(licenses, LICENSES_FIELDS);
      return toToolResult({ total, page, limit, licenses: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "inventory_license_software_list",
    {
      title: "List licensed software",
      description:
        "Retrieves all software that has license records, with total/installed/remaining copies, compliance " +
        "status (under/over licensed, in compliance, expired), and network installation counts.",
      inputSchema: {
        complianceStatusFilter: complianceStatusFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { complianceStatusFilter?: ComplianceStatus }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryLicenseSoftwareResponse>(
        "/api/1.4/inventory/licensesoftware",
        {
          compliancestatusfilter: args.complianceStatusFilter,
          page: args.page,
          pagelimit: args.pageLimit ?? defaultPageLimit,
        }
      );
      const { total, limit, page } = data.message_response;
      const licensesoftware = data.message_response.licensesoftware ?? [];
      const shaped = args.raw ? licensesoftware : projectList(licensesoftware, LICENSE_SOFTWARE_FIELDS);
      return toToolResult(
        { total, page, limit, licenseSoftware: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );

  server.registerTool(
    "inventory_prohibited_software_list",
    {
      title: "List prohibited software",
      description:
        "Retrieves prohibited software detected across the network with installation counts, installer format " +
        "(MSI/EXE), and whether silent uninstallation is supported.",
      inputSchema: {
        uninstallSupportFilter: z
          .enum(["Yes", "No"] as const)
          .optional()
          .describe('Filter by uninstall support: "Yes" (can be uninstalled) or "No".'),
        installerFormatFilter: z
          .enum(["MSI", "EXE"] as const)
          .optional()
          .describe('Filter by installer format: "MSI" or "EXE".'),
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      uninstallSupportFilter?: "Yes" | "No";
      installerFormatFilter?: "MSI" | "EXE";
    }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryProhibitedSwResponse>("/api/1.4/inventory/prohibitedsw", {
        uninstallsupportfilter: args.uninstallSupportFilter,
        installerformatfilter: args.installerFormatFilter,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const prohibitedsw = data.message_response.prohibitedsw ?? [];
      const shaped = args.raw ? prohibitedsw : projectList(prohibitedsw, PROHIBITED_SW_FIELDS);
      return toToolResult(
        { total, page, limit, prohibitedSoftware: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );

  server.registerTool(
    "inventory_scan_computers_list",
    {
      title: "List computers with scan status",
      description:
        "Retrieves all inventory computers with their scan status (not done/failed/in progress/success), agent " +
        "installation status, live status, and last successful scan time.",
      inputSchema: {
        branchOfficeFilter: branchOfficeFilterInput,
        domainFilter: domainFilterInput,
        resIdFilter: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Filter to a specific computer by its resource_id."),
        installStatusFilter: z
          .union([z.literal(21), z.literal(22), z.literal(23), z.literal(24), z.literal(29)])
          .optional()
          .describe(
            "Filter by agent install status: 21 yet-to-install, 22 installed, 23 uninstalled, 24 yet-to-uninstall, 29 installation failure."
          ),
        scanStatusFilter: z
          .union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)])
          .optional()
          .describe("Filter by scan status: -1 not done, 0 failed, 1 in progress, 2 success."),
        liveStatusFilter: liveStatusFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      branchOfficeFilter?: string;
      domainFilter?: string;
      resIdFilter?: number;
      installStatusFilter?: 21 | 22 | 23 | 24 | 29;
      scanStatusFilter?: -1 | 0 | 1 | 2;
      liveStatusFilter?: LiveStatus;
    }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventoryScanComputersResponse>(
        "/api/1.4/inventory/scancomputers",
        {
          branchofficefilter: args.branchOfficeFilter,
          domainfilter: args.domainFilter,
          residfilter: args.resIdFilter,
          installstatusfilter: args.installStatusFilter,
          scanstatusfilter: args.scanStatusFilter,
          livestatusfilter: args.liveStatusFilter,
          page: args.page,
          pagelimit: args.pageLimit ?? defaultPageLimit,
        }
      );
      const { total, limit, page } = data.message_response;
      const scancomputers = data.message_response.scancomputers ?? [];
      const shaped = args.raw ? scancomputers : projectList(scancomputers, SCAN_COMPUTERS_FIELDS);
      return toToolResult(
        { total, page, limit, scanComputers: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );

  server.registerTool(
    "inventory_software_list",
    {
      title: "List software inventory",
      description:
        "Retrieves all software detected across the network with version, manufacturer, category, installation " +
        "counts, license copies, and compliance status.",
      inputSchema: {
        accessTypeFilter: accessTypeFilterInput,
        licenseTypeFilter: licenseTypeFilterInput,
        complianceStatusFilter: complianceStatusFilterInput,
        domainFilter: domainFilterInput,
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & {
      accessTypeFilter?: AccessType;
      licenseTypeFilter?: LicenseType;
      complianceStatusFilter?: ComplianceStatus;
      domainFilter?: string;
    }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventorySoftwareResponse>("/api/1.4/inventory/software", {
        accesstypefilter: args.accessTypeFilter,
        licensetypefilter: args.licenseTypeFilter,
        compliancestatusfilter: args.complianceStatusFilter,
        domainfilter: args.domainFilter,
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page } = data.message_response;
      const software = data.message_response.software ?? [];
      const shaped = args.raw ? software : projectList(software, SOFTWARE_FIELDS);
      return toToolResult({ total, page, limit, software: shaped }, paginationNote({ total, page, limit }));
    }
  );

  server.registerTool(
    "inventory_software_metering_summary",
    {
      title: "List software metering rules",
      description:
        "Retrieves all software metering rules with usage metrics across the network: total run time, run count, " +
        "discovered installation count, and rule metadata. Use app_definition_id with " +
        "inventory_computers_with_metering to see per-computer usage.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<InventorySwMeteringSummaryResponse>(
        "/api/1.4/inventory/swmeteringsummary",
        {
          page: args.page,
          pagelimit: args.pageLimit ?? defaultPageLimit,
        }
      );
      const { total, limit, page } = data.message_response;
      const swmeteringsummary = data.message_response.swmeteringsummary ?? [];
      const shaped = args.raw ? swmeteringsummary : projectList(swmeteringsummary, SW_METERING_SUMMARY_FIELDS);
      return toToolResult(
        { total, page, limit, meteringSummary: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );
}
