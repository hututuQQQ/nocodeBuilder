import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import type { AgentApproval, AgentEvent, AgentRun } from "../agent-core/types";
import type { ProjectConversation } from "../services/projects";
import type { DevelopmentSpec } from "../spec-core/types";
import { createAgentRunActions } from "./agentRunStoreActions";

const fake = vi.hoisted(() => ({
  activeController: false,
  events: [] as AgentEvent[],
  modifyCalls: [] as unknown[],
  specCalls: [] as unknown[],
  runs: new Map<string, AgentRun>(),
  approvals: [] as AgentApproval[],
}));

vi.mock("../agent-runtime/agentRunControl", () => ({
  isRunControllerActive: vi.fn((runId: string) =>
    fake.activeController && fake.runs.has(runId),
  ),
  requestRunAbort: vi.fn((runId: string) =>
    fake.activeController && fake.runs.has(runId),
  ),
}));

vi.mock("../agent-runtime/runController", () => ({
  modifyCurrentProjectRuntime: vi.fn(async (...args: unknown[]) => {
    fake.modifyCalls.push(args);
    return true;
  }),
  runSpecTaskRuntime: vi.fn(async (...args: unknown[]) => {
    fake.specCalls.push(args);

    return {
      run: null,
      verificationReport: null,
    };
  }),
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
    getLatestVerificationReport: vi.fn(async () => null),
    getRun: vi.fn(async (_projectId: string, runId: string) =>
      fake.runs.get(runId) ?? null,
    ),
    listApprovals: vi.fn(async (_projectId: string, runId: string) =>
      fake.approvals.filter((approval) => approval.runId === runId),
    ),
    listEvents: vi.fn(async (_projectId: string, runId: string) =>
      fake.events.filter((event) => event.runId === runId),
    ),
    listRuns: vi.fn(async () => [...fake.runs.values()]),
    resolveApproval: vi.fn(async (_projectId: string, runId: string, approvalId: string, decision: string) => {
      const approval = fake.approvals.find((item) => item.runId === runId && item.id === approvalId);

      return {
        ...approval,
        decision,
        resolvedAt: "2026-01-01T00:02:00.000Z",
      };
    }),
    appendEvent: vi.fn(async (_projectId: string, event: Omit<AgentEvent, "id" | "sequence">) =>
      appendEvent(event),
    ),
    transitionRun: vi.fn(async (
      _projectId: string,
      _previousRun: AgentRun,
      result: { event: Omit<AgentEvent, "id" | "sequence">; run: AgentRun },
    ) => {
      fake.runs.set(result.run.id, result.run);
      return {
        event: appendEvent(result.event),
        run: result.run,
      };
    }),
  },
}));

describe("agent run store actions", () => {
  beforeEach(() => {
    fake.activeController = false;
    fake.events = [];
    fake.modifyCalls = [];
    fake.specCalls = [];
    fake.runs = new Map();
    fake.approvals = [];
  });

  it("cancels an inactive paused run immediately", async () => {
    const run = createRun("run-paused", { status: "paused", phase: "paused" });
    fake.runs.set(run.id, run);
    const approval = createApproval(run.id);
    const store = createStore({
      currentAgentApproval: approval,
      currentAgentRun: run,
    });
    const actions = createAgentRunActions(store as never);

    await actions.cancelCurrentAgentRun();

    expect(store.get().currentAgentRun?.status).toBe("cancelled");
    expect(store.get().currentAgentApproval).toBeNull();
    expect(store.get().projectError).toBeNull();
    expect(fake.events.map((event) => event.type)).toEqual([
      "run.cancel_requested",
      "run.cancelled",
    ]);
  });

  it("leaves active cancellation for the running controller", async () => {
    fake.activeController = true;
    const run = createRun("run-active", { status: "planning", phase: "planning" });
    fake.runs.set(run.id, run);
    const store = createStore({ currentAgentRun: run });
    const actions = createAgentRunActions(store as never);

    await actions.cancelCurrentAgentRun();

    expect(store.get().currentAgentRun).toMatchObject({
      cancelRequested: true,
      status: "planning",
    });
    expect(fake.events.map((event) => event.type)).toEqual(["run.cancel_requested"]);
  });

  it("waits for active cancellation to reach a terminal cancelled run", async () => {
    fake.activeController = true;
    const run = createRun("run-active-wait", {
      contract: createSpecContract("modify"),
      conversationId: "conversation-1",
      phase: "planning",
      status: "planning",
    });
    fake.runs.set(run.id, run);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: run.id }),
    });
    const actions = createAgentRunActions(store as never);
    store.set({
      cancelCurrentAgentRun: actions.cancelCurrentAgentRun,
    } as Partial<StoreState>);

    const resultPromise = actions.cancelCurrentAgentRunAndWait();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

    fake.runs.set(run.id, {
      ...fake.runs.get(run.id)!,
      completedAt: "2026-01-01T00:01:00.000Z",
      phase: "cancelled",
      status: "cancelled",
    });

    const result = await resultPromise;

    expect(result?.status).toBe("cancelled");
    expect(store.get().currentAgentRun?.status).toBe("cancelled");
    expect(fake.events.map((event) => event.type)).toEqual(["run.cancel_requested"]);
  });

  it("recovers any inactive non-terminal run instead of only paused runs", async () => {
    const run = createRun("run-planning", { status: "planning", phase: "planning" });
    fake.runs.set(run.id, run);
    const store = createStore({ currentAgentRun: run });
    const actions = createAgentRunActions(store as never);

    await actions.resumeCurrentAgentRun();

    expect(fake.modifyCalls).toHaveLength(1);
    expect(fake.modifyCalls[0]).toMatchObject([
      expect.anything(),
      run.contract.objective,
      { existingRun: run },
    ]);
  });

  it("resumes a Spec run with its original generate execution mode", async () => {
    const run = createRun("run-generate-resume", {
      contract: createSpecContract("generate"),
      conversationId: "conversation-1",
      phase: "paused",
      status: "paused",
    });
    fake.runs.set(run.id, run);
    const continueCurrentSpecExecution = vi.fn(async () => undefined);
    const store = createStore({
      continueCurrentSpecExecution,
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: run.id }),
    });
    const actions = createAgentRunActions(store as never);

    await actions.resumeCurrentAgentRun();

    expect(fake.modifyCalls).toHaveLength(0);
    expect(fake.specCalls).toHaveLength(1);
    expect(fake.specCalls[0]).toMatchObject([
      {
        contract: run.contract,
        conversationId: "conversation-1",
        executionMode: "generate",
        existingRun: run,
        taskObjective: run.contract.objective,
      },
    ]);
    expect(continueCurrentSpecExecution).toHaveBeenCalledTimes(1);
  });

  it("continues Spec orchestration after approval resumes the run", async () => {
    const run = createRun("run-approval-resume", {
      contract: createSpecContract("modify"),
      conversationId: "conversation-1",
      phase: "waiting_approval",
      status: "waiting_approval",
    });
    const approval = createApproval(run.id);
    fake.runs.set(run.id, run);
    fake.approvals.push(approval);
    const continueCurrentSpecExecution = vi.fn(async () => undefined);
    const store = createStore({
      continueCurrentSpecExecution,
      currentAgentApproval: approval,
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: run.id }),
    });
    const actions = createAgentRunActions(store as never);

    await actions.approveCurrentAgentApproval();

    expect(fake.modifyCalls).toHaveLength(0);
    expect(fake.specCalls).toHaveLength(1);
    expect(fake.specCalls[0]).toMatchObject([
      {
        conversationId: "conversation-1",
        executionMode: "modify",
        existingRun: run,
        taskObjective: run.contract.objective,
      },
    ]);
    expect(store.get().currentAgentApproval).toBeNull();
    expect(continueCurrentSpecExecution).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a stale Spec approval from another run", async () => {
    const run = createRun("run-current-approval", {
      contract: createSpecContract("modify"),
      conversationId: "conversation-1",
      phase: "waiting_approval",
      status: "waiting_approval",
    });
    const staleApproval = createApproval("run-other");
    const continueCurrentSpecExecution = vi.fn(async () => undefined);
    fake.runs.set(run.id, run);
    fake.approvals.push(staleApproval);
    const store = createStore({
      continueCurrentSpecExecution,
      currentAgentApproval: staleApproval,
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: run.id }),
    });
    const actions = createAgentRunActions(store as never);

    await actions.approveCurrentAgentApproval();

    expect(fake.specCalls).toHaveLength(0);
    expect(store.get().currentAgentApproval).toBe(staleApproval);
    expect(store.get().projectError).toBe(
      "Approval does not belong to the current AgentRun.",
    );
    expect(continueCurrentSpecExecution).not.toHaveBeenCalled();
  });

  it("does not request pause for waiting approval runs", async () => {
    fake.activeController = true;
    const run = createRun("run-waiting", {
      phase: "waiting_approval",
      status: "waiting_approval",
    });
    fake.runs.set(run.id, run);
    const store = createStore({ currentAgentRun: run });
    const actions = createAgentRunActions(store as never);

    await actions.pauseCurrentAgentRun();

    expect(fake.events).toHaveLength(0);
    expect(store.get().currentAgentRun).toBe(run);
  });

  it("loads resolved waiting approvals so the UI can continue recovery", async () => {
    const run = createRun("run-approved", {
      phase: "waiting_approval",
      status: "waiting_approval",
    });
    const approval = createApproval(run.id, {
      decision: "approved",
      resolvedAt: "2026-01-01T00:01:00.000Z",
    });
    fake.runs.set(run.id, run);
    fake.approvals.push(approval);
    const store = createStore({
      currentAgentRun: null,
      currentConversation: createChatConversation(),
    });
    const actions = createAgentRunActions(store as never);

    await actions.loadAgentRuns("project-1");

    expect(store.get().currentAgentRun?.id).toBe(run.id);
    expect(store.get().currentAgentApproval).toMatchObject({
      decision: "approved",
      id: approval.id,
    });
  });

  it("does not load runs when no conversation is selected", async () => {
    const run = createRun("run-without-selection", {
      conversationId: "conversation-1",
      phase: "planning",
      status: "planning",
    });
    fake.runs.set(run.id, run);
    const store = createStore({ currentConversation: null });
    const actions = createAgentRunActions(store as never);

    await actions.loadAgentRuns("project-1");

    expect(store.get().currentAgentRun).toBeNull();
    expect(store.get().currentAgentApproval).toBeNull();
  });

  it("loads the current Spec task run before unrelated non-terminal runs", async () => {
    const unrelatedRun = createRun("run-unrelated", {
      conversationId: "conversation-other",
      phase: "planning",
      status: "planning",
    });
    const currentSpecRun = createRun("run-current-task", {
      completedAt: "2026-01-01T00:02:00.000Z",
      contract: createSpecContract("modify"),
      conversationId: "conversation-1",
      phase: "completed",
      status: "completed",
    });
    fake.runs.set(unrelatedRun.id, unrelatedRun);
    fake.runs.set(currentSpecRun.id, currentSpecRun);
    const store = createStore({
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: currentSpecRun.id }),
    });
    const actions = createAgentRunActions(store as never);

    await actions.loadAgentRuns("project-1");

    expect(store.get().currentAgentRun?.id).toBe(currentSpecRun.id);
    expect(store.get().currentAgentRun?.conversationId).toBe("conversation-1");
  });

  it("does not load unrelated runs for the current conversation", async () => {
    const unrelatedRun = createRun("run-unrelated", {
      conversationId: "conversation-other",
      phase: "planning",
      status: "planning",
    });
    fake.runs.set(unrelatedRun.id, unrelatedRun);
    const store = createStore({
      currentConversation: createSpecConversation(),
      currentSpec: null,
    });
    const actions = createAgentRunActions(store as never);

    await actions.loadAgentRuns("project-1");

    expect(store.get().currentAgentRun).toBeNull();
    expect(store.get().currentAgentApproval).toBeNull();
  });

  it("does not cancel or steer a Spec run that is not the current running task", async () => {
    const run = createRun("run-other-task", {
      contract: {
        ...compileTaskContract({
          objective: "Spec run",
          taskType: "component_edit",
        }),
        source: {
          acceptanceCriteriaIds: ["criterion-1"],
          executionMode: "modify",
          mode: "spec",
          requirementIds: ["story-1"],
          revisionId: "rev-1",
          specId: "spec-1",
          taskId: "task-other",
        },
      },
      conversationId: "conversation-1",
      phase: "planning",
      status: "planning",
    });
    fake.runs.set(run.id, run);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec(),
    });
    const actions = createAgentRunActions(store as never);

    await actions.cancelCurrentAgentRun();
    await actions.sendAgentSteering("keep going");

    expect(fake.events).toHaveLength(0);
    expect(store.get().currentAgentRun?.status).toBe("planning");
    expect(store.get().projectError).toContain(
      "does not belong to the current Spec task",
    );
  });

  it("does not control a stale Spec run for the current task when the runId differs", async () => {
    const run = createRun("run-stale-task", {
      contract: createSpecContract("modify"),
      conversationId: "conversation-1",
      phase: "planning",
      status: "planning",
    });
    fake.runs.set(run.id, run);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec({ runId: "run-current-task" }),
    });
    const actions = createAgentRunActions(store as never);

    await actions.cancelCurrentAgentRun();
    await actions.sendAgentSteering("continue");

    expect(fake.events).toHaveLength(0);
    expect(store.get().currentAgentRun?.status).toBe("planning");
    expect(store.get().projectError).toContain(
      "does not belong to the current Spec task",
    );
  });

  it("does not treat a terminal Spec run from another task as a valid cancel result", async () => {
    const run = createRun("run-other-terminal", {
      completedAt: "2026-01-01T00:01:00.000Z",
      contract: {
        ...compileTaskContract({
          objective: "Spec run",
          taskType: "component_edit",
        }),
        source: {
          acceptanceCriteriaIds: ["criterion-1"],
          executionMode: "modify",
          mode: "spec",
          requirementIds: ["story-1"],
          revisionId: "rev-1",
          specId: "spec-1",
          taskId: "task-other",
        },
      },
      conversationId: "conversation-1",
      phase: "cancelled",
      status: "cancelled",
    });
    fake.runs.set(run.id, run);
    const store = createStore({
      currentAgentRun: run,
      currentConversation: createSpecConversation(),
      currentSpec: createSpec(),
    });
    const actions = createAgentRunActions(store as never);

    await expect(actions.cancelCurrentAgentRunAndWait()).rejects.toThrow(
      "AgentRun does not belong to the current Spec task.",
    );

    expect(fake.events).toHaveLength(0);
  });
});

function appendEvent(event: Omit<AgentEvent, "id" | "sequence">) {
  const record: AgentEvent = {
    ...event,
    id: `event-${fake.events.length + 1}`,
    sequence: fake.events.length + 1,
  };
  fake.events.push(record);
  return record;
}

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    agentEvents: [],
    agentRuns: [],
    continueCurrentSpecExecution: vi.fn(async () => undefined),
    currentAgentApproval: null,
    currentAgentRun: null,
    currentProject: {
      createdAt: "2026-01-01T00:00:00.000Z",
      framework: "next-app-router",
      id: "project-1",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      name: "Project",
      path: "D:/projects/project-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    currentConversation: null,
    currentSpec: null,
    currentVerificationReport: null,
    projectError: null,
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

type StoreState = {
  agentEvents: AgentEvent[];
  agentRuns: AgentRun[];
  continueCurrentSpecExecution: () => Promise<void>;
  currentAgentApproval: AgentApproval | null;
  currentAgentRun: AgentRun | null;
  currentProject: {
    createdAt: string;
    framework: "next-app-router";
    id: string;
    lastOpenedAt: string;
    name: string;
    path: string;
    updatedAt: string;
  } | null;
  currentConversation: ProjectConversation | null;
  currentSpec: DevelopmentSpec | null;
  currentVerificationReport: null;
  projectError: string | null;
  terminalLogs: string[];
};

function createRun(runId: string, patch: Partial<AgentRun> = {}): AgentRun {
  const now = "2026-01-01T00:00:00.000Z";
  const contract = compileTaskContract({
    objective: "Existing run",
    taskType: "component_edit",
  });

  return {
    cancelRequested: false,
    completedAt: undefined,
    contract,
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

function createSpecContract(
  executionMode: "generate" | "modify",
): AgentRun["contract"] {
  return {
    ...compileTaskContract({
      objective: executionMode === "generate"
        ? "Generate the initial app foundation"
        : "Modify the current app",
      taskType: "component_edit",
    }),
    source: {
      acceptanceCriteriaIds: ["criterion-1"],
      executionMode,
      mode: "spec",
      requirementIds: ["story-1"],
      revisionId: "rev-1",
      specId: "spec-1",
      taskId: "task-1",
    },
  };
}

function createSpecConversation(): ProjectConversation {
  return {
    activeSpecId: "spec-1",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    mode: "spec",
    modeChangedAt: "2026-01-01T00:00:00.000Z",
    projectId: "project-1",
    specIds: ["spec-1"],
    title: "Spec iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createChatConversation(): ProjectConversation {
  return {
    ...createSpecConversation(),
    activeSpecId: null,
    mode: "chat",
    specIds: [],
  };
}

function createSpec(patch: Partial<{ runId: string }> = {}): DevelopmentSpec {
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
            runId: patch.runId ?? "run-current-task",
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

function createApproval(
  runId: string,
  patch: Partial<AgentApproval> = {},
): AgentApproval {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    exactSideEffect: "delete files",
    expiresAt: "2026-01-01T00:30:00.000Z",
    id: `approval-${runId}`,
    normalizedArgsHash: "12:abcd",
    runId,
    targetResources: ["components/Old.tsx"],
    toolCallId: "tool-call-1",
    toolName: "delete_files",
    ...patch,
  };
}
