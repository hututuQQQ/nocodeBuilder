import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunCheckpoint, AgentEvent, VerificationReport } from "../agent-core/types";

const fake = vi.hoisted(() => ({
  actions: [] as unknown[],
  checkpoints: [] as AgentRunCheckpoint[],
  events: [] as AgentEvent[],
  reports: [] as VerificationReport[],
  runs: new Map<string, AgentRun>(),
  toolNames: [] as string[],
  verifierInputs: [] as unknown[],
  verificationStatuses: [] as Array<VerificationReport["status"]>,
}));

vi.mock("../agent/projectModifier", () => ({
  formatProjectFileTree: () => "app/page.tsx",
  getContextFilePaths: () => ["app/page.tsx"],
  requestAgentStep: vi.fn(async () => {
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
    createApproval: vi.fn(async (_projectId, approval) => approval),
    createRun: vi.fn(async (_projectId, run: AgentRun) => {
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
    getPendingApproval: vi.fn(async () => null),
    getRun: vi.fn(async (_projectId, runId) => fake.runs.get(runId) ?? null),
    listApprovals: vi.fn(async () => []),
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
    return {
      changedFiles: ["app/page.tsx"],
      didChangeFiles: true,
      didChangePackage: false,
      observation: {
        content: "edited",
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
    fake.checkpoints = [];
    fake.events = [];
    fake.reports = [];
    fake.runs = new Map();
    fake.toolNames = [];
    fake.verifierInputs = [];
    fake.verificationStatuses = [];
  });

  it("routes production modify flow through the headless controller", async () => {
    fake.actions = [
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
      toolCalls: 1,
      mutationCount: 1,
    });
    expect(fake.toolNames).toEqual(["edit_file"]);
    expect(fake.verifierInputs).toHaveLength(2);
    expect(fake.events.map((event) => event.type)).toContain("run.completed");
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
