import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApproval,
  AgentRun,
  AgentRunCheckpoint,
  AgentEvent,
  VerificationReport,
} from "../agent-core/types";
import { compileTaskContract } from "../agent-core/contract/taskContract";

const fake = vi.hoisted(() => ({
  actions: [] as unknown[],
  approvals: [] as AgentApproval[],
  checkpoints: [] as AgentRunCheckpoint[],
  events: [] as AgentEvent[],
  modelContexts: [] as unknown[],
  rejectNextCreateRun: false,
  reports: [] as VerificationReport[],
  runs: new Map<string, AgentRun>(),
  toolNames: [] as string[],
  verifierInputs: [] as unknown[],
  verificationStatuses: [] as Array<VerificationReport["status"]>,
}));

vi.mock("../agent/projectModifier", () => ({
  formatProjectFileTree: () => "app/page.tsx",
  getContextFilePaths: () => ["app/page.tsx"],
  requestAgentStep: vi.fn(async ({ context }) => {
    fake.modelContexts.push(context);
    const action = fake.actions.shift();

    if (!action) {
      throw new Error("No fake model action queued.");
    }

    return action;
  }),
  requestProjectGeneration: vi.fn(),
}));

vi.mock("../agent/project/backendContext", () => ({
  buildProjectBackendContext: vi.fn(async () => null),
  hasBackendIntent: () => false,
}));

vi.mock("../agent/project/memory", () => ({
  buildDynamicAgentContext: vi.fn(async ({ observations }) => ({
    memory: null,
    observations,
    taskLedger: null,
    workingSummary: null,
  })),
}));

vi.mock("../agent-core/verifier/verifier", () => ({
  AgentVerifier: class {
    async verify(input: { run: AgentRun }) {
      fake.verifierInputs.push(input);
      const status = fake.verificationStatuses.shift() ?? "passed";
      const report: VerificationReport = {
        artifactIds: [],
        checks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        id: `report-${fake.reports.length + 1}`,
        missingEvidence: status === "inconclusive" ? ["missing"] : [],
        newlyIntroducedFailures: status === "failed" ? ["failed"] : [],
        repairFeedback: status === "failed" ? ["repair"] : [],
        runId: input.run.id,
        status,
      };
      fake.reports.push(report);
      return report;
    }
  },
}));

vi.mock("../adapters/siteIrAdapter", () => ({
  addStableNodeIdsToGeneratedFiles: (files: unknown[]) => files,
  ensureSiteIndex: vi.fn(async () => null),
  refreshSiteIndex: vi.fn(async () => null),
}));

vi.mock("../services/keyStore", () => ({
  keyStore: {
    getAiProviderConfig: vi.fn(async () => ({
      baseUrl: null,
      model: "fake-model",
      provider: "openai",
    })),
  },
}));

vi.mock("../services/aiProviders", () => ({
  getAiProviderDefinition: () => ({ label: "Fake AI" }),
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    listFiles: vi.fn(async () => ({
      path: "",
      children: [{ path: "app/page.tsx" }],
    })),
    readFile: vi.fn(async () => "{}"),
  },
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
    appendEvent: vi.fn(async (_projectId, event) => appendEvent(event)),
    createApproval: vi.fn(async (_projectId, approval) => {
      fake.approvals.push(approval);
      return approval;
    }),
    createRun: vi.fn(async (_projectId, run: AgentRun) => {
      if (fake.rejectNextCreateRun) {
        fake.rejectNextCreateRun = false;
        throw new Error("agent-storage: active write run run-existing already exists for project project-1");
      }

      fake.runs.set(run.id, run);
      appendEvent({
        runId: run.id,
        type: "run.created",
        timestamp: run.startedAt,
        payload: { status: run.status },
      });
      return run;
    }),
    getLatestCheckpoint: vi.fn(async (_projectId, runId) =>
      [...fake.checkpoints].reverse().find((checkpoint) => checkpoint.runId === runId) ?? null,
    ),
    getPendingApproval: vi.fn(async (_projectId, runId) =>
      fake.approvals.find((approval) => approval.runId === runId && !approval.decision) ?? null,
    ),
    getRun: vi.fn(async (_projectId, runId) => fake.runs.get(runId) ?? null),
    listApprovals: vi.fn(async (_projectId, runId) =>
      fake.approvals.filter((approval) => approval.runId === runId),
    ),
    listEvents: vi.fn(async (_projectId, runId) =>
      fake.events.filter((event) => event.runId === runId),
    ),
    readSiteSpec: vi.fn(async () => null),
    recordProgress: vi.fn(async (_projectId, previousRun: AgentRun, nextRun: AgentRun, event) => {
      const run = {
        ...nextRun,
        stateVersion: previousRun.stateVersion + 1,
      };
      fake.runs.set(run.id, run);
      return { run, event: appendEvent(event) };
    }),
    saveCheckpoint: vi.fn(async (_projectId, checkpoint: AgentRunCheckpoint) => {
      fake.checkpoints.push(checkpoint);
      return checkpoint;
    }),
    saveVerificationReport: vi.fn(async (_projectId, report) => report),
    transitionRun: vi.fn(async (_projectId, _previousRun: AgentRun, result) => {
      fake.runs.set(result.run.id, result.run);
      return { run: result.run, event: appendEvent(result.event) };
    }),
    writeArtifact: vi.fn(async () => ({ id: `artifact-${fake.events.length}` })),
  },
}));

vi.mock("../store/agentToolExecutor", () => ({
  createAgentRunState: () => ({
    packageBaselineJson: null,
    readFiles: new Map(),
  }),
  ensureCurrentProject: vi.fn(),
  executeAgentTool: vi.fn(async (_store, _project, step, observationStep) => {
    fake.toolNames.push(step.tool);
    const readOnlyTools = new Set([
      "find_site_node",
      "get_page_spec",
      "get_site_spec",
      "glob_files",
      "grep_files",
      "list_files",
      "read_files",
      "resolve_node_source",
    ]);
    const changedFiles = step.tool === "delete_files"
      ? ["components/Old.tsx"]
      : ["app/page.tsx"];

    return {
      changedFiles,
      deletedFiles: step.tool === "delete_files" ? ["components/Old.tsx"] : undefined,
      didChangeFiles: !readOnlyTools.has(step.tool),
      didChangePackage: false,
      observation: {
        content: `ran ${step.tool}`,
        ok: true,
        step: observationStep,
        summary: `Ran ${step.tool}`,
        tool: step.tool,
      },
    };
  }),
}));

vi.mock("../store/agentUi", () => ({
  appendAssistantMessage: vi.fn(),
  appendTerminalLog: vi.fn(),
  startStreamingAgentMessage: vi.fn(() => ({
    addActivity: vi.fn(() => "activity-1"),
    completeWithTypewriter: vi.fn(),
    failWithTypewriter: vi.fn(),
    messageId: "message-1",
    onDelta: vi.fn(),
    onModelDelta: vi.fn(),
    setStatus: vi.fn(),
    updateActivity: vi.fn(),
  })),
  updateAgentStatus: vi.fn(),
}));

vi.mock("../store/conversationState", () => ({
  persistCurrentConversation: vi.fn(),
}));

const { modifyCurrentProjectRuntime } = await import("./applicationAdapter");

describe("Application runtime adapter", () => {
  beforeEach(() => {
    fake.actions = [];
    fake.approvals = [];
    fake.checkpoints = [];
    fake.events = [];
    fake.modelContexts = [];
    fake.rejectNextCreateRun = false;
    fake.reports = [];
    fake.runs = new Map();
    fake.toolNames = [];
    fake.verifierInputs = [];
    fake.verificationStatuses = [];
  });

  it("completes a simple answer through the production adapter", async () => {
    fake.actions = [
      {
        type: "answer",
        message: "The project is already up to date.",
      },
    ];
    fake.verificationStatuses = ["passed"];
    const store = createFakeStore();

    const result = await modifyCurrentProjectRuntime(store, "What changed?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run).toMatchObject({
      status: "completed",
      modelTurns: 1,
      toolCalls: 0,
    });
  });

  it("routes read, edit, auto-verify, finish through the headless controller", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Read the page",
        args: { paths: ["app/page.tsx"] },
      },
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Change copy",
        args: {
          new_string: "Hello",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Update copy",
        },
      },
      {
        type: "finish_candidate",
        summary: "Copy updated",
      },
    ];
    fake.verificationStatuses = ["passed", "passed"];
    const store = createFakeStore();

    const result = await modifyCurrentProjectRuntime(store, "Change hero copy");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run).toMatchObject({
      status: "completed",
      toolCalls: 2,
      mutationCount: 1,
    });
    expect(fake.toolNames).toEqual(["read_files", "edit_file"]);
    expect(fake.verifierInputs).toHaveLength(2);
    expect(fake.events.map((event) => event.type)).toContain("run.completed");
  });

  it("repairs after failed auto-verification and then completes", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "First attempt",
        args: {
          new_string: "Broken",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Break copy",
        },
      },
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Repair",
        args: {
          new_string: "Fixed",
          old_string: "Broken",
          path: "app/page.tsx",
          summary: "Repair copy",
        },
      },
      {
        type: "finish_candidate",
        summary: "Repair complete",
      },
    ];
    fake.verificationStatuses = ["failed", "passed", "passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Fix broken preview");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run).toMatchObject({
      repairCycles: 1,
      status: "completed",
      toolCalls: 2,
    });
    expect(fake.toolNames).toEqual(["edit_file", "edit_file"]);
  });

  it("replays the exact approved action after approval resolution", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "delete_files",
        rationale: "Remove obsolete component",
        args: {
          paths: ["components/Old.tsx"],
          summary: "Remove old component",
        },
      },
    ];
    const store = createFakeStore();

    const waiting = await modifyCurrentProjectRuntime(store, "Remove obsolete component");
    const waitingRun = [...fake.runs.values()][0];

    expect(waiting).toBe(false);
    expect(waitingRun.status).toBe("waiting_approval");
    expect(fake.approvals).toHaveLength(1);
    fake.approvals[0] = {
      ...fake.approvals[0],
      decision: "approved",
      resolvedAt: "2026-01-01T00:01:00.000Z",
    };
    fake.actions = [{ type: "finish_candidate", summary: "Deleted old component" }];
    fake.verificationStatuses = ["passed", "passed"];

    const completed = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });
    const run = [...fake.runs.values()][0];

    expect(completed).toBe(true);
    expect(run.status).toBe("completed");
    expect(fake.toolNames).toEqual(["delete_files"]);
  });

  it("does not count expired approvals in the production approval port", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "delete_files",
        rationale: "Remove obsolete component",
        args: {
          paths: ["components/Old.tsx"],
          summary: "Remove old component",
        },
      },
    ];
    const store = createFakeStore();
    await modifyCurrentProjectRuntime(store, "Remove obsolete component");
    const waitingRun = [...fake.runs.values()][0];
    fake.approvals[0] = {
      ...fake.approvals[0],
      decision: "approved",
      expiresAt: "2000-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:01:00.000Z",
    };

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });
    const run = fake.runs.get(waitingRun.id);

    expect(result).toBe(false);
    expect(run?.status).toBe("waiting_approval");
    expect(fake.toolNames).toEqual([]);
  });

  it("requires a fresh approval when approved args hash differs", async () => {
    const deleteAction = {
      type: "tool_call",
      tool: "delete_files",
      rationale: "Remove obsolete component",
      args: {
        paths: ["components/Old.tsx"],
        summary: "Remove old component",
      },
    };
    fake.actions = [deleteAction];
    const store = createFakeStore();
    await modifyCurrentProjectRuntime(store, "Remove obsolete component");
    const waitingRun = [...fake.runs.values()][0];
    fake.approvals[0] = {
      ...fake.approvals[0],
      decision: "approved",
      normalizedArgsHash: "wrong-hash",
      resolvedAt: "2026-01-01T00:01:00.000Z",
    };
    fake.actions = [deleteAction];

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });
    const run = fake.runs.get(waitingRun.id);

    expect(result).toBe(false);
    expect(run?.status).toBe("waiting_approval");
    expect(fake.toolNames).toEqual([]);
    expect(fake.approvals).toHaveLength(2);
  });

  it("resumes a paused run from a persisted checkpoint and completes", async () => {
    const pausedRun = createExistingRun("run-paused", {
      status: "paused",
      toolCalls: 1,
    });
    fake.runs.set(pausedRun.id, pausedRun);
    fake.checkpoints.push(createCheckpoint(pausedRun, {
      changedFiles: ["app/page.tsx"],
      observations: ["Read app/page.tsx before pause"],
    }));
    fake.actions = [{ type: "finish_candidate", summary: "Resume complete" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Continue paused run", {
      existingRun: pausedRun,
    });
    const run = fake.runs.get(pausedRun.id);

    expect(result).toBe(true);
    expect(run).toMatchObject({
      status: "completed",
      toolCalls: 1,
    });
  });

  it("passes steering events into the next model context", async () => {
    const run = createExistingRun("run-steering");
    fake.runs.set(run.id, run);
    fake.events.push(
      {
        id: "event-1",
        payload: { content: "From chat" },
        runId: run.id,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "steering.received",
      },
      {
        id: "event-2",
        payload: { content: "From AgentRunPanel" },
        runId: run.id,
        sequence: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "steering.received",
      },
    );
    fake.checkpoints.push(createCheckpoint(run));
    fake.actions = [{ type: "answer", message: "Steering received." }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Continue", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.modelContexts[0]).toMatchObject({
      steering: ["From chat", "From AgentRunPanel"],
    });
  });

  it("allows repair after a preview-style first verification failure", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Fix preview",
        args: {
          new_string: "Attempt",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Attempt fix",
        },
      },
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Repair preview",
        args: {
          new_string: "Fixed",
          old_string: "Attempt",
          path: "app/page.tsx",
          summary: "Repair preview",
        },
      },
      { type: "finish_candidate", summary: "Preview fixed" },
    ];
    fake.verificationStatuses = ["failed", "passed", "passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Fix preview error");

    expect(result).toBe(true);
    expect(fake.reports.map((report) => report.status)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
  });

  it("executes Site IR tools through the production adapter", async () => {
    fake.actions = [
      {
        type: "tool_call",
        tool: "get_site_spec",
        rationale: "Inspect SiteSpec",
        args: {},
      },
      { type: "answer", message: "SiteSpec inspected." },
    ];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Inspect Site IR");

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual(["get_site_spec"]);
  });

  it("enforces maxToolCalls in the production adapter path", async () => {
    const run = createExistingRun("run-tool-budget", {
      contract: lowBudgetContract({ maxToolCalls: 0 }),
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run));
    fake.actions = [
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Should not execute",
        args: { paths: ["app/page.tsx"] },
      },
    ];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Read a file", {
      existingRun: run,
    });
    const persisted = fake.runs.get(run.id);

    expect(result).toBe(false);
    expect(persisted?.status).toBe("budget_exceeded");
    expect(fake.toolNames).toEqual([]);
  });

  it("enforces maxMutations in the production adapter path", async () => {
    const run = createExistingRun("run-mutation-budget", {
      contract: lowBudgetContract({ maxMutations: 1 }),
      mutationCount: 1,
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run));
    fake.actions = [
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Should not execute",
        args: {
          new_string: "Hello",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Edit copy",
        },
      },
    ];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Edit copy", {
      existingRun: run,
    });
    const persisted = fake.runs.get(run.id);

    expect(result).toBe(false);
    expect(persisted?.status).toBe("budget_exceeded");
    expect(fake.toolNames).toEqual([]);
  });

  it("surfaces same-project second write run rejection", async () => {
    fake.rejectNextCreateRun = true;
    fake.actions = [{ type: "answer", message: "Should not run" }];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Start another write run");

    expect(result).toBe(false);
    expect(fake.runs.size).toBe(0);
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

function createExistingRun(
  runId: string,
  patch: Partial<AgentRun> = {},
): AgentRun {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    cancelRequested: false,
    completedAt: undefined,
    contract: compileTaskContract({
      objective: "Existing run",
      taskType: "component_edit",
    }),
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

function lowBudgetContract(
  budget: Partial<AgentRun["contract"]["budget"]>,
): AgentRun["contract"] {
  const contract = compileTaskContract({
    objective: "Budget-limited run",
    taskType: "component_edit",
  });

  return {
    ...contract,
    budget: {
      ...contract.budget,
      ...budget,
    },
  };
}

function createCheckpoint(
  run: AgentRun,
  patch: Partial<AgentRunCheckpoint> = {},
): AgentRunCheckpoint {
  return {
    changedFiles: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedFiles: [],
    id: `checkpoint-${run.id}`,
    observations: [],
    packageChanged: false,
    plan: null,
    readSnapshots: [],
    repairFeedback: [],
    runId: run.id,
    steeringWatermark: 0,
    workspaceFingerprint: workspaceFingerprint(),
    ...patch,
  };
}

function workspaceFingerprint() {
  return hashText(`app/page.tsx:${hashText("{}")}`);
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function createFakeStore() {
  let state: Record<string, unknown> = {
    agentEvents: [],
    agentRuns: [],
    changeHistory: [],
    currentAgentRun: null,
    currentConversation: { id: "conversation-1", messages: [] },
    currentProject: { id: "project-1", name: "Project" },
    currentVerificationReport: null,
    devServerStatus: "running",
    fileTree: { path: "", children: [{ path: "app/page.tsx" }] },
    previewDiagnostics: [],
    previewRefreshKey: 0,
    previewUrl: "http://localhost:3000",
    previewVerificationSession: null,
    previewVerificationSessions: [],
    projectError: null,
    runProjectCommand: async (_projectId: string, command: string) => ({
      command,
      exitCode: 0,
      output: "ok",
      success: true,
    }),
    selectedSiteNodeId: null,
    startDevServer: async () => undefined,
    stopDevServer: async () => undefined,
    terminalLogs: [],
  };

  return {
    get: () => state,
    set: (patch: unknown) => {
      const nextPatch = typeof patch === "function"
        ? (patch as (current: typeof state) => Partial<typeof state>)(state)
        : patch;
      state = {
        ...state,
        ...(nextPatch as Record<string, unknown>),
      };
    },
  } as never;
}
