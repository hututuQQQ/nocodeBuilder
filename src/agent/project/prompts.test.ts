import { describe, expect, it } from "vitest";
import {
  buildAgentStepMessages,
  buildGenerateProjectMessages,
  buildModifyProjectMessages,
} from "./prompts";
import type { AgentStepContext, ModificationContext } from "./types";

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
      "Never include write_files, edit_file, delete_files, run_command, apply_supabase_schema, preview, or dev-server tools inside tool_calls.",
    );
    expect(userPayload.instructions).toContain(
      "If using write_files, edit_file, delete_files, run_command, apply_supabase_schema, refresh_preview, start_dev_server, or stop_dev_server, return a single tool_call object, not tool_calls.",
    );
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

function createAgentStepContext(): AgentStepContext {
  return {
    backend: null,
    diagnostics: null,
    devServerStatus: "stopped",
    fileTree: "app/page.tsx",
    memory: null,
    observations: [],
    previewUrl: null,
    projectName: "Demo",
    recentMessages: [],
    steering: [],
    taskLedger: null,
    workingSummary: null,
  };
}
