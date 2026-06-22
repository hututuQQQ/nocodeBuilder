import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolName,
} from "../../agent/project/toolRegistry";
import type { RuntimeSchema, ToolDefinition, ToolSideEffect } from "../types";

export type CoreToolName =
  | AgentToolName
  | "get_site_spec"
  | "get_page_spec"
  | "find_site_node"
  | "update_design_tokens"
  | "resolve_node_source"
  | "refresh_site_index";

const anyObjectSchema: RuntimeSchema = {
  describe: "JSON object",
  validate(value: unknown) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Tool input must be a JSON object.");
    }
  },
};

const anyOutputSchema: RuntimeSchema = {
  describe: "structured tool result",
  validate() {
    return;
  },
};

const SIDE_EFFECT_BY_TOOL = new Map<string, ToolSideEffect>([
  ["list_files", "none"],
  ["read_files", "none"],
  ["grep_files", "none"],
  ["glob_files", "none"],
  ["edit_file", "workspace_write"],
  ["write_files", "workspace_write"],
  ["delete_files", "destructive"],
  ["run_command", "external_write"],
  ["apply_supabase_schema", "database_write"],
  ["start_dev_server", "external_write"],
  ["stop_dev_server", "external_write"],
  ["refresh_preview", "none"],
]);

const APPROVAL_BY_TOOL = new Map<string, ToolDefinition["approvalPolicy"]>([
  ["delete_files", "always"],
  ["apply_supabase_schema", "conditional"],
  ["run_command", "conditional"],
]);

const LEGACY_TOOL_DEFINITIONS: ToolDefinition[] = AGENT_TOOL_DEFINITIONS.map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: tool.isReadOnly,
    concurrencySafe: tool.isConcurrencySafe,
    sideEffect: SIDE_EFFECT_BY_TOOL.get(tool.name) ?? "workspace_write",
    requiresVerification: tool.needsVerification,
    approvalPolicy: APPROVAL_BY_TOOL.get(tool.name) ?? "never",
    timeoutMs: tool.name === "run_command" ? 120_000 : 30_000,
    maxOutputBytes: tool.name === "read_files" ? 24_000 : 18_000,
  }),
);

const SITE_IR_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_site_spec",
    description: "Read the host-managed SiteSpec for the current project.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: true,
    concurrencySafe: true,
    sideEffect: "none",
    requiresVerification: false,
    approvalPolicy: "never",
    timeoutMs: 10_000,
    maxOutputBytes: 32_000,
  },
  {
    name: "get_page_spec",
    description: "Read one page from the host-managed SiteSpec.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: true,
    concurrencySafe: true,
    sideEffect: "none",
    requiresVerification: false,
    approvalPolicy: "never",
    timeoutMs: 10_000,
    maxOutputBytes: 16_000,
  },
  {
    name: "find_site_node",
    description: "Find SiteSpec nodes by id, label, route, or text hint.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: true,
    concurrencySafe: true,
    sideEffect: "none",
    requiresVerification: false,
    approvalPolicy: "never",
    timeoutMs: 10_000,
    maxOutputBytes: 16_000,
  },
  {
    name: "update_design_tokens",
    description:
      "Update controlled design token CSS variables and synchronize SiteSpec metadata.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: false,
    concurrencySafe: false,
    sideEffect: "workspace_write",
    requiresVerification: true,
    approvalPolicy: "conditional",
    timeoutMs: 30_000,
    maxOutputBytes: 12_000,
  },
  {
    name: "resolve_node_source",
    description: "Resolve a SiteSpec node id to source file and line metadata.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: true,
    concurrencySafe: true,
    sideEffect: "none",
    requiresVerification: false,
    approvalPolicy: "never",
    timeoutMs: 10_000,
    maxOutputBytes: 8_000,
  },
  {
    name: "refresh_site_index",
    description:
      "Ask the host to safely rebuild the SiteSpec and source map from project files.",
    inputSchema: anyObjectSchema,
    outputSchema: anyOutputSchema,
    readOnly: false,
    concurrencySafe: false,
    sideEffect: "workspace_write",
    requiresVerification: true,
    approvalPolicy: "never",
    timeoutMs: 30_000,
    maxOutputBytes: 16_000,
  },
];

export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...LEGACY_TOOL_DEFINITIONS,
  ...SITE_IR_TOOL_DEFINITIONS,
];

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
