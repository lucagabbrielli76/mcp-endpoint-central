import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpClient } from "../httpClient.js";
import { loadConfig } from "../config.js";
import { assertConfirmed } from "../errors.js";
import { toToolResult } from "../shaping.js";
import { READ_ONLY, WRITE, DESTRUCTIVE } from "./annotations.js";

/**
 * Custom columns / custom fields tools (dcapi/customColumn/*, dcapi/customFields/*).
 *
 * Intentionally NOT implemented — all three are multipart/form-data file
 * uploads, which don't fit this repo's JSON-only httpClient:
 *   - PUT /dcapi/customFields/computers/{ID}/file (upload a file into a FILE-type
 *     custom field of a specific computer)
 *   - PUT /dcapi/customFields/values/file (upload a file into a FILE-type custom
 *     field, resource selected via query params)
 *   - POST /dcapi/customFields/computers/values/import (bulk CSV import of
 *     custom field values — the CSV travels as a multipart file field)
 *
 * The /dcapi endpoints use vendor media types (e.g.
 * "application/customColumnDetails.v1+json"), passed per call below via
 * httpClient's accept/contentType options. On-prem parity for these endpoints
 * should still be verified against your server's API Explorer.
 */

const TABLE_NAME_VALUES = [
  "ManagedComputerCustomFields",
  "InvSWCustomFields",
  "MspCustomerCustomFields",
] as const;

type TableName = (typeof TABLE_NAME_VALUES)[number];

const tableNameInput = z
  .enum(TABLE_NAME_VALUES)
  .describe(
    "Backing table of the custom field: ManagedComputerCustomFields for fields created in the Computer view, " +
      "InvSWCustomFields for fields created in the Software view, MspCustomerCustomFields for MSP customer fields."
  );

const confirmInput = z
  .boolean()
  .optional()
  .describe("Safety gate: must be explicitly set to true to perform this mutating action.");

const resourceIdInput = z
  .number()
  .int()
  .positive()
  .describe("Numeric resource_id of the computer (from som_computers_list).");

interface CustomColumnPageResponse {
  customDataTypeList?: string[];
  containsCustomDataType?: string;
}

interface UdtLengthResponse {
  lengthOfUDT?: string;
}

interface CustomColumnStatusResponse {
  message?: string;
  status?: string;
}

interface CustomDataTypeResponse {
  dataType?: string;
  message?: string;
  status?: string;
}

interface UpdateCustomFieldResponse {
  statusMessage?: string;
  status?: string;
}

type CustomColumnAddArgs = {
  columnName: string;
  dataType: string;
  tableName: TableName;
  size?: number;
  defaultValue?: string;
  description?: string;
  isPII?: boolean;
  confirm?: boolean;
};

type CustomColumnModifyArgs = CustomColumnAddArgs & {
  actualColumnName: string;
  forceUpdate?: boolean;
};

export function registerCustomFieldTools(server: McpServer): void {
  server.registerTool(
    "custom_column_data_types_list",
    {
      title: "List custom data types",
      description:
        "Retrieves the list of existing custom data type names defined for custom fields, and whether any " +
        "custom data types exist at all. Useful before creating or updating custom fields.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const data = await httpClient.get<CustomColumnPageResponse>(
        "/dcapi/customColumn/customColumnPage",
        undefined,
        "application/customColumnDetails.v1+json"
      );
      return toToolResult({
        customDataTypeList: data.customDataTypeList ?? [],
        containsCustomDataType: data.containsCustomDataType,
      });
    }
  );

  server.registerTool(
    "custom_column_udt_length",
    {
      title: "Get user data type length",
      description:
        "Retrieves the maximum number of characters allowed for the user data type of a specific custom field.",
      inputSchema: {
        actualColumnName: z
          .string()
          .describe(
            "The actual (internal) column name of the custom field, e.g. COL301 — obtain it from the " +
              "columnName key returned by custom_field_metadata_list."
          ),
        tableName: tableNameInput,
      },
      annotations: READ_ONLY,
    },
    async (args: { actualColumnName: string; tableName: TableName }) => {
      const data = await httpClient.get<UdtLengthResponse>(
        "/dcapi/customColumn/udtLength",
        { actualColumnName: args.actualColumnName, tableName: args.tableName },
        "application/udtLengthDetails.v1+json"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_column_udt_name_exists",
    {
      title: "Check custom data type name existence",
      description:
        "Checks whether a custom (user) data type with the given name is already defined in the system.",
      inputSchema: {
        udtName: z.string().describe("The name of the custom data type to check for existence."),
      },
      annotations: READ_ONLY,
    },
    async (args: { udtName: string }) => {
      // The spec documents a 200 response with no body schema for this
      // endpoint — pass whatever the server returns straight through.
      const data = await httpClient.get<unknown>(
        "/dcapi/customColumn/udtNameExists",
        { udtName: args.udtName },
        "application/udtExistsDetails.v1+json"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_field_values_get",
    {
      title: "Get custom field values for a resource",
      description:
        "Retrieves the custom field values linked to a specific resource (owner, location, product number, " +
        "shipping/expiry dates, notes, search tag, and any user-defined fields).",
      inputSchema: {
        resourceId: z
          .number()
          .int()
          .positive()
          .describe(
            "Numeric resource ID: a computer's resource_id (from som_computers_list) for computer-view fields, " +
              "or a software_id (from the inventory software list) for software-view fields."
          ),
      },
      annotations: READ_ONLY,
    },
    async (args: { resourceId: number }) => {
      const data = await httpClient.get<Record<string, unknown>>(
        `/dcapi/customColumn/${args.resourceId}/customFields`,
        undefined,
        "application/customFields.v1+json"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_field_metadata_list",
    {
      title: "List custom field metadata for a computer",
      description:
        "Retrieves the custom field metadata linked to a specific computer: display name, actual column name " +
        "(e.g. COL301), data type, max allowed size, input format, default and current values, and PII flag. " +
        "Use this to discover the actualColumnName needed by the custom column modify/remove tools.",
      inputSchema: {
        resourceId: resourceIdInput,
      },
      annotations: READ_ONLY,
    },
    async (args: { resourceId: number }) => {
      const data = await httpClient.get<Record<string, unknown>[]>(
        `/dcapi/customFields/computers/${args.resourceId}`,
        undefined,
        "application/customFields.v1+json"
      );
      return toToolResult({ customFields: data ?? [] });
    }
  );

  const { enableWriteTools } = loadConfig();
  if (!enableWriteTools) return;

  server.registerTool(
    "custom_column_add",
    {
      title: "Add custom field",
      description:
        "Creates a new custom field (custom column) with the given name, data type, and attributes in the " +
        "Computer or Software view. Mutating action: requires confirm: true.",
      inputSchema: {
        columnName: z
          .string()
          .describe("Display name of the new custom field (letters, digits, underscores, spaces)."),
        dataType: z
          .string()
          .describe(
            "Data type of the field: CHAR, INTEGER, BOOLEAN, FILE, or the name of a custom data type " +
              "created via custom_column_data_type_create."
          ),
        tableName: tableNameInput,
        size: z
          .number()
          .int()
          .min(1)
          .max(99999)
          .optional()
          .describe("Maximum length/size of the field value (up to 5 digits)."),
        defaultValue: z.string().optional().describe("Default value assigned to the field."),
        description: z.string().optional().describe("Human-readable description of the field."),
        isPII: z
          .boolean()
          .optional()
          .describe("Mark the field as holding personally identifiable / sensitive data."),
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: CustomColumnAddArgs) => {
      assertConfirmed(args.confirm, "Adding a custom field");
      const data = await httpClient.post<CustomColumnStatusResponse>("/dcapi/customColumn/addCustomColumn", {
        size: args.size,
        defaultValue: args.defaultValue,
        dataType: args.dataType,
        description: args.description,
        isPII: args.isPII,
        tableName: args.tableName,
        columnName: args.columnName,
      }, undefined, "application/addCustomColumnStatus.v1+json", "application/customColumnDetails.v1+json");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_column_data_type_create",
    {
      title: "Create custom data type",
      description:
        "Creates a new custom data type for custom fields by specifying its name, a base type (CHAR or " +
        "INTEGER), and optionally size, allowed values, and a default value. Mutating action: requires " +
        "confirm: true.",
      inputSchema: {
        dataType: z
          .string()
          .describe(
            'Name of the new custom data type to create (e.g. "Chartype"). Per the spec example this is the ' +
              "new type's name, while baseType supplies the underlying primitive."
          ),
        baseType: z.enum(["INTEGER", "CHAR"]).describe("Underlying base type of the custom data type."),
        allowedValues: z
          .string()
          .optional()
          .describe("Comma-separated list of values the data type allows."),
        size: z
          .number()
          .int()
          .min(1)
          .max(99999)
          .optional()
          .describe("Maximum length/size for values of this data type (up to 5 digits)."),
        defaultValue: z.string().optional().describe("Default value for the data type."),
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: {
      dataType: string;
      baseType: "INTEGER" | "CHAR";
      allowedValues?: string;
      size?: number;
      defaultValue?: string;
      confirm?: boolean;
    }) => {
      assertConfirmed(args.confirm, "Creating a custom data type");
      const data = await httpClient.post<CustomDataTypeResponse>("/dcapi/customColumn/customDataType", {
        allowedValues: args.allowedValues,
        size: args.size,
        defaultValue: args.defaultValue,
        dataType: args.dataType,
        baseType: args.baseType,
      }, undefined, "application/newCustomDataDetails.v1+json");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_column_modify",
    {
      title: "Modify custom field",
      description:
        "Updates the properties (name, data type, size, default value, description, PII flag) of an existing " +
        "custom field, identified by its actual column name. Optionally forces the update even if the field " +
        "is used in reports or dependent columns. Mutating action: requires confirm: true.",
      inputSchema: {
        actualColumnName: z
          .string()
          .describe(
            "Internal column name of the field to modify, e.g. COL301 (the columnName value from " +
              "custom_field_metadata_list)."
          ),
        columnName: z.string().describe("Display name of the custom field (new or unchanged)."),
        dataType: z
          .string()
          .describe(
            "Data type of the field: CHAR, INTEGER, BOOLEAN, FILE, or the name of a custom data type."
          ),
        tableName: tableNameInput,
        size: z
          .number()
          .int()
          .min(1)
          .max(99999)
          .optional()
          .describe("Maximum length/size of the field value (up to 5 digits)."),
        defaultValue: z.string().optional().describe("Default value assigned to the field."),
        description: z.string().optional().describe("Human-readable description of the field."),
        isPII: z
          .boolean()
          .optional()
          .describe("Mark the field as holding personally identifiable / sensitive data."),
        forceUpdate: z
          .boolean()
          .optional()
          .describe("Apply the update even if the field is used in other reports or dependent columns."),
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: CustomColumnModifyArgs) => {
      assertConfirmed(args.confirm, "Modifying a custom field");
      const data = await httpClient.put<CustomColumnStatusResponse>(
        "/dcapi/customColumn/modifyCustomColumn",
        {
          size: args.size,
          actualColumnName: args.actualColumnName,
          defaultValue: args.defaultValue,
          dataType: args.dataType,
          description: args.description,
          isPII: args.isPII,
          tableName: args.tableName,
          columnName: args.columnName,
        },
        { forceUpdate: args.forceUpdate },
        "application/editCustomColumnStatus.v1+json",
        "application/customColumnDetails.v1+json"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_column_value_modify",
    {
      title: "Modify custom field value for resources",
      description:
        "Sets the value of a custom field for the selected resources, overwriting any existing value. " +
        "Mutating action: requires confirm: true.",
      inputSchema: {
        actualColumnName: z
          .string()
          .describe(
            "Internal column name of the custom field to set, e.g. COL301 (the columnName value from " +
              "custom_field_metadata_list)."
          ),
        customColumnValue: z
          .string()
          .describe("New value to store in the custom field for the selected resources."),
        resourceName: z
          .string()
          .describe(
            'Identifier column keying the selected resources; the spec example uses "RESOURCE_ID" for ' +
              "computer-view fields."
          ),
        selectedResources: z
          .string()
          .describe('Resource ID(s) to update, passed as a string (spec example: "301").'),
        tableName: tableNameInput,
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: {
      actualColumnName: string;
      customColumnValue: string;
      resourceName: string;
      selectedResources: string;
      tableName: TableName;
      confirm?: boolean;
    }) => {
      assertConfirmed(args.confirm, "Modifying a custom field value for resources");
      // Spec documents a bare 200 with no response body schema.
      const data = await httpClient.put<unknown>("/dcapi/customColumn/modifyCustomColumnValue", {
        actualColumnName: args.actualColumnName,
        customColumnValue: args.customColumnValue,
        resourceName: args.resourceName,
        selectedResources: args.selectedResources,
        tableName: args.tableName,
      }, undefined, "application/modifyCustomColumn.v1+json");
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_column_remove",
    {
      title: "Remove custom field",
      description:
        "Deletes the specified custom field and all its stored values across resources. Optionally forces " +
        "deletion even if the field is used in reports or dependent columns. Destructive action: requires " +
        "confirm: true.",
      inputSchema: {
        actualColumnName: z
          .string()
          .describe(
            "Internal column name of the field to delete, e.g. COL2 (the columnName value from " +
              "custom_field_metadata_list)."
          ),
        tableName: tableNameInput,
        forceDelete: z
          .boolean()
          .optional()
          .describe("Delete the field even if it is used in other reports or dependent columns."),
        confirm: confirmInput,
      },
      annotations: DESTRUCTIVE,
    },
    async (args: {
      actualColumnName: string;
      tableName: TableName;
      forceDelete?: boolean;
      confirm?: boolean;
    }) => {
      assertConfirmed(args.confirm, "Deleting a custom field and its data");
      const data = await httpClient.delete<unknown>(
        "/dcapi/customColumn/removeCustomColumn",
        args.forceDelete !== undefined ? { forceDelete: args.forceDelete } : undefined,
        { actualColumnName: args.actualColumnName, tableName: args.tableName },
        "application/deletedCustomColumnDetails.v1+json"
      );
      return toToolResult(data);
    }
  );

  server.registerTool(
    "custom_field_computer_update",
    {
      title: "Update custom field values for a computer",
      description:
        "Updates one or more custom field values on a specific computer by field display name, overwriting " +
        "their current values. Mutating action: requires confirm: true.",
      inputSchema: {
        resourceId: resourceIdInput,
        values: z
          .record(z.unknown())
          .describe(
            'Free-form map of custom field display name to new value, e.g. {"OS Type": "Mac"}. The spec ' +
              "documents no fixed schema for this body — field names come from custom_field_metadata_list."
          ),
        confirm: confirmInput,
      },
      annotations: WRITE,
    },
    async (args: { resourceId: number; values: Record<string, unknown>; confirm?: boolean }) => {
      assertConfirmed(args.confirm, "Updating custom field values for a computer");
      const data = await httpClient.post<UpdateCustomFieldResponse>(
        `/dcapi/customFields/computers/${args.resourceId}/update`,
        args.values,
        undefined,
        "application/updateCustomFieldStatus.v1+json",
        "application/updateCustomField.v1+json"
      );
      return toToolResult(data);
    }
  );
}
