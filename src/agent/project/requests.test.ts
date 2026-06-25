import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../llm/types";
import type { AiProviderConfig } from "../../services/keyStore";
import { requestAgentStep } from "./requests";
import type { AgentStepContext } from "./types";

const mocks = vi.hoisted(() => ({
  chatJson: vi.fn(),
}));

vi.mock("../llm/ChatCompletionClient", () => ({
  ChatCompletionClient: class MockChatCompletionClient {
    chatJson = mocks.chatJson;
  },
}));

describe("project runtime requests", () => {
  beforeEach(() => {
    mocks.chatJson.mockReset();
  });

  it("repairs a tool_calls batch that includes write_files", async () => {
    const invalidWriteBatch = {
      type: "tool_calls",
      calls: [
        {
          type: "tool_call",
          tool: "write_files",
          rationale: "Create a page.",
          args: {
            summary: "Created the page.",
            files: [
              {
                path: "app/page.tsx",
                content: "export default function Page() { return <main />; }",
              },
            ],
          },
        },
      ],
    };
    const repairedWriteCall = {
      ...invalidWriteBatch.calls[0],
      type: "tool_call",
    };
    mocks.chatJson
      .mockResolvedValueOnce(invalidWriteBatch)
      .mockResolvedValueOnce(repairedWriteCall);

    const step = await requestAgentStep({
      config: createConfig(),
      context: createAgentStepContext(),
      userRequest: "Create the page",
    });

    expect(step).toMatchObject({
      type: "tool_call",
      tool: "write_files",
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(2);

    const retryMessages = mocks.chatJson.mock.calls[1][0] as ChatMessage[];
    const repairMessage = retryMessages[retryMessages.length - 1];

    expect(repairMessage).toMatchObject({ role: "user" });
    expect(repairMessage.content).toContain(
      "Invalid model response: tool_calls may only include read-only tools, got write_files.",
    );
    expect(repairMessage.content).toContain(
      "return exactly one top-level tool_call object",
    );
  });
});

function createConfig(): AiProviderConfig {
  return {
    apiKeyConfigured: true,
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    models: ["deepseek-v4-pro"],
    provider: "deepseek",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
