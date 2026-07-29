import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient, assertSafePathSegment } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { projectList, toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * Both /dcapi/reports/queryReports and /dcapi/reports/customReports return a
 * one-level tree: a root node whose `children` are the actual reports, each
 * with an `id`/`label` and a `properties` bag (owner, viewName, description,
 * lastModified, ...). We flatten children into plain records so the standard
 * projection helpers apply; `raw: true` returns the untouched tree.
 */
interface ReportTreeNode {
  parent: string | null;
  children: ReportTreeNode[] | null;
  root: boolean;
  id: string;
  label: string;
  leaf: boolean;
  properties?: Record<string, unknown>;
}

function flattenReportTree(root: ReportTreeNode): Record<string, unknown>[] {
  return (root.children ?? []).map((child) => ({
    id: child.id,
    label: child.label,
    ...(child.properties ?? {}),
  }));
}

const QUERY_REPORT_FIELDS = ["id", "label", "owner", "viewName", "description", "lastModified"] as const;

const CUSTOM_REPORT_FIELDS = ["id", "label", "owner", "viewName", "description", "lastModified"] as const;

const rawOnlyInput = {
  raw: z
    .boolean()
    .optional()
    .describe("Return the full raw report-tree response instead of the flattened, curated record list."),
};

type RawOnlyArgs = { raw?: boolean };

interface QueryReportDataResponse {
  data?: Record<string, unknown>[];
  reportName?: string;
  columnDetails?: { columnDataType?: number; columnName?: string }[];
}

const queryReportDataInput = {
  reportId: z
    .number()
    .int()
    .positive()
    .describe("Numeric query report ID — the `id` of a report returned by reports_query_reports_list."),
  startIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Starting row index to fetch from. Increment by `limit` on each call to page through the report."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max rows per response (server cap is 1000). Defaults to the server's configured default page size."),
};

type QueryReportDataArgs = { reportId: number; startIndex?: number; limit?: number };

/**
 * Raw /{crview}.ec responses carry a lot of UI-rendering baggage (column CSS,
 * sort state, table template config). The condensed default keeps only the
 * column list, the row values, and the navigation summary; `raw: true`
 * returns everything.
 */
interface CustomReportNavigation {
  total?: number;
  pages?: number;
  currentPage?: number;
  itemsPerPage?: number;
  from?: number;
  to?: number;
  [key: string]: unknown;
}

interface CustomReportViewResponse {
  name?: string;
  headers?: Record<string, unknown>[];
  data?: { cells?: { value?: unknown }[]; rowIdx?: number }[];
  colList?: { name?: string; display?: string; isVisible?: boolean }[];
  navigation?: CustomReportNavigation;
  TableModel?: { tableModelRows?: unknown[][]; viewColumns?: string[] };
  [key: string]: unknown;
}

const customReportDataInput = {
  crview: z
    .string()
    .min(1)
    .describe(
      "Custom report view name — the `viewName` of a report returned by reports_custom_reports_list " +
        "(e.g. CRVIEW_1746706833342)."
    ),
  firstIndex: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "First row index to fetch, 1-based and inclusive (API param _FI). Increment by pageLimit to fetch the " +
        "next page of rows."
    ),
  pageLimit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Rows per page (API param _PL; server default 25, cap 500). Defaults to the server's configured " +
        "default page size, clamped to 500."
    ),
  raw: z
    .boolean()
    .optional()
    .describe(
      "Return the full raw table response (column CSS, sort state, template config) instead of the " +
        "condensed columns/rows/navigation view."
    ),
};

type CustomReportDataArgs = { crview: string; firstIndex?: number; pageLimit?: number; raw?: boolean };

function customReportPaginationNote(nav: CustomReportNavigation | undefined): string | undefined {
  if (!nav || nav.total === undefined || nav.from === undefined || nav.to === undefined) return undefined;
  if (nav.to < nav.total) {
    return (
      `Showing rows ${nav.from}-${nav.to} of ${nav.total}. ` +
      `Call again with firstIndex: ${nav.to + 1} to continue.`
    );
  }
  return `Showing rows ${nav.from}-${nav.to} of ${nav.total} (end of report).`;
}

interface CustomGroupListResponse {
  message_response?: {
    getcglist?: {
      response?: {
        result?: { cg_list?: Record<string, unknown>[] };
        message?: string;
      };
      operation_status?: string;
    };
  };
}

const CUSTOM_GROUP_FIELDS = [
  "group_id",
  "group_name",
  "group_type",
  "group_category",
  "domain_name",
  "group_created_on",
  "group_modified_on",
] as const;

interface ServerPropertiesResponse {
  message_response?: {
    serverproperties?: {
      branch_offices?: string[];
      domains?: string[];
      custom_groups?: string[];
    };
  };
}

export function registerReportsTools(server: McpServer): void {
  server.registerTool(
    "reports_query_reports_list",
    {
      title: "List query reports",
      description:
        "Retrieves all query reports defined in Endpoint Central with their report ID, label, owner, view name, " +
        "description, and last-modified time. Use a report's id with reports_query_report_data to fetch its rows.",
      inputSchema: rawOnlyInput,
      annotations: READ_ONLY,
    },
    async (args: RawOnlyArgs) => {
      const data = await httpClient.get<ReportTreeNode>(
        "/dcapi/reports/queryReports",
        undefined,
        "application/allQueryReports.v1+json"
      );
      if (args.raw) return toToolResult(data);
      const reports = projectList(flattenReportTree(data), QUERY_REPORT_FIELDS);
      return toToolResult({ total: reports.length, reports });
    }
  );

  server.registerTool(
    "reports_query_report_data",
    {
      title: "Fetch query report data",
      description:
        "Fetches the rows and column metadata of a specific query report by its numeric report ID (from " +
        "reports_query_reports_list). Rows are returned as-is: their shape and output size depend entirely on " +
        "the report's underlying query, so prefer a small limit on first call.",
      inputSchema: queryReportDataInput,
      annotations: READ_ONLY,
    },
    async (args: QueryReportDataArgs) => {
      const { defaultPageLimit } = loadConfig();
      const limit = args.limit ?? defaultPageLimit;
      const data = await httpClient.get<QueryReportDataResponse>(
        `/dcapi/reports/queryReports/${args.reportId}/data`,
        {
          startIndex: args.startIndex,
          limit,
        },
        "application/queryResult.v1+json"
      );
      const rows = data.data ?? [];
      const note =
        rows.length >= limit
          ? `Returned ${rows.length} rows (limit ${limit}); more may be available — call again with ` +
            `startIndex: ${(args.startIndex ?? 0) + limit} to continue.`
          : undefined;
      return toToolResult(
        { reportName: data.reportName, columnDetails: data.columnDetails ?? [], rows },
        note
      );
    }
  );

  server.registerTool(
    "reports_custom_reports_list",
    {
      title: "List custom reports",
      description:
        "Retrieves all custom reports available to the API user with their report ID, label, owner, view name, " +
        "description, and last-modified time. Use a report's viewName with reports_custom_report_data to fetch " +
        "its rows.",
      inputSchema: rawOnlyInput,
      annotations: READ_ONLY,
    },
    async (args: RawOnlyArgs) => {
      const data = await httpClient.get<ReportTreeNode>(
        "/dcapi/reports/customReports",
        undefined,
        "application/allCustomReports.v1+json"
      );
      if (args.raw) return toToolResult(data);
      const reports = projectList(flattenReportTree(data), CUSTOM_REPORT_FIELDS);
      return toToolResult({ total: reports.length, reports });
    }
  );

  server.registerTool(
    "reports_custom_report_data",
    {
      title: "Fetch custom report data",
      description:
        "Fetches the rows of a specific custom report by its view name (the viewName from " +
        "reports_custom_reports_list). Columns and output size depend entirely on how the report was built, so " +
        "prefer a small pageLimit on first call. Default output is condensed to columns, row values, and " +
        "navigation info; raw: true returns the full table response.",
      inputSchema: customReportDataInput,
      annotations: READ_ONLY,
    },
    async (args: CustomReportDataArgs) => {
      assertSafePathSegment(args.crview, "crview");
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.post<CustomReportViewResponse>(`/${args.crview}.ec`, undefined, {
        _FI: args.firstIndex,
        _PL: args.pageLimit ?? Math.min(defaultPageLimit, 500),
      });
      const note = customReportPaginationNote(data.navigation);
      if (args.raw) return toToolResult(data, note);

      const columns = (data.colList ?? []).map((col) => ({ name: col.name, display: col.display }));
      const rows =
        data.TableModel?.tableModelRows ??
        (data.data ?? []).map((row) => (row.cells ?? []).map((cell) => cell.value));
      const nav = data.navigation;
      return toToolResult(
        {
          reportView: data.name,
          columns,
          rows,
          navigation: nav
            ? {
                total: nav.total,
                pages: nav.pages,
                currentPage: nav.currentPage,
                itemsPerPage: nav.itemsPerPage,
                from: nav.from,
                to: nav.to,
              }
            : undefined,
        },
        note
      );
    }
  );

  server.registerTool(
    "customgroup_list",
    {
      title: "List custom groups",
      description:
        "Retrieves all custom groups with their group ID, name, type (e.g. Computers), category (e.g. Static, " +
        "Dynamic), associated domain, and creation/modification timestamps (epoch millis).",
      inputSchema: {
        raw: z
          .boolean()
          .optional()
          .describe("Return full unprojected group records instead of the curated default field set."),
      },
      annotations: READ_ONLY,
    },
    async (args: { raw?: boolean }) => {
      const data = await httpClient.get<CustomGroupListResponse>("/api/1.4/customgroup/getCGList");
      const groups = data.message_response?.getcglist?.response?.result?.cg_list ?? [];
      const shaped = args.raw ? groups : projectList(groups, CUSTOM_GROUP_FIELDS);
      return toToolResult({ total: groups.length, customGroups: shaped });
    }
  );

  server.registerTool(
    "server_properties",
    {
      title: "Server properties",
      description:
        "Retrieves the Endpoint Central server's environment summary: the domains, custom group names, and " +
        "branch offices it manages. Useful for discovering valid domain/branch-office/group values to use in " +
        "other tools' filters.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<ServerPropertiesResponse>("/api/1.4/desktop/serverproperties");
      return toToolResult(data.message_response ?? {});
    }
  );
}
