import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { toToolResult } from "../shaping.js";
import { READ_ONLY } from "./annotations.js";

/**
 * DEX (Digital Employee Experience) tools — the `/intelligence/api/*` scoring
 * endpoints. All seven operations are GETs that return small, purpose-built
 * JSON bodies (not the wide DB-style record arrays of the /api/1.4 endpoints),
 * so responses are passed through via toToolResult without projection, and no
 * pagination applies.
 *
 * Health values used throughout DEX responses (scoreHealth / health /
 * categoryHealth): 0 = poor, 1 = average, 2 = good, 3 = unknown.
 */

const scoreProfileIdInput = z
  .number()
  .int()
  .positive()
  .describe(
    "Numeric DEX score profile ID. Obtain it from dex_meta (its lastVisitedProfileId field) or from the " +
      "score profiles configured in the Endpoint Central DEX console."
  );

const agentResourceIdInput = z
  .number()
  .int()
  .positive()
  .describe("Numeric resource_id of the target computer, from som_computers_list.");

type DeviceScoreArgs = { scoreProfileId: number; agentResourceId: number };

const METRIC_FILTER_VALUES = ["all", "metricsWithIssues"] as const;

type DeviceMetricsArgs = DeviceScoreArgs & {
  filterType?: (typeof METRIC_FILTER_VALUES)[number];
};

type LatestExperienceArgs = {
  scoreProfileId: number;
  resourceId?: number;
  branchOffice?: number;
  cgFilter?: number;
};

interface DexAddonResponse {
  totalDevicesCount?: number;
  moduleStatus?: number;
  eiManagedDevicesCount?: number;
}

interface DexDeviceProfileResponse {
  baselineScore?: string;
  experienceScore?: string;
  os?: string;
  osVersion?: string;
  lastLogonUser?: string;
  name?: string;
  model?: string;
  scoreHealth?: number;
  lastUpdatedTime?: string;
  type?: string;
  platform?: string;
}

interface DexMetricNode {
  metric_id?: string;
  score?: string;
  scoreDisplayName?: string;
  scoreHealth?: number;
  primaryRenderText?: string;
}

interface DexIndicatorNode {
  indicator?: string;
  metrics?: DexMetricNode[];
}

interface DexCategoryScore {
  categoryName?: string;
  categoryScore?: string;
  categoryHealth?: number | null;
}

interface DexLatestExperienceResponse {
  score?: number;
  health?: number;
  isCustomCategoriesExists?: boolean;
  category?: DexCategoryScore[];
  baseLineScore?: number;
  changeFromPreviousDay?: number;
}

interface DexLastUpdatedTimeResponse {
  lastUpdatedTime?: string;
}

interface DexNextDataProcessTimeResponse {
  nextDataProcessingTime?: string;
}

export function registerDexTools(server: McpServer): void {
  server.registerTool(
    "dex_addon_info",
    {
      title: "DEX addon status",
      description:
        "Retrieves the Digital Employee Experience (DEX) addon module status and device counts: moduleStatus " +
        "(0 disabled, 1 enabled, 2 selectively enabled), total managed devices, and how many devices DEX manages. " +
        "Useful as a first check that DEX is licensed and active before calling the score tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<DexAddonResponse>("/intelligence/api/addon");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "dex_meta",
    {
      title: "DEX module configuration",
      description:
        "Retrieves DEX module configuration and feature flags: ruleset ID, extension/chatbot/timeline/sentiment " +
        "status, whether initial score data has been prepared, and lastVisitedProfileId — a score profile ID " +
        "usable as scoreProfileId in the dex_device_experience, dex_device_experience_metrics, and " +
        "dex_latest_experience_scores tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<Record<string, unknown>>("/intelligence/api/common/meta");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "dex_device_experience",
    {
      title: "Device experience score and details",
      description:
        "Retrieves the DEX experience overview for one device under a score profile: baseline and current " +
        "experience scores, overall score health (0 poor, 1 average, 2 good, 3 unknown), OS name/version, device " +
        "name, model, type, platform, last logged-on user, and when the score was last updated.",
      inputSchema: {
        scoreProfileId: scoreProfileIdInput,
        agentResourceId: agentResourceIdInput,
      },
      annotations: READ_ONLY,
    },
    async (args: DeviceScoreArgs) => {
      const data = await httpClient.get<DexDeviceProfileResponse>(
        `/intelligence/api/score/device/profile/${args.scoreProfileId}/${args.agentResourceId}`
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "dex_device_experience_metrics",
    {
      title: "Device experience metric breakdown",
      description:
        "Retrieves the indicator-wise DEX metric breakdown for one device under a score profile: for each " +
        "indicator (e.g. Device Performance, Application Reliability) the individual metrics with their score, " +
        "health (0 poor, 1 average, 2 good, 3 unknown), display name, and a human-readable summary line. " +
        "Optionally restrict to only the metrics that currently have issues.",
      inputSchema: {
        scoreProfileId: scoreProfileIdInput,
        agentResourceId: agentResourceIdInput,
        filterType: z
          .enum(METRIC_FILTER_VALUES)
          .optional()
          .describe(
            'Which metrics to list: "all" for every metric, or "metricsWithIssues" for only metrics with issues. ' +
              "Defaults to the server's behavior when omitted (all metrics)."
          ),
      },
      annotations: READ_ONLY,
    },
    async (args: DeviceMetricsArgs) => {
      const data = await httpClient.get<DexIndicatorNode[]>(
        `/intelligence/api/score/device/profile/${args.scoreProfileId}/${args.agentResourceId}/nodes`,
        { filterType: args.filterType }
      );
      return toToolResult({ indicators: data ?? [] });
    }
  );

  server.registerTool(
    "dex_latest_experience_scores",
    {
      title: "Latest experience score for a profile",
      description:
        "Retrieves the most recent DEX experience score for a score profile: overall score, health (0 poor, " +
        "1 average, 2 good, 3 unknown), baseline score, change from the previous day, and per-category scores " +
        "(Device Performance, Application Reliability, etc.). Optionally scope the score to a single device, a " +
        "remote office, or a custom group.",
      inputSchema: {
        scoreProfileId: scoreProfileIdInput,
        resourceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional: scope to one device by its resource_id, from som_computers_list."
          ),
        branchOffice: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional: scope to one remote/branch office by its resource_id, from som_remote_offices_list."
          ),
        cgFilter: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional: scope to one custom group by its group ID, from Endpoint Central's custom group listing " +
              "(/api/1.4/customgroup/getCGList)."
          ),
      },
      annotations: READ_ONLY,
    },
    async (args: LatestExperienceArgs) => {
      const data = await httpClient.get<DexLatestExperienceResponse>(
        `/intelligence/api/score/${args.scoreProfileId}/latestExperience`,
        {
          resourceId: args.resourceId,
          branchOffice: args.branchOffice,
          cgFilter: args.cgFilter,
        }
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "dex_last_score_update_time",
    {
      title: "Last score processing time",
      description:
        "Retrieves the most recent time the DEX experience score summary was generated. Useful for judging how " +
        "fresh the scores returned by the other dex_* tools are.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<DexLastUpdatedTimeResponse>(
        "/intelligence/api/score/lastUpdatedTime"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "dex_next_score_update_time",
    {
      title: "Next score processing time",
      description:
        "Retrieves the scheduled time of the next DEX experience score summary generation — i.e. when the scores " +
        "returned by the other dex_* tools will next be refreshed.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<DexNextDataProcessTimeResponse>(
        "/intelligence/api/score/nextDataProcessTime"
      );
      return toToolResult(data);
    }
  );
}
