import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import type { AgentRun } from "../agent-core/types";
import type { DevelopmentSpec } from "../spec-core/types";
import { modifyCurrentProject } from "./agentWorkflow";
import { createChatActions } from "./chatStoreActions";

vi.mock("./agentWorkflow", () => ({
  modifyCurrentProject: vi.fn(),
}));

describe("chat store actions", () => {
  beforeEach(() => {
    vi.mocked(modifyCurrentProject).mockReset();
  });

  it("does not auto-create a Chat conversation when none is active", async () => {
    let createConversationCalls = 0;
    const store = createStore({
      createConversation: async () => {
        createConversationCalls += 1;
        return null;
      },
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Please edit the hero");

    expect(createConversationCalls).toBe(0);
    expect(store.get().projectError).toBe(
      "Create a new iteration before sending chat messages.",
    );
    expect(store.get().chatMessages).toEqual([]);
  });

  it("blocks Spec messages while a revision is in progress", async () => {
    const conversation = createConversation({
      activeSpecId: "spec-1",
      mode: "spec",
      specIds: ["spec-1"],
    });
    const store = createStore({
      currentConversation: conversation,
      isRevisingSpec: true,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Please change the requirements");

    expect(store.get().chatMessages).toEqual([]);
    expect(store.get().currentConversation?.messages).toEqual([]);
    expect(store.get().projectError).toBe(
      "Wait for the Spec revision to finish before sending messages.",
    );
  });

  it("blocks Spec messages while a non-steering Spec operation is busy", async () => {
    for (const busyFlag of [
      "isGeneratingSpec",
      "isVerifyingSpec",
      "isSwitchingIterationMode",
    ] as const) {
      const conversation = createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      });
      const store = createStore({
        currentConversation: conversation,
        currentSpec: createReviewSpec(),
        [busyFlag]: true,
      });
      const actions = createChatActions(store as never);

      await actions.sendMessage("Please change the requirements");

      expect(store.get().chatMessages).toEqual([]);
      expect(store.get().currentConversation?.messages).toEqual([]);
      expect(store.get().projectError).toBe(
        "Wait for the active Spec operation to finish before sending messages.",
      );
      expect(store.get().terminalLogs).toContain(
        "[spec] Message blocked while a Spec operation is in progress.",
      );
    }
  });

  it("keeps review Spec messages in Spec guidance without modifying the project", async () => {
    const store = createStore({
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createReviewSpec(),
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Please change the requirements");

    expect(modifyCurrentProject).not.toHaveBeenCalled();
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[0]).toMatchObject({
      content: "Please change the requirements",
      role: "user",
    });
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "Use Request revision to change this Spec, or Approve and start build when it is ready.",
      role: "assistant",
    });
    expect(store.get().currentConversation?.messages).toHaveLength(2);
  });

  it("localizes Spec guidance for Chinese messages", async () => {
    const store = createStore({
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createReviewSpec(),
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("请改一下需求");

    expect(modifyCurrentProject).not.toHaveBeenCalled();
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "使用 Request revision 修改这个 Spec，或者在准备好后点击 Approve 并开始构建。",
      role: "assistant",
    });
  });

  it("uses blocked Spec messages to retry the first recoverable task", async () => {
    const retrySpecTask = vi.fn(async () => undefined);
    const store = createStore({
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createBlockedSpec(),
      retrySpecTask,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("How do I fix this?");

    expect(modifyCurrentProject).not.toHaveBeenCalled();
    expect(retrySpecTask).toHaveBeenCalledWith("task-1");
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[0]).toMatchObject({
      content: "How do I fix this?",
      role: "user",
    });
    expect(store.get().chatMessages[1]).toMatchObject({
      content: "I'll retry Current task with your note in the conversation context.",
      role: "assistant",
    });
    expect(store.get().terminalLogs).toContain(
      "[spec] Chat message requested retry for task task-1.",
    );
  });

  it("uses blocked Spec messages to retry final verification when applicable", async () => {
    const retrySpecVerification = vi.fn(async () => undefined);
    const retrySpecTask = vi.fn(async () => undefined);
    const store = createStore({
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createFinalVerificationBlockedSpec(),
      retrySpecTask,
      retrySpecVerification,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Try again after restarting preview");

    expect(retrySpecVerification).toHaveBeenCalledTimes(1);
    expect(retrySpecTask).not.toHaveBeenCalled();
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "I'll retry final verification with your note in the conversation context.",
      role: "assistant",
    });
  });

  it("answers blocked Spec messages with recovery guidance when nothing can retry", async () => {
    const retrySpecTask = vi.fn(async () => undefined);
    const store = createStore({
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createUnretryableBlockedSpec(),
      retrySpecTask,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("How do I fix this?");

    expect(retrySpecTask).not.toHaveBeenCalled();
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "This Spec is blocked. Retry the failed task from the Spec summary, or request a revision if the plan needs to change.",
      role: "assistant",
    });
  });

  it("adds Spec execution messages as steering only for the current running task", async () => {
    const run = createRun("run-current", {
      contract: createSpecContract({ taskId: "task-1" }),
    });
    const sendAgentSteering = vi.fn(async () => undefined);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createSpec({ runId: run.id }),
      sendAgentSteering,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("try a smaller change");

    expect(sendAgentSteering).toHaveBeenCalledWith("try a smaller change");
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "I sent this to the running Spec task as steering. The agent will use it on the next model step.",
      role: "assistant",
    });
    expect(store.get().terminalLogs).toContain(
      `[spec] Added message as steering for run ${run.id}.`,
    );
  });

  it("localizes Spec steering acknowledgements for Chinese messages", async () => {
    const run = createRun("run-current", {
      contract: createSpecContract({ taskId: "task-1" }),
    });
    const sendAgentSteering = vi.fn(async () => undefined);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createSpec({ runId: run.id }),
      sendAgentSteering,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("你修复一下");

    expect(sendAgentSteering).toHaveBeenCalledWith("你修复一下");
    expect(store.get().chatMessages).toHaveLength(2);
    expect(store.get().chatMessages[1]).toMatchObject({
      content:
        "我已把这条消息发送给正在运行的 Spec 任务作为 steering，AI 会在下一步参考它。",
      role: "assistant",
    });
  });

  it("does not treat a non-current Spec run as message steering", async () => {
    const run = createRun("run-other", {
      contract: createSpecContract({ taskId: "task-other" }),
    });
    const sendAgentSteering = vi.fn(async () => undefined);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createConversation({
        activeSpecId: "spec-1",
        mode: "spec",
        specIds: ["spec-1"],
      }),
      currentSpec: createSpec({ runId: "run-current" }),
      sendAgentSteering,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("try a smaller change");

    expect(sendAgentSteering).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "AgentRun does not belong to the current Spec task.",
    );
    expect(store.get().chatMessages).toHaveLength(2);
    expect((store.get().chatMessages[1] as { role?: string }).role).toBe(
      "assistant",
    );
    expect(store.get().terminalLogs).toContain(
      "[spec] Steering blocked because the active AgentRun does not belong to the current Spec task.",
    );
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    changeHistory: [],
    chatMessages: [],
    conversationSummaries: [],
    createConversation: async () => null,
    currentAgentRun: null,
    currentConversation: null,
    currentProject: {
      createdAt: "2026-01-01T00:00:00.000Z",
      framework: "next-app-router",
      id: "project-1",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      name: "Project",
      path: "D:/projects/project-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    currentSpec: null,
    isGeneratingSpec: false,
    isGeneratingProject: false,
    isModifyingProject: false,
    isRevisingSpec: false,
    isSwitchingIterationMode: false,
    isVerifyingSpec: false,
    projectError: null,
    retrySpecTask: vi.fn(async () => undefined),
    retrySpecVerification: vi.fn(async () => undefined),
    sendAgentSteering: vi.fn(async () => undefined),
    terminalLogs: [],
    ...patch,
  };

  return {
    get: () => state,
    set: (patchOrUpdater: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)) => {
      const nextPatch =
        typeof patchOrUpdater === "function" ? patchOrUpdater(state) : patchOrUpdater;
      state = {
        ...state,
        ...nextPatch,
      };
    },
  };
}

function createConversation(patch: Partial<StoreState["currentConversation"]> = {}) {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    mode: "chat",
    modeChangedAt: "2026-01-01T00:00:00.000Z",
    projectId: "project-1",
    specIds: [],
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as StoreState["currentConversation"];
}

type StoreState = {
  changeHistory: unknown[];
  chatMessages: unknown[];
  conversationSummaries: unknown[];
  createConversation: () => Promise<null>;
  currentAgentRun: AgentRun | null;
  currentConversation: {
    activeSpecId: string | null;
    archivedAt: string | null;
    createdAt: string;
    id: string;
    kind: "initial_build" | "iteration";
    lastMessageAt: string;
    messages: unknown[];
    mode: "chat" | "spec";
    modeChangedAt: string;
    projectId: string;
    specIds: string[];
    title: string;
    updatedAt: string;
  } | null;
  currentProject: {
    createdAt: string;
    framework: "next-app-router";
    id: string;
    lastOpenedAt: string;
    name: string;
    path: string;
    updatedAt: string;
  } | null;
  currentSpec: DevelopmentSpec | null;
  isGeneratingSpec: boolean;
  isGeneratingProject: boolean;
  isModifyingProject: boolean;
  isRevisingSpec: boolean;
  isSwitchingIterationMode: boolean;
  isVerifyingSpec: boolean;
  projectError: string | null;
  retrySpecTask: ReturnType<typeof vi.fn>;
  retrySpecVerification: ReturnType<typeof vi.fn>;
  sendAgentSteering: ReturnType<typeof vi.fn>;
  terminalLogs: string[];
};

function createRun(runId: string, patch: Partial<AgentRun> = {}): AgentRun {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    cancelRequested: false,
    completedAt: undefined,
    contract: createSpecContract({}),
    conversationId: "conversation-1",
    id: runId,
    modelTurns: 0,
    mutationCount: 0,
    pauseRequested: false,
    phase: "planning",
    projectId: "project-1",
    repairCycles: 0,
    startedAt: now,
    stateVersion: 1,
    status: "planning",
    toolCalls: 0,
    updatedAt: now,
    ...patch,
  };
}

function createSpecContract({
  taskId = "task-1",
}: {
  taskId?: string;
}): AgentRun["contract"] {
  return {
    ...compileTaskContract({
      objective: "Run a Spec task",
      taskType: "component_edit",
    }),
    source: {
      acceptanceCriteriaIds: ["criterion-1"],
      executionMode: "modify",
      mode: "spec",
      requirementIds: ["story-1"],
      revisionId: "rev-1",
      specId: "spec-1",
      taskId,
    },
  };
}

function createSpec({ runId }: { runId: string }): DevelopmentSpec {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "rev-1",
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [
      {
        brief: "Spec",
        createdAt: "2026-01-01T00:00:00.000Z",
        design: {
          components: [],
          dataModel: [],
          integrations: [],
          pages: [],
          summary: "Design",
          technicalDecisions: [],
          verificationStrategy: [],
        },
        id: "rev-1",
        requirements: {
          acceptanceCriteria: [
            {
              description: "Criterion",
              id: "criterion-1",
              required: true,
            },
          ],
          constraints: [],
          goal: "Goal",
          outOfScope: [],
          unresolvedQuestions: [],
          userStories: [
            {
              description: "Story",
              id: "story-1",
            },
          ],
        },
        tasks: [
          {
            acceptanceCriteriaIds: ["criterion-1"],
            allowedPaths: ["app/page.tsx"],
            dependencyIds: [],
            expectedFiles: ["app/page.tsx"],
            id: "task-1",
            objective: "Run current task",
            requirementIds: ["story-1"],
            runId,
            status: "running",
            title: "Current task",
          },
        ],
        version: 1,
      },
    ],
    status: "building",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createReviewSpec(): DevelopmentSpec {
  const spec = createSpec({ runId: "run-current" });

  return {
    ...spec,
    revisions: [
      {
        ...spec.revisions[0],
        tasks: [
          {
            ...spec.revisions[0].tasks[0],
            runId: undefined,
            status: "pending",
          },
        ],
      },
    ],
    status: "review",
  };
}

function createBlockedSpec(): DevelopmentSpec {
  const spec = createReviewSpec();

  return {
    ...spec,
    failureMessage: "Task Initialize Next.js project with dependencies failed.",
    revisions: [
      {
        ...spec.revisions[0],
        tasks: [
          {
            ...spec.revisions[0].tasks[0],
            error: "AgentRun ended without a passed verification report.",
            status: "failed",
          },
        ],
      },
    ],
    status: "blocked",
  };
}

function createFinalVerificationBlockedSpec(): DevelopmentSpec {
  const spec = createReviewSpec();

  return {
    ...spec,
    failureMessage: "Final npm run build failed.",
    finalVerification: {
      checkedAt: "2026-01-01T00:02:00.000Z",
      command: "npm run build",
      output: "Internal Server Error",
      success: false,
    },
    revisions: [
      {
        ...spec.revisions[0],
        tasks: [
          {
            ...spec.revisions[0].tasks[0],
            runId: "run-current",
            status: "passed",
          },
        ],
      },
    ],
    status: "blocked",
  };
}

function createUnretryableBlockedSpec(): DevelopmentSpec {
  const spec = createReviewSpec();

  return {
    ...spec,
    failureMessage: "Task dependencies could not advance.",
    revisions: [
      {
        ...spec.revisions[0],
        tasks: [
          {
            ...spec.revisions[0].tasks[0],
            blockedByTaskId: "task-dependency",
            dependencyIds: ["task-dependency"],
            error: "Blocked by dependency.",
            status: "blocked",
          },
        ],
      },
    ],
    status: "blocked",
  };
}
