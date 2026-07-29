import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Read-only tools for the /api/1.4/reports/dlp/* report endpoints (Data Leak
 * Prevention). Every endpoint here is a GET returning the same envelope:
 * message_response: { total, limit, page, dlp: [...] } — the record array is
 * always keyed "dlp" regardless of report type.
 */

interface DlpReportResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    dlp?: Record<string, unknown>[];
  };
}

/**
 * Endpoint activity records mix DB-style prefixed names ("resfileaudit.user")
 * with bare ones; the spec's example includes a few fields
 * (classification_source, resource_name, ...) absent from its schema, so this
 * list is the union of both. "justication_value" [sic] is the API's actual
 * (misspelled) field name; the correctly spelled variant is also listed
 * defensively in case an on-prem build fixes it.
 */
const ENDPOINT_ACTIVITY_FIELDS = [
  "resource_name",
  "resfileaudit.user",
  "file_path",
  "resfileaudit.event_type",
  "resfileaudit.event_time",
  "resfileaudit.boundary_type",
  "resfileaudit.boundary_value",
  "classification_category",
  "classification_type",
  "classification_rule",
  "classification_source",
  "justication_value",
  "justification_value",
  "override_comment",
] as const;

/**
 * The spec's schema names these fields "resfileaudit.event_type" /
 * "resfileaudit.boundary_type" while its example uses bare "event_type" /
 * "boundary_type" — both variants are listed so projection works either way.
 */
const JUSTIFICATION_FIELDS = [
  "event_type",
  "resfileaudit.event_type",
  "event_time",
  "boundary_type",
  "resfileaudit.boundary_type",
  "boundary_value",
  "justication_value",
  "justification_value",
  "override_comment",
] as const;

const CBFP_FIELDS = ["boundary_value", "resourcecount"] as const;
const DCFP_FIELDS = ["datarule", "resourcecount"] as const;
const DEVICE_FIELDS = ["device_instance_path", "cgcount"] as const;
const EMAIL_FIELDS = ["dlpemaildomains.email_domain", "cgcount"] as const;
const PRINTER_FIELDS = ["dlpnetworkprinters.printer_name", "cgcount"] as const;
const PRODUCT_FIELDS = ["acpproductdetails.product_name", "cgcount"] as const;
const RULES_FIELDS = ["datarule_name", "cgcount"] as const;
const USB_PRINTER_FIELDS = ["device_instance_path", "cgcount"] as const;
const WEB_DOMAIN_FIELDS = ["dlpwebdomains.web_domain_val", "cgcount"] as const;

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
const ruleClassInput = z
  .string()
  .optional()
  .describe('Filter by data rule class, e.g. "Finance", "PII", "Health", "Source code", "Custom rules".');

type PagedArgs = { page?: number; pageLimit?: number; raw?: boolean };

/**
 * Shared shaping for every DLP report: pull the common envelope apart, apply
 * the report's curated field projection (unless raw), and attach the
 * pagination note. Fetching stays at each call site so httpClient.get always
 * receives a literal path (SSRF-guard convention).
 */
function shapeDlpResult(
  data: DlpReportResponse,
  raw: boolean | undefined,
  fields: readonly string[],
  recordsKey: string
) {
  const { total, limit, page, dlp } = data.message_response;
  const records = dlp ?? [];
  const shaped = raw ? records : projectList(records, fields);
  return toToolResult({ total, page, limit, [recordsKey]: shaped }, paginationNote({ total, page, limit }));
}

export function registerDlpTools(server: McpServer): void {
  server.registerTool(
    "dlp_endpoint_activity_report",
    {
      title: "DLP endpoint activity report",
      description:
        "Retrieves all DLP activities performed on endpoints: user, file path, boundary application/domain, " +
        "Leak Prevention action taken (allowed/blocked/self override/reported false positive), and sensitivity " +
        "classification details. Supports filtering by action and pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        actionFilter: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
          .optional()
          .describe(
            "Filter by Leak Prevention action performed: 0 allowed, 1 blocked, 2 self override, 3 reported false positive."
          ),
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { actionFilter?: 0 | 1 | 2 | 3 }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/endpointactivityreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        actionFilter: args.actionFilter,
      });
      return shapeDlpResult(data, args.raw, ENDPOINT_ACTIVITY_FIELDS, "activities");
    }
  );

  server.registerTool(
    "dlp_justification_report",
    {
      title: "DLP business justification report",
      description:
        "Retrieves business justification messages provided by endpoint users when overriding DLP restrictions, " +
        "with the boundary type/value, event type, override comment, and event time. Supports filtering by " +
        "justification message and pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        justificationMsg: z
          .string()
          .optional()
          .describe("Filter to records whose business justification message matches this text."),
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { justificationMsg?: string }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/justificationreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        justificationmsg: args.justificationMsg,
      });
      return shapeDlpResult(data, args.raw, JUSTIFICATION_FIELDS, "justifications");
    }
  );

  server.registerTool(
    "dlp_network_cbfp_report",
    {
      title: "DLP perimeter false positives report",
      description:
        "Retrieves false positives reported by endpoints in the enterprise perimeter (containment boundaries), " +
        "listing each boundary value (printer, domain, device, ...) with the number of endpoints that raised " +
        "false positives against it. Supports filtering by boundary type and pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        boundaryType: z
          .union([z.literal(1), z.literal(5), z.literal(6), z.literal(8), z.literal(16)])
          .optional()
          .describe(
            "Filter by boundary type: 1 storage devices, 5 network printers, 6 USB printers, 8 web domains, 16 email domains."
          ),
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { boundaryType?: 1 | 5 | 6 | 8 | 16 }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkcbfpreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        boundarytype: args.boundaryType,
      });
      return shapeDlpResult(data, args.raw, CBFP_FIELDS, "falsePositives");
    }
  );

  server.registerTool(
    "dlp_network_dcfp_report",
    {
      title: "DLP data rule false positives report",
      description:
        "Retrieves false positives reported by endpoints for data rule violations, listing each triggered DLP " +
        "data rule with the number of endpoints that reported false positives against it. Supports filtering by " +
        "rule class and pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        ruleClass: ruleClassInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { ruleClass?: string }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkdcfpreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        ruleClass: args.ruleClass,
      });
      return shapeDlpResult(data, args.raw, DCFP_FIELDS, "falsePositives");
    }
  );

  server.registerTool(
    "dlp_network_device_report",
    {
      title: "DLP network devices report",
      description:
        "Retrieves all hardware devices (by device instance path) known to DLP with their custom group " +
        "association count. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkdevicereport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, DEVICE_FIELDS, "devices");
    }
  );

  server.registerTool(
    "dlp_network_email_report",
    {
      title: "DLP email domains report",
      description:
        "Retrieves all email domains deployed in DLP policies across the network, with the number of custom " +
        "groups each domain is associated with. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkemailreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, EMAIL_FIELDS, "emailDomains");
    }
  );

  server.registerTool(
    "dlp_network_printer_report",
    {
      title: "DLP network printers report",
      description:
        "Retrieves all network printers deployed in DLP policies, with the number of custom groups each printer " +
        "is associated with. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkprinterreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, PRINTER_FIELDS, "networkPrinters");
    }
  );

  server.registerTool(
    "dlp_network_product_report",
    {
      title: "DLP enterprise applications report",
      description:
        "Retrieves all enterprise applications deployed in DLP policies across the network, with the number of " +
        "custom groups each application is associated with. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkproductreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, PRODUCT_FIELDS, "applications");
    }
  );

  server.registerTool(
    "dlp_network_rules_report",
    {
      title: "DLP deployed rules report",
      description:
        "Retrieves all DLP data rules deployed in the network, with the number of custom groups each rule is " +
        "associated with. Supports filtering by rule class and pagination.",
      inputSchema: {
        page: pageInput,
        pageLimit: pageLimitInput,
        ruleClass: ruleClassInput,
        raw: rawInput,
      },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs & { ruleClass?: string }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkrulesreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
        ruleClass: args.ruleClass,
      });
      return shapeDlpResult(data, args.raw, RULES_FIELDS, "rules");
    }
  );

  server.registerTool(
    "dlp_network_usb_printer_report",
    {
      title: "DLP USB printers report",
      description:
        "Retrieves all USB printers deployed in DLP policies (by device instance path), with the number of " +
        "custom groups each USB printer is associated with. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkusbprinterreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, USB_PRINTER_FIELDS, "usbPrinters");
    }
  );

  server.registerTool(
    "dlp_network_web_domain_report",
    {
      title: "DLP web domains report",
      description:
        "Retrieves all web domains deployed in DLP policies across the network, with the number of custom " +
        "groups each domain is associated with. Supports pagination.",
      inputSchema: { page: pageInput, pageLimit: pageLimitInput, raw: rawInput },
      annotations: READ_ONLY,
    },
    async (args: PagedArgs) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<DlpReportResponse>("/api/1.4/reports/dlp/networkwebdomainreport", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      return shapeDlpResult(data, args.raw, WEB_DOMAIN_FIELDS, "webDomains");
    }
  );
}
