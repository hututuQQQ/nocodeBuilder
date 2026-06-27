import { describe, expect, it } from "vitest";
import {
  buildAgentStepMessages,
  buildGenerateProjectMessages,
  buildModifyProjectMessages,
} from "./prompts";
import type { AgentStepContext, ModificationContext } from "./types";
import { createTaskManifestFromContract } from "../../agent-core/manifest/taskManifest";
import { compileTaskContract } from "../../agent-core/contract/taskContract";
import type { TaskType } from "../../agent-core/types";

const CHINESE_RULE =
  "If the latest request is primarily Chinese, use Simplified Chinese.";

describe("project prompts", () => {
  it("instructs generation to match user-facing output language", () => {
    const messages = buildGenerateProjectMessages("Demo", "做一个订单系统");
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "The JSON summary and newly created visible UI text must match the dominant natural language",
    );
    expect(systemContent).toContain(CHINESE_RULE);
  });

  it("instructs modification summaries and copy to match user language", () => {
    const messages = buildModifyProjectMessages(
      createModificationContext(),
      "把首页改成中文",
    );
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "The JSON summary and newly added or rewritten visible page copy must match the dominant natural language",
    );
    expect(systemContent).toContain(CHINESE_RULE);
    expect(userPayload.instructions).toContain(
      "The summary and newly created visible UI text must match the dominant natural language of the user's latest request, project brief, or revision feedback.",
    );
  });

  it("instructs agent answers and finish summaries to match user language", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext(),
      "解释一下当前状态",
    );
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "Answer messages, finish_candidate summaries, tool rationales/summaries, and newly created visible UI text must match the dominant natural language",
    );
    expect(systemContent).toContain(CHINESE_RULE);
  });

  it("keeps write actions out of batched agent tool_calls", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext(),
      "修复页面错误",
    );
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "Never include write_files, edit_file, delete_files, or run_command inside tool_calls.",
    );
    expect(userPayload.instructions).toContain(
      "If using write_files, edit_file, delete_files, or run_command, return a single tool_call object, not tool_calls.",
    );
  });

  it("documents canonical Supabase schema column types", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext({
        objective: "Create a multiplayer poker backend",
        taskType: "backend_feature",
      }),
      "Create a multiplayer poker backend",
    );
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "For apply_supabase_schema column dataType, use only these canonical values: uuid, text, integer, bigint, numeric, boolean, date, timestamptz, jsonb.",
    );
    expect(systemContent).toContain(
      "Do not use Postgres aliases like int2, int4, int8, smallint, timestamp, or bool.",
    );
    expect(systemContent).toContain(
      "For apply_supabase_schema column defaultValue, use only safe literals compatible with the column type",
    );
    expect(systemContent).toContain("integer/bigint numbers like 0 or 9");
    expect(systemContent).toContain("'' only for empty text columns");
    expect(systemContent).toContain("omit defaultValue instead of using ''");
  });

  it("documents exact run_command whitelist usage", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext(),
      "Build the project",
    );
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "When using run_command, command must exactly equal one of:",
    );
    expect(systemContent).toContain("npm run build");
    expect(systemContent).toContain(
      "do not add shell pipes, redirects, output truncation, flags, package names, or operators",
    );
    expect(systemContent).toContain(
      "not npm run build 2>&1 | head -100",
    );
  });

  it("prefers ranged rereads when exact edit text is missing", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext(),
      "Inspect the lobby",
    );
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "If exact edit_file old_string text is no longer visible there, reread only the smallest useful range",
    );
    expect(systemContent).toContain(
      "Copy edit_file old_string from file.content only, never from numberedContent.",
    );
    expect(userPayload.instructions).toContain(
      "Avoid repeating full-file read_files for the same unchanged path; when exact text is missing, reread the smallest useful range with offset/limit.",
    );
  });

  it("encourages batching known read-only context gathering", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext(),
      "Inspect related files",
    );
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "batch those read-only calls in one tool_calls response",
    );
    expect(userPayload.instructions).toContain(
      "Batch known read-only reads/searches together when that avoids multiple planning turns.",
    );
  });

  it("prioritizes exact diagnostic locations for verification repairs", () => {
    const messages = buildAgentStepMessages(createAgentStepContext(), "Fix build");
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain(
      "When diagnostics include file:line:column or a code frame",
    );
  });

  it("instructs the agent to repair model validation observations as protocol JSON", () => {
    const messages = buildAgentStepMessages(createAgentStepContext(), "Retry");
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "If the latest observation tool is model_validation",
    );
    expect(systemContent).toContain(
      "do not repeat the invalid schema fields, Supabase data types, or default values",
    );
    expect(userPayload.instructions).toContain(
      "When the latest observation has tool model_validation, repair the rejected JSON/tool arguments directly on this response.",
    );
  });

  it("instructs the agent to prioritize baseline diagnostics", () => {
    const messages = buildAgentStepMessages(createAgentStepContext(), "Fix build");
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };

    expect(systemContent).toContain(
      "If observations include baseline_diagnostics",
    );
    expect(userPayload.instructions).toContain(
      "When observations include tool baseline_diagnostics, repair the named allowed-path failure before more exploration.",
    );
  });

  it("adds critical budget convergence instructions", () => {
    const context = createAgentStepContext();
    context.budgetState = {
      ...context.budgetState,
      pressure: "critical",
    };
    const messages = buildAgentStepMessages(context, "Fix the build");
    const userPayload = JSON.parse(String(messages[1].content)) as {
      budgetState: { pressure: string };
      instructions: string[];
    };

    expect(userPayload.budgetState.pressure).toBe("critical");
    expect(userPayload.instructions).toContain(
      "Budget pressure is critical: do not perform broad searches or multi-step exploration.",
    );
  });

  it("hides write tools for answer tasks unless classification changed", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext({
        objective: "Explain the current status",
        taskType: "answer",
      }),
      "Explain the current status",
    );
    const systemContent = String(messages[0].content);
    const userPayload = JSON.parse(String(messages[1].content)) as {
      instructions: string[];
    };
    const instructionText = userPayload.instructions.join("\n");

    expect(systemContent).toContain("- read_files args");
    expect(systemContent).toContain("- grep_files args");
    expect(systemContent).not.toContain("- edit_file args");
    expect(systemContent).not.toContain('"tool":"edit_file"');
    expect(systemContent).not.toContain("run_command");
    expect(instructionText).not.toContain("edit_file");
    expect(instructionText).not.toContain("write_files");
  });

  it("restores write tools for answer tasks with classification mismatch blocker", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext({
        objective: "Explain the current status",
        taskType: "answer",
        workingState: {
          currentBlocker: {
            code: "TASK_CLASSIFICATION_MISMATCH",
            message: "The request needs a repair task instead of an answer.",
            suggestedAction: {
              args: {
                path: "app/page.tsx",
                old_string: "Broken",
                new_string: "Fixed",
                summary: "Fix copy",
              },
              tool: "edit_file",
              type: "tool_call",
            },
          },
          evidence: {
            acceptanceEvidence: [],
            diagnostics: [],
            mutations: [],
            readFiles: [],
            searches: [],
          },
          objective: "Explain the current status",
          repeatedActionCount: 0,
        },
      }),
      "Fix the current status",
    );
    const systemContent = String(messages[0].content);

    expect(systemContent).toContain("- edit_file args");
    expect(systemContent).toContain(
      "If workingState.currentBlocker.suggestedAction exists, treat it as the highest-priority next step",
    );
  });

  it("hides backend schema guidance and preview tools when not relevant", () => {
    const messages = buildAgentStepMessages(
      createAgentStepContext({
        objective: "Adjust the hero spacing",
        taskType: "style_edit",
      }),
      "Adjust the hero spacing",
    );
    const systemContent = String(messages[0].content);

    expect(systemContent).not.toContain(
      "For apply_supabase_schema column dataType",
    );
    expect(systemContent).not.toContain("- apply_supabase_schema args");
    expect(systemContent).not.toContain("- start_dev_server args");
    expect(systemContent).not.toContain("Use preview/dev-server tools");
    expect(systemContent).not.toContain("refresh_preview");
  });
});

function createModificationContext(): ModificationContext {
  return {
    backend: null,
    fileTree: "app/page.tsx",
    files: [],
    recentMessages: [],
  };
}

function createAgentStepContext(options: {
  objective?: string;
  taskType?: TaskType;
  workingState?: AgentStepContext["workingState"];
} = {}): AgentStepContext {
  const objective = options.objective ?? "Demo request";

  return {
    backend: null,
    budgetState: {
      modelTurns: { max: 10, remaining: 10, used: 0 },
      mutations: { max: 4, remaining: 4, used: 0 },
      pressure: "normal",
      repairCycles: { max: 2, remaining: 2, used: 0 },
      toolCalls: { max: 20, remaining: 20, used: 0 },
    },
    contextReport: {
      finalChars: 0,
      rawChars: 0,
      retainedObservations: 0,
      summarizedObservations: 0,
    },
    diagnostics: null,
    devServerStatus: "stopped",
    fileTree: "app/page.tsx",
    manifest: createTaskManifestFromContract({
      contract: compileTaskContract({
        objective,
        taskType: options.taskType ?? "component_edit",
      }),
      conversationId: "conversation-1",
      projectId: "project-1",
    }),
    memory: null,
    observations: [],
    previewUrl: null,
    projectName: "Demo",
    recentMessages: [],
    runContextSummary: {
      changedFiles: [],
      completed: [],
      decisions: [],
      deletedFiles: [],
      importantFiles: [],
      latestFailures: [],
      nextStep: "Choose the smallest useful next step.",
      objective,
      summarizedObservationCount: 0,
    },
    steering: [],
    taskLedger: null,
    workingState: options.workingState,
    workingSummary: null,
  };
}
