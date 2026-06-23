import type { RuntimeSchema, ToolDefinition, ToolSideEffect } from "../types";

export type CoreToolName =
  | "list_files"
  | "read_files"
  | "grep_files"
  | "glob_files"
  | "edit_file"
  | "write_files"
  | "delete_files"
  | "run_command"
  | "apply_supabase_schema"
  | "start_dev_server"
  | "stop_dev_server"
  | "refresh_preview"
  | "get_site_spec"
  | "get_page_spec"
  | "find_site_node"
  | "update_design_tokens"
  | "resolve_node_source"
  | "refresh_site_index";

type JsonRecord = Record<string, unknown>;

const emptyObjectSchema = (describe: string): RuntimeSchema =>
  objectSchema(describe, (record) => {
    const keys = Object.keys(record);

    if (keys.length > 0) {
      throw new Error(`Expected no arguments, got: ${keys.join(", ")}.`);
    }
  });

const stringArrayOutputSchema = outputSchema("JSON object containing string-array data.");
const toolResultOutputSchema = outputSchema("Structured ToolResult object.");

const INPUT_SCHEMAS: Record<CoreToolName, RuntimeSchema> = {
  apply_supabase_schema: objectSchema(
    'Supabase schema input: {"summary":"string","tables":[...]}',
    (record) => {
      optionalString(record, "summary");
      requiredArray(record, "tables");
    },
  ),
  delete_files: objectSchema(
    'Delete files input: {"paths":["components/Old.tsx"],"summary":"string"}',
    (record) => {
      requiredStringArray(record, "paths");
      optionalString(record, "summary");
    },
  ),
  edit_file: objectSchema(
    'Edit file input: {"path":"app/page.tsx","old_string":"old","new_string":"new","summary":"string"}',
    (record) => {
      requiredString(record, "path");
      requiredString(record, "old_string");
      requiredString(record, "new_string", { allowEmpty: true });
      optionalBoolean(record, "replace_all");
      optionalString(record, "summary");
    },
  ),
  glob_files: objectSchema(
    'Glob files input: {"pattern":"components/**/*.tsx","maxResults":80}',
    (record) => {
      requiredString(record, "pattern");
      optionalInteger(record, "maxResults");
    },
  ),
  grep_files: objectSchema(
    'Grep files input: {"query":"Button","paths":["app"],"maxResults":40,"contextLines":1}',
    (record) => {
      requiredString(record, "query");
      optionalStringArray(record, "paths");
      optionalInteger(record, "maxResults");
      optionalInteger(record, "contextLines");
      optionalBoolean(record, "caseSensitive");
    },
  ),
  list_files: emptyObjectSchema("List files input: {}"),
  read_files: objectSchema(
    'Read files input: {"paths":["app/page.tsx"],"offset":1,"limit":240}',
    (record) => {
      requiredStringArray(record, "paths");
      optionalInteger(record, "offset");
      optionalInteger(record, "limit");
    },
  ),
  refresh_preview: emptyObjectSchema("Refresh preview input: {}"),
  run_command: objectSchema('Run command input: {"command":"npm run build"}', (record) => {
    requiredString(record, "command");
  }),
  start_dev_server: emptyObjectSchema("Start dev server input: {}"),
  stop_dev_server: emptyObjectSchema("Stop dev server input: {}"),
  write_files: objectSchema(
    'Write files input: {"summary":"string","files":[{"path":"app/page.tsx","content":"..."}]}',
    (record) => {
      optionalString(record, "summary");
      requiredArray(record, "files");
    },
  ),
  get_page_spec: objectSchema(
      'Get page spec input: {"route":"/"} or {"pageId":"home"}',
      (record) => {
        if (typeof record.route !== "string" && typeof record.pageId !== "string") {
          throw new Error("get_page_spec requires route or pageId.");
        }
      },
    ),
  get_site_spec: emptyObjectSchema("Get SiteSpec input: {}"),
  find_site_node: objectSchema(
      'Find site node input: {"nodeId":"home.hero","label":"Hero","route":"/","textHint":"pricing"}',
      (record) => {
        const hasSelector = ["nodeId", "label", "route", "textHint"].some(
          (field) => typeof record[field] === "string" && record[field].trim(),
        );

        if (!hasSelector) {
          throw new Error("find_site_node requires nodeId, label, route, or textHint.");
        }
      },
    ),
  update_design_tokens: objectSchema(
      'Update design tokens input: {"tokens":{"colors":{"primary":"#0f766e"}},"summary":"string"}',
      (record) => {
        requiredObject(record, "tokens");
        optionalString(record, "summary");
      },
    ),
  resolve_node_source: objectSchema(
      'Resolve node source input: {"nodeId":"home.hero.cta"}',
      (record) => {
        requiredString(record, "nodeId");
      },
    ),
  refresh_site_index: objectSchema(
      'Refresh site index input: {"reason":"after file edits"}',
      (record) => {
        optionalString(record, "reason");
      },
    ),
};

const OUTPUT_SCHEMAS: Record<CoreToolName, RuntimeSchema> = {
  apply_supabase_schema: toolResultOutputSchema,
  delete_files: toolResultOutputSchema,
  edit_file: toolResultOutputSchema,
  find_site_node: outputSchema("Site node search result with matching nodes."),
  get_page_spec: outputSchema("PageSpec object with nodes."),
  get_site_spec: outputSchema("SiteSpec V1 object."),
  glob_files: stringArrayOutputSchema,
  grep_files: outputSchema("Grep result object with matches and context lines."),
  list_files: outputSchema("Project file tree result object."),
  read_files: outputSchema("Read files result object keyed by project path."),
  refresh_preview: toolResultOutputSchema,
  refresh_site_index: outputSchema("Refresh result with SiteSpec and source map update details."),
  resolve_node_source: outputSchema("Source map entry with path and optional line numbers."),
  run_command: outputSchema("Command result object with exit code and output summary."),
  start_dev_server: toolResultOutputSchema,
  stop_dev_server: toolResultOutputSchema,
  update_design_tokens: outputSchema("Design token update result with changed files and SiteSpec status."),
  write_files: toolResultOutputSchema,
};

const TOOL_METADATA: Array<
  Omit<ToolDefinition, "inputSchema" | "outputSchema">
> = [
  legacyTool("list_files", "Inspect the project file tree.", true, true, "none", false, "never"),
  legacyTool(
    "read_files",
    "Read text files with optional 1-based line offset and line limit. Use before editing existing files.",
    true,
    true,
    "none",
    false,
    "never",
    30_000,
    24_000,
  ),
  legacyTool(
    "grep_files",
    "Search allowed project files for text. Returns path, line number, and matching context.",
    true,
    true,
    "none",
    false,
    "never",
  ),
  legacyTool("glob_files", "Find allowed project files by glob pattern.", true, true, "none", false, "never"),
  legacyTool(
    "edit_file",
    "Make a focused text replacement in a previously read file. old_string must match exactly and be unique unless replace_all is true.",
    false,
    false,
    "workspace_write",
    true,
    "conditional",
  ),
  legacyTool(
    "write_files",
    "Create files or overwrite complete file contents. Existing files must have been read first.",
    false,
    false,
    "workspace_write",
    true,
    "conditional",
  ),
  legacyTool(
    "delete_files",
    "Delete files only when clearly needed. Existing files must have been read first.",
    false,
    false,
    "destructive",
    true,
    "always",
  ),
  legacyTool(
    "run_command",
    "Run one allowed command. Do not pass package names to install commands; edit package.json with exact pinned dependencies instead.",
    false,
    false,
    "external_write",
    false,
    "conditional",
    120_000,
  ),
  legacyTool(
    "apply_supabase_schema",
    "Create missing Supabase tables and add missing columns for the current project. Non-destructive; requires the project .env Supabase DB URL and secret key.",
    false,
    false,
    "database_write",
    false,
    "conditional",
  ),
  legacyTool(
    "start_dev_server",
    "Start the local preview server only when the user explicitly asks to preview or run the app.",
    false,
    false,
    "external_write",
    false,
    "never",
  ),
  legacyTool("stop_dev_server", "Stop the local preview server.", false, false, "external_write", false, "never"),
  legacyTool(
    "refresh_preview",
    "Refresh the preview iframe only when preview is already running and the user explicitly asks to refresh or inspect it.",
    false,
    true,
    "none",
    false,
    "never",
  ),
  legacyTool("get_site_spec", "Read the host-managed SiteSpec for the current project.", true, true, "none", false, "never", 10_000, 32_000),
  legacyTool("get_page_spec", "Read one page from the host-managed SiteSpec.", true, true, "none", false, "never", 10_000, 16_000),
  legacyTool("find_site_node", "Find SiteSpec nodes by id, label, route, or text hint.", true, true, "none", false, "never", 10_000, 16_000),
  legacyTool(
    "update_design_tokens",
    "Update controlled design token CSS variables and synchronize SiteSpec metadata.",
    false,
    false,
    "workspace_write",
    true,
    "conditional",
    30_000,
    12_000,
  ),
  legacyTool("resolve_node_source", "Resolve a SiteSpec node id to source file and line metadata.", true, true, "none", false, "never", 10_000, 8_000),
  legacyTool(
    "refresh_site_index",
    "Ask the host to safely rebuild the SiteSpec and source map from project files.",
    false,
    false,
    "workspace_write",
    true,
    "never",
    30_000,
    16_000,
  ),
];

function legacyTool(
  name: CoreToolName,
  description: string,
  readOnly: boolean,
  concurrencySafe: boolean,
  sideEffect: ToolSideEffect,
  requiresVerification: boolean,
  approvalPolicy: ToolDefinition["approvalPolicy"],
  timeoutMs = 30_000,
  maxOutputBytes = 18_000,
): Omit<ToolDefinition, "inputSchema" | "outputSchema"> {
  return {
    approvalPolicy,
    concurrencySafe,
    description,
    maxOutputBytes,
    name,
    readOnly,
    requiresVerification,
    sideEffect,
    timeoutMs,
  };
}

export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_METADATA.map((tool) => ({
  ...tool,
  inputSchema: INPUT_SCHEMAS[tool.name as CoreToolName],
  outputSchema: OUTPUT_SCHEMAS[tool.name as CoreToolName],
}));

export function getCoreToolDefinition(name: string) {
  return CORE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

export function validateCoreToolInput(name: string, value: unknown) {
  const definition = getCoreToolDefinition(name);

  if (!definition) {
    throw new Error(`Unknown tool: ${name}`);
  }

  definition.inputSchema.validate(value);
}

export function assertReadOnlyBatch(toolNames: string[]) {
  for (const toolName of toolNames) {
    const definition = getCoreToolDefinition(toolName);

    if (!definition?.readOnly || !definition.concurrencySafe) {
      throw new Error(
        `Parallel tool calls may only include read-only concurrency-safe tools; got ${toolName}.`,
      );
    }
  }
}

function objectSchema(
  describe: string,
  validateRecord: (record: JsonRecord) => void,
): RuntimeSchema {
  return {
    describe,
    validate(value: unknown) {
      const record = assertRecord(value);
      validateRecord(record);
    },
  };
}

function outputSchema(describe: string): RuntimeSchema {
  return {
    describe,
    validate(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Tool output must be a JSON object.");
      }
    },
  };
}

function assertRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool input must be a JSON object.");
  }

  return value as JsonRecord;
}

function requiredString(
  record: JsonRecord,
  field: string,
  options: { allowEmpty?: boolean } = {},
) {
  const value = record[field];

  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function optionalString(record: JsonRecord, field: string) {
  if (typeof record[field] !== "undefined" && typeof record[field] !== "string") {
    throw new Error(`${field} must be a string when provided.`);
  }
}

function requiredStringArray(record: JsonRecord, field: string) {
  const value = record[field];

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${field} must be a non-empty string array.`);
  }
}

function optionalStringArray(record: JsonRecord, field: string) {
  if (typeof record[field] === "undefined") {
    return;
  }

  requiredStringArray(record, field);
}

function requiredArray(record: JsonRecord, field: string) {
  if (!Array.isArray(record[field]) || record[field].length === 0) {
    throw new Error(`${field} must be a non-empty array.`);
  }
}

function requiredObject(record: JsonRecord, field: string) {
  const value = record[field];

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object.`);
  }
}

function optionalInteger(record: JsonRecord, field: string) {
  if (typeof record[field] === "undefined") {
    return;
  }

  if (typeof record[field] !== "number" || !Number.isInteger(record[field])) {
    throw new Error(`${field} must be an integer when provided.`);
  }
}

function optionalBoolean(record: JsonRecord, field: string) {
  if (typeof record[field] !== "undefined" && typeof record[field] !== "boolean") {
    throw new Error(`${field} must be a boolean when provided.`);
  }
}
