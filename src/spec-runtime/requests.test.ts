import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../agent/llm/types";
import type { AiProviderConfig } from "../services/keyStore";
import {
  requestFeatureSpec,
  requestInitialSpec,
  requestSpecRevision,
  requestSpecChatAnswer,
  SpecValidationError,
} from "./requests";

const mocks = vi.hoisted(() => ({
  chatJson: vi.fn(),
}));

vi.mock("../agent/llm/ChatCompletionClient", () => ({
  ChatCompletionClient: class MockChatCompletionClient {
    chatJson = mocks.chatJson;
  },
}));

describe("Spec runtime requests", () => {
  beforeEach(() => {
    mocks.chatJson.mockReset();
  });

  it("returns a valid Initial Spec payload without a repair retry", async () => {
    mocks.chatJson.mockResolvedValueOnce(createGeneratedPayload());

    const payload = await requestInitialSpec({
      config: createConfig(),
      projectBrief: "Build a dashboard",
      projectName: "Dashboard",
    });

    expect(payload.tasks[0].acceptanceCriteriaIds).toEqual(["criterion-1"]);
    expect(mocks.chatJson).toHaveBeenCalledTimes(1);
  });

  it("repairs a generated Spec payload after validation fails", async () => {
    mocks.chatJson
      .mockResolvedValueOnce(
        createGeneratedPayload({
          taskPatch: { acceptanceCriteriaIds: [] },
        }),
      )
      .mockResolvedValueOnce(createGeneratedPayload());

    const payload = await requestFeatureSpec({
      brief: "增加订单筛选",
      config: createConfig(),
      context: { routes: ["/orders"] },
    });

    expect(payload.tasks[0].acceptanceCriteriaIds).toEqual(["criterion-1"]);
    expect(mocks.chatJson).toHaveBeenCalledTimes(2);

    const retryMessages = mocks.chatJson.mock.calls[1][0] as ChatMessage[];
    const repairMessage = retryMessages[retryMessages.length - 1];

    expect(repairMessage).toMatchObject({
      role: "user",
    });
    expect(repairMessage?.content).toContain(
      "task.acceptanceCriteriaIds must not be empty.",
    );
    expect(repairMessage?.content).toContain(
      "Every task.acceptanceCriteriaIds array must contain at least one existing acceptance criterion id.",
    );
  });

  it("keeps repairing a generated Spec payload through a short validation loop", async () => {
    mocks.chatJson
      .mockResolvedValueOnce(
        createGeneratedPayload({
          taskPatch: { acceptanceCriteriaIds: [] },
        }),
      )
      .mockResolvedValueOnce(
        createGeneratedPayload({
          taskPatch: { acceptanceCriteriaIds: ["criterion-missing"] },
        }),
      )
      .mockResolvedValueOnce(createGeneratedPayload());

    const payload = await requestInitialSpec({
      config: createConfig(),
      projectBrief: "Build a dashboard",
      projectName: "Dashboard",
    });

    expect(payload.tasks[0].acceptanceCriteriaIds).toEqual(["criterion-1"]);
    expect(mocks.chatJson).toHaveBeenCalledTimes(3);

    const secondRepairMessages = mocks.chatJson.mock.calls[2][0] as ChatMessage[];
    const secondRepairMessage =
      secondRepairMessages[secondRepairMessages.length - 1];

    expect(secondRepairMessage?.content).toContain(
      "Task task-1 references unknown acceptance criterion criterion-missing.",
    );
    expect(secondRepairMessage?.content).toContain(
      "Return the complete replacement Spec JSON only.",
    );
  });

  it("throws a typed Spec validation error when repair attempts are exhausted", async () => {
    mocks.chatJson.mockResolvedValue(
      createGeneratedPayload({
        taskPatch: { acceptanceCriteriaIds: [] },
      }),
    );

    let capturedError: unknown = null;

    try {
      await requestSpecRevision({
        config: createConfig(),
        currentRevision: createGeneratedPayload(),
        feedback: "Try again",
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(SpecValidationError);
    expect(capturedError).toMatchObject({
      attempts: 3,
      name: "SpecValidationError",
      validationError: "task.acceptanceCriteriaIds must not be empty.",
    });
    expect(mocks.chatJson).toHaveBeenCalledTimes(3);
    expect((capturedError as SpecValidationError).invalidResponsePreview).toContain(
      "acceptanceCriteriaIds",
    );
  });

  it("returns a validated Spec chat answer", async () => {
    mocks.chatJson.mockResolvedValueOnce({
      answer: "Use Supabase because the project has backend configuration.",
    });

    const answer = await requestSpecChatAnswer({
      config: createConfig(),
      currentRevision: createGeneratedPayload(),
      planningContext: { backendContext: { supabase: { configured: true } } },
      question: "Why Supabase?",
    });

    expect(answer).toBe(
      "Use Supabase because the project has backend configuration.",
    );
    const messages = mocks.chatJson.mock.calls[0][0] as ChatMessage[];

    expect(String(messages[0].content)).toContain(
      "Answer questions about the current Spec revision without changing it.",
    );
    expect(String(messages[1].content)).toContain("Why Supabase?");
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

function createGeneratedPayload({
  taskPatch = {},
}: {
  taskPatch?: Partial<ReturnType<typeof createTask>>;
} = {}) {
  return {
    brief: "Add a hero section",
    design: {
      components: [
        {
          name: "Hero",
          responsibility: "Render the primary page heading.",
        },
      ],
      dataModel: [],
      integrations: [],
      pages: [
        {
          purpose: "Home page",
          route: "/",
        },
      ],
      summary: "A focused page update.",
      technicalDecisions: ["Use existing App Router structure."],
      verificationStrategy: ["Run npm run build."],
    },
    requirements: {
      acceptanceCriteria: [
        {
          description: "The hero content is visible.",
          id: "criterion-1",
          required: true,
        },
      ],
      constraints: ["Keep existing styling conventions."],
      goal: "Add a hero section.",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [
        {
          description: "As a visitor, I can understand the page.",
          id: "story-1",
        },
      ],
    },
    tasks: [{ ...createTask(), ...taskPatch }],
  };
}

function createTask() {
  return {
    acceptanceCriteriaIds: ["criterion-1"],
    allowedPaths: ["app/**", "components/**"],
    dependencyIds: [],
    expectedFiles: ["app/page.tsx"],
    id: "task-1",
    objective: "Update the home page hero.",
    requirementIds: ["story-1"],
    title: "Hero update",
  };
}
