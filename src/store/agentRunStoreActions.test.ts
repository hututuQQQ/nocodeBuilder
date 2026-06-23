import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import type { AgentApproval, AgentEvent, AgentRun } from "../agent-core/types";
import { createAgentRunActions } from "./agentRunStoreActions";

const fake = vi.hoisted(() => ({
  activeController: false,
  events: [] as AgentEvent[],
  modifyCalls: [] as unknown[],
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
    const store = createStore({ currentAgentRun: null });
    const actions = createAgentRunActions(store as never);

    await actions.loadAgentRuns("project-1");

    expect(store.get().currentAgentRun?.id).toBe(run.id);
    expect(store.get().currentAgentApproval).toMatchObject({
      decision: "approved",
      id: approval.id,
    });
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
