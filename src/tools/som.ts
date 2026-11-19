import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { assertConfirmed } from "../errors.js";
import { paginationNote, projectList, toToolResult } from "../shaping.js";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.js";

/**
 * Default projected fields for /api/1.4/som/computers records. The raw API
 * returns 50+ fields per computer (DB-style names like
 * "resourcemacip.dhcp_server_ip_address"); this keeps the default response
 * readable while `raw: true` still exposes everything when needed.
 */
const DEFAULT_FIELDS = [
  "resource_id",
  "resource_name",
  "fqdn_name",
  "domain_netbios_name",
  "ip_address",
  "mac_address",
  "os_name",
  "os_platform_name",
  "os_version",
  "service_pack",
  "branch_office_name",
  "installation_status",
  "status_label",
  "managed_status",
  "computer_live_status",
  "agent_version",
  "agent_last_contact_time",
  "owner",
  "owner_email_id",
  "description",
] as const;

// installstatusfilter: 21 yet-to-install, 22 installed, 23 uninstalled, 29 install failure, 31 uninstall failure
const INSTALL_STATUS_VALUES = ["21", "22", "23", "29", "31"] as const;
// liveStatusfilter: 1 live, 2 down, 3 unknown
const LIVE_STATUS_VALUES = [1, 2, 3] as const;
// platformfilter: 0 unknown, 1 windows, 2 mac, 3 linux
const PLATFORM_VALUES = ["0", "1", "2", "3"] as const;

const somComputersListInput = {
  page: z.number().int().min(1).optional().describe("Page number to retrieve. Default is 1."),
  pageLimit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max records per page (server cap is 1000). Defaults to the server's configured default page size."),
  residFilter: z.string().optional().describe("Filter to a specific computer by its resource_id."),
  computerNameFilter: z.string().optional().describe("Filter by exact computer name."),
  searchComputerFilter: z.string().optional().describe("Filter to computer names containing this substring."),
  fqdnFilter: z.string().optional().describe("Filter by fully qualified domain name, e.g. host.corp.example.com."),
  domainFilter: z.string().optional().describe("Filter by the NetBIOS domain the computer is mapped to."),
  branchOfficeFilter: z.string().optional().describe("Filter by the remote/branch office the computer is mapped to."),
  serviceTagFilter: z.string().optional().describe("Filter by the computer's unique service tag."),
  platformFilter: z
    .enum(PLATFORM_VALUES)
    .optional()
    .describe("Filter by OS platform: 0 unknown, 1 Windows, 2 Mac, 3 Linux."),
  installStatusFilter: z
    .enum(INSTALL_STATUS_VALUES)
    .optional()
    .describe(
      "Filter by agent install status: 21 yet-to-install, 22 installed, 23 uninstalled, 29 install failure, 31 uninstall failure."
    ),
  liveStatusFilter: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe("Filter by live status: 1 live, 2 down, 3 unknown."),
  agentContactFilter: z
    .enum(["equal_3_day", "4_day_to_7_day", "8_day_to_15_day", "16_day_to_30_day", "greater_30_day"])
    .optional()
    .describe("Filter by how recently the agent last contacted the server."),
  raw: z
    .boolean()
    .optional()
    .describe("Return the full, unprojected record for each computer instead of the curated default field set."),
};

type SomComputersListArgs = {
  page?: number;
  pageLimit?: number;
  residFilter?: string;
  computerNameFilter?: string;
  searchComputerFilter?: string;
  fqdnFilter?: string;
  domainFilter?: string;
  branchOfficeFilter?: string;
  serviceTagFilter?: string;
  platformFilter?: (typeof PLATFORM_VALUES)[number];
  installStatusFilter?: (typeof INSTALL_STATUS_VALUES)[number];
  liveStatusFilter?: 1 | 2 | 3;
  agentContactFilter?: string;
  raw?: boolean;
};

interface SomComputersResponse {
  message_type: string;
  message_response: {
    total: number;
    limit: number;
    page: number;
    computers: Record<string, unknown>[];
  };
}

async function somComputersList(args: SomComputersListArgs) {
  const { defaultPageLimit, customerId } = loadConfig();

  const data = await httpClient.get<SomComputersResponse>("/api/1.4/som/computers", {
    customerid: customerId,
    page: args.page,
    pagelimit: args.pageLimit ?? defaultPageLimit,
    residfilter: args.residFilter,
    computernamefilter: args.computerNameFilter,
    searchcomputerfilter: args.searchComputerFilter,
    fqdnfilter: args.fqdnFilter,
    domainfilter: args.domainFilter,
    branchofficefilter: args.branchOfficeFilter,
    servicetagfilter: args.serviceTagFilter,
    platformfilter: args.platformFilter,
    installstatusfilter: args.installStatusFilter,
    liveStatusfilter: args.liveStatusFilter,
    agentcontactfilter: args.agentContactFilter,
  });

  const { total, limit, page, computers } = data.message_response;
  const note = paginationNote({ total, limit, page });
  const shaped = args.raw ? computers : projectList(computers, DEFAULT_FIELDS);

  return toToolResult({ total, page, limit, computers: shaped }, note);
}

interface SomSummaryResponse {
  message_response: { summary: Record<string, unknown> };
}

interface SomRemoteOfficeResponse {
  message_response: {
    total?: number;
    limit?: number;
    page?: number;
    remoteoffice: Record<string, unknown>[];
  };
}

const REMOTE_OFFICE_FIELDS = [
  "resource_id",
  "resource_name",
  "branch_office_name",
  "computer_count",
  "replication_status",
  "remote_office_type",
  "communication_type",
  "ds_server_name",
  "ds_ipaddress",
] as const;

const resourceIdsInput = {
  resourceIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(100)
    .describe("resource_id values of the target computers (from som_computers_list)."),
  confirm: z
    .boolean()
    .optional()
    .describe("Safety gate: must be explicitly set to true to perform this mutating action."),
};

type ResourceIdsArgs = { resourceIds: number[]; confirm?: boolean };

export function registerSomTools(server: McpServer): void {
  server.registerTool(
    "som_computers_list",
    {
      title: "List managed computers",
      description:
        "Retrieves managed computers from Endpoint Central (SoM) with hostname, IP, OS, agent install status, " +
        "live status, and branch office details. Supports filtering and pagination.",
      inputSchema: somComputersListInput,
      annotations: READ_ONLY,
    },
    somComputersList
  );

      const { customerId } = loadConfig();
	  
	server.registerTool(
		"som_summary",
    {
      title: "SoM summary",
      description:
        "Retrieves the Scope of Management summary: total computers, agent installation counts, and live status " +
        "breakdown across the network.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<SomSummaryResponse>(
        "/api/1.4/som/summary",
        { customerid: customerId }
      );
      return toToolResult(data.message_response);
    }
  );

  server.registerTool(
    "som_remote_offices_list",
    {
      title: "List remote offices",
      description:
        "Retrieves all configured remote/branch offices with their replication status, communication type, and " +
        "distribution server details.",
      inputSchema: {
        page: z.number().int().min(1).optional().describe("Page number to retrieve. Default is 1."),
        pageLimit: z.number().int().min(1).max(1000).optional().describe("Max records per page (server cap is 1000)."),
        raw: z.boolean().optional().describe("Return full unprojected records instead of the curated field set."),
      },
      annotations: READ_ONLY,
    },
    async (args: { page?: number; pageLimit?: number; raw?: boolean }) => {
      const { defaultPageLimit } = loadConfig();
      const data = await httpClient.get<SomRemoteOfficeResponse>("/api/1.4/som/remoteoffice", {
        page: args.page,
        pagelimit: args.pageLimit ?? defaultPageLimit,
      });
      const { total, limit, page, remoteoffice } = data.message_response;
      const shaped = args.raw ? remoteoffice : projectList(remoteoffice ?? [], REMOTE_OFFICE_FIELDS);
      return toToolResult(
        { total, page, limit, remoteOffices: shaped },
        paginationNote({ total, page, limit })
      );
    }
  );

  const { enableWriteTools } = loadConfig();
  if (!enableWriteTools) return;

  server.registerTool(
    "som_agent_install",
    {
      title: "Install agent on computers",
      description:
        "Installs the Endpoint Central agent on the given computers (they must already be visible in SoM). " +
        "Mutating action: requires confirm: true.",
      inputSchema: resourceIdsInput,
      annotations: WRITE,
    },
    async (args: ResourceIdsArgs) => {
      assertConfirmed(args.confirm, "Installing the Endpoint Central agent");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/som/computers/installagent", {
        resourceids: args.resourceIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "som_agent_uninstall",
    {
      title: "Uninstall agent from computers",
      description:
        "Uninstalls the Endpoint Central agent from the given computers. The computers stop being managed until " +
        "an agent is reinstalled. Destructive action: requires confirm: true.",
      inputSchema: resourceIdsInput,
      annotations: DESTRUCTIVE,
    },
    async (args: ResourceIdsArgs) => {
      assertConfirmed(args.confirm, "Uninstalling the Endpoint Central agent");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/som/computers/uninstallagent", {
        resourceids: args.resourceIds,
      });
      return toToolResult(data);
    }
  );

  server.registerTool(
    "som_computer_remove",
    {
      title: "Remove computers from SoM",
      description:
        "Removes the given computers from Endpoint Central's Scope of Management entirely, deleting their " +
        "management records. Destructive action: requires confirm: true.",
      inputSchema: resourceIdsInput,
      annotations: DESTRUCTIVE,
    },
    async (args: ResourceIdsArgs) => {
      assertConfirmed(args.confirm, "Removing computers from the Scope of Management");
      const data = await httpClient.post<Record<string, unknown>>("/api/1.4/som/computers/removecomputer", {
        resourceids: args.resourceIds,
      });
      return toToolResult(data);
    }
  );
}
