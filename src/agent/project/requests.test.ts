import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../llm/types";
import type { AiProviderConfig } from "../../services/keyStore";
import {
  AgentStepValidationError,
  requestAgentStep,
} from "./requests";
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

  it("throws a typed validation error after repair attempts are exhausted", async () => {
    const invalidWriteBatch = {
      type: "tool_calls",
      calls: [
        {
          type: "tool_call",
          tool: "write_files",
          rationale: "Create the page.",
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
    mocks.chatJson.mockResolvedValue(invalidWriteBatch);

    let error: unknown;
    try {
      await requestAgentStep({
        config: createConfig(),
        context: createAgentStepContext(),
        userRequest: "Create poker tables",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentStepValidationError);
    expect(error).toMatchObject({
      attempts: 3,
      invalidResponsePreview: expect.stringContaining("write_files"),
      validationError: expect.stringContaining("tool_calls may only include read-only tools"),
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(3);
  });

  it("repairs a forbidden shell command into an exact allowed command", async () => {
    const invalidCommand = {
      type: "tool_call",
      tool: "run_command",
      rationale: "Check the build.",
      args: {
        command: "npm run build 2>&1 | head -100",
      },
    };
    const repairedCommand = {
      type: "tool_call",
      tool: "run_command",
      rationale: "Check the build.",
      args: {
        command: "npm run build",
      },
    };
    mocks.chatJson
      .mockResolvedValueOnce(invalidCommand)
      .mockResolvedValueOnce(repairedCommand);

    const step = await requestAgentStep({
      config: createConfig(),
      context: createAgentStepContext(),
      userRequest: "Build the project",
    });

    expect(step).toMatchObject(repairedCommand);
    expect(mocks.chatJson).toHaveBeenCalledTimes(2);

    const retryMessages = mocks.chatJson.mock.calls[1][0] as ChatMessage[];
    const repairMessage = retryMessages[retryMessages.length - 1];

    expect(repairMessage.content).toContain(
      "Model attempted to run a forbidden command",
    );
    expect(repairMessage.content).toContain(
      "replace it with exactly one allowed command string",
    );
    expect(repairMessage.content).toContain("do not add shell pipes");
  });

  it("throws a typed validation error when forbidden command repair is exhausted", async () => {
    const invalidCommand = {
      type: "tool_call",
      tool: "run_command",
      rationale: "Check the build.",
      args: {
        command: "npm run build 2>&1 | head -100",
      },
    };
    mocks.chatJson.mockResolvedValue(invalidCommand);

    let error: unknown;
    try {
      await requestAgentStep({
        config: createConfig(),
        context: createAgentStepContext(),
        userRequest: "Build the project",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentStepValidationError);
    expect(error).toMatchObject({
      attempts: 3,
      invalidResponsePreview: expect.stringContaining("2>&1 | head -100"),
      validationError: expect.stringContaining("forbidden command"),
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(3);
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
      objective: "Demo request",
      summarizedObservationCount: 0,
    },
    steering: [],
    taskLedger: null,
    workingSummary: null,
  };
}
