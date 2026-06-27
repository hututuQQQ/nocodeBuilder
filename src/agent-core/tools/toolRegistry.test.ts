import { describe, expect, it } from "vitest";
import { validateAgentStepResponse } from "../../agent/project/validators";
import { AGENT_TOOL_NAMES } from "../../agent/project/toolRegistry";
import { AGENT_TOOL_EXECUTOR_NAMES } from "../../store/agentToolExecutor";
import {
  CORE_TOOL_DEFINITIONS,
  assertReadOnlyBatch,
  getCoreToolDefinition,
  validateCoreToolInput,
} from "./toolRegistry";

describe("Core tool registry", () => {
  it("exposes policy metadata and validates input object shape", () => {
    const editFile = getCoreToolDefinition("edit_file");

    expect(editFile?.sideEffect).toBe("workspace_write");
    expect(editFile?.requiresVerification).toBe(true);
    expect(() => validateCoreToolInput("edit_file", null)).toThrow();
    expect(() => validateCoreToolInput("edit_file", {})).toThrow(/path/);
    expect(() =>
      validateCoreToolInput("edit_file", {
        new_string: "new",
        old_string: "old",
        path: "app/page.tsx",
        summary: "Update copy",
      }),
    ).not.toThrow();
  });

  it("validates Site IR tool inputs with explicit schemas", () => {
    expect(() => validateCoreToolInput("find_site_node", {})).toThrow(/requires/);
    expect(() =>
      validateCoreToolInput("find_site_node", {
        route: "/",
        textHint: "pricing",
      }),
    ).not.toThrow();
    expect(() => validateCoreToolInput("update_design_tokens", {})).toThrow(/tokens/);
  });

  it("limits parallel calls to read-only tools", () => {
    expect(() => assertReadOnlyBatch(["read_files", "grep_files"])).not.toThrow();
    expect(() => assertReadOnlyBatch(["read_files", "edit_file"])).toThrow(/read-only/);
    expect(() => assertReadOnlyBatch(["read_files", "replace_file_range"])).toThrow(/read-only/);
  });

  it("keeps registry, model actions, validator, and executor tool sets aligned", () => {
    const registryNames = sorted(CORE_TOOL_DEFINITIONS.map((tool) => tool.name));
    const actionNames = sorted([...AGENT_TOOL_NAMES]);
    const executorNames = sorted([...AGENT_TOOL_EXECUTOR_NAMES]);

    expect(actionNames).toEqual(registryNames);
    expect(executorNames).toEqual(registryNames);

    for (const tool of registryNames) {
      expect(() =>
        validateAgentStepResponse({
          args: sampleArgsForTool(tool),
          rationale: "test",
          tool,
          type: "tool_call",
        }),
      ).not.toThrow();
    }
  });
});

function sorted(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sampleArgsForTool(tool: string) {
  switch (tool) {
    case "apply_supabase_schema":
      return {
        summary: "Create table",
        tables: [
          {
            columns: [
              {
                dataType: "uuid",
                defaultValue: "gen_random_uuid()",
                name: "id",
                nullable: false,
                primaryKey: true,
                unique: false,
              },
            ],
            enableRls: true,
            name: "orders",
          },
        ],
      };
    case "delete_files":
      return { paths: ["components/Old.tsx"], summary: "Remove old component" };
    case "edit_file":
      return {
        new_string: "new",
        old_string: "old",
        path: "app/page.tsx",
        summary: "Edit page",
      };
    case "replace_file_range":
      return {
        endLine: 3,
        newContent: "replacement",
        path: "app/page.tsx",
        startLine: 2,
        summary: "Replace range",
      };
    case "find_site_node":
      return { textHint: "pricing" };
    case "get_page_spec":
      return { route: "/" };
    case "get_site_spec":
    case "list_files":
    case "refresh_preview":
    case "start_dev_server":
    case "stop_dev_server":
      return {};
    case "glob_files":
      return { pattern: "components/**/*.tsx" };
    case "grep_files":
      return { query: "Hero", paths: ["app"] };
    case "read_files":
      return { paths: ["app/page.tsx"] };
    case "refresh_site_index":
      return { reason: "test" };
    case "resolve_node_source":
      return { nodeId: "home.hero" };
    case "run_command":
      return { command: "npm run build" };
    case "update_design_tokens":
      return { tokens: { colors: { primary: "#0f766e" } } };
    case "write_files":
      return {
        files: [{ content: "export default function Page() { return null; }", path: "app/page.tsx" }],
        summary: "Write page",
      };
    default:
      throw new Error(`Missing sample args for ${tool}`);
  }
}
