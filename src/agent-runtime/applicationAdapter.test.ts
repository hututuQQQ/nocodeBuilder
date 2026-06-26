import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApproval,
  AgentRun,
  AgentRunCheckpoint,
  AgentEvent,
  VerificationReport,
} from "../agent-core/types";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import type { AgentStepContext } from "../agent/project/types";
import { compileSpecTaskContract } from "../spec-core/taskCompiler";
import type { DevelopmentSpec } from "../spec-core/types";
import type { ProjectInfo } from "../services/projects";
import { AgentStepValidationError } from "../agent/project/requests";
import { LlmClientError } from "../agent/llm/errors";

const fake = vi.hoisted(() => ({
  actions: [] as unknown[],
  approvals: [] as AgentApproval[],
  checkpoints: [] as AgentRunCheckpoint[],
  completedMessages: [] as string[],
  commandCalls: [] as string[],
  commandThrows: false,
  devServerStarts: 0,
  devServerStops: 0,
  events: [] as AgentEvent[],
  failedMessages: [] as string[],
  generationFiles: [] as Array<{ content: string; path: string }>,
  modelContexts: [] as unknown[],
  previewProbeResults: [] as Array<{ ok: boolean; status: number; summary: string }>,
  previewProbeUrls: [] as string[],
  projectFiles: {} as Record<string, string>,
  requireReadBeforeWrite: false,
  rejectNextCreateRun: false,
  reports: [] as VerificationReport[],
  runs: new Map<string, AgentRun>(),
  throwToolName: null as string | null,
  throwVerifier: false,
  toolNames: [] as string[],
  verifierInputs: [] as unknown[],
  verifierPorts: [] as unknown[],
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

    if (action instanceof Error) {
      throw action;
    }

    if (typeof action === "function") {
      return action(context);
    }

    return action;
  }),
  requestProjectGeneration: vi.fn(async () => ({
    files: fake.generationFiles,
    summary: "Generated project files",
  })),
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
    private readonly ports: {
      httpProbe?: (url: string) => Promise<unknown>;
    };

    constructor(ports: { httpProbe?: (url: string) => Promise<unknown> }) {
      this.ports = ports;
      fake.verifierPorts.push(ports);
    }

    async verify(input: { run: AgentRun }) {
      if (fake.throwVerifier) {
        throw new Error("Verifier exploded");
      }

      if (input.run.contract.taskType !== "answer") {
        await this.ports.httpProbe?.("http://localhost:3000");
      }
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
    probePreviewUrl: vi.fn(async (url: string) => {
      fake.previewProbeUrls.push(url);
      return fake.previewProbeResults.shift() ?? {
        ok: true,
        status: 200,
        summary: "ok",
      };
    }),
    readFile: vi.fn(async (_projectId, path: string) => fake.projectFiles[path] ?? "{}"),
  },
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
    appendEvent: vi.fn(async (_projectId, event) => appendEvent(event)),
    createApproval: vi.fn(async (_projectId, approval) => {
      fake.approvals.push(approval);
      return approval;
    }),
    claimApproval: vi.fn(async (_projectId, claim) => {
      const approval = fake.approvals.find(
        (item) =>
          item.id === claim.approvalId &&
          item.runId === claim.runId &&
          item.decision === "approved" &&
          item.normalizedArgsHash === claim.normalizedArgsHash &&
          !item.consumedAt,
      );

      if (!approval) {
        throw new Error("agent-storage: approval consumption claim failed");
      }

      approval.consumedAt = claim.consumedAt;
      approval.consumedToolCallId = claim.toolCallId;
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
      fake.approvals.find(
        (approval) =>
          approval.runId === runId &&
          !approval.decision &&
          !approval.resolvedAt,
      ) ?? null,
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
      const persisted = fake.runs.get(previousRun.id);

      if (persisted && persisted.stateVersion !== previousRun.stateVersion) {
        throw new Error("agent-storage: stale run stateVersion");
      }

      const run = {
        ...nextRun,
        stateVersion: previousRun.stateVersion + 1,
      };
      fake.runs.set(run.id, run);
      return { run, event: appendEvent(event) };
    }),
    resolveApproval: vi.fn(async (_projectId, runId, approvalId, decision, resolvedAt) => {
      const approval = fake.approvals.find(
        (item) => item.runId === runId && item.id === approvalId,
      );

      if (!approval) {
        throw new Error("approval not found");
      }

      approval.decision = decision;
      approval.resolvedAt = resolvedAt;
      return approval;
    }),
    saveCheckpoint: vi.fn(async (_projectId, checkpoint: AgentRunCheckpoint) => {
      fake.checkpoints.push(checkpoint);
      return checkpoint;
    }),
    saveVerificationReport: vi.fn(async (_projectId, report) => report),
    transitionRun: vi.fn(async (_projectId, previousRun: AgentRun, result) => {
      const persisted = fake.runs.get(previousRun.id);

      if (persisted && persisted.stateVersion !== previousRun.stateVersion) {
        throw new Error("agent-storage: stale run stateVersion");
      }

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
  executeAgentTool: vi.fn(async (_store, _project, step, observationStep, runState) => {
    fake.toolNames.push(step.tool);
    if (step.tool === fake.throwToolName) {
      throw new Error("Tool exploded");
    }
    if (step.tool === "read_files") {
      for (const path of step.args.paths) {
        runState.readFiles.set(path, {
          content: "{}",
          contentHash: hashText("{}"),
          path,
          readAt: "2026-01-01T00:00:00.000Z",
        });
      }
    }
    if (fake.requireReadBeforeWrite && step.tool === "edit_file" && !runState.readFiles.has(step.args.path)) {
      return {
        didChangeFiles: false,
        observation: {
          content: "Read the file before editing.",
          ok: false,
          step: observationStep,
          summary: "Read required before editing.",
          tool: step.tool,
        },
      };
    }
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
    const writtenFiles =
      step.tool === "write_files" &&
      typeof step.args === "object" &&
      step.args !== null &&
      Array.isArray((step.args as { files?: unknown }).files)
        ? (step.args as { files: Array<{ path?: unknown }> }).files
            .map((file) => file.path)
            .filter((path): path is string => typeof path === "string")
        : [];
    const changedFiles = step.tool === "delete_files"
      ? ["components/Old.tsx"]
      : writtenFiles.length > 0
        ? writtenFiles
        : ["app/page.tsx"];

    return {
      changedFiles,
      deletedFiles: step.tool === "delete_files" ? ["components/Old.tsx"] : undefined,
      didChangeFiles: !readOnlyTools.has(step.tool),
      didChangePackage: changedFiles.some((path) => path.replace(/\\/g, "/") === "package.json"),
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
    completeWithTypewriter: vi.fn((message: string) => {
      fake.completedMessages.push(message);
    }),
    failWithTypewriter: vi.fn((message: string) => {
      fake.failedMessages.push(message);
    }),
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

const {
  generateInitialProjectRuntime,
  modifyCurrentProjectRuntime,
  runSpecTaskRuntime,
} = await import("./applicationAdapter");
const conversationState = await import("../store/conversationState");

describe("Application runtime adapter", () => {
  beforeEach(() => {
    fake.actions = [];
    fake.approvals = [];
    fake.checkpoints = [];
    fake.completedMessages = [];
    fake.commandCalls = [];
    fake.commandThrows = false;
    fake.devServerStarts = 0;
    fake.devServerStops = 0;
    fake.events = [];
    fake.failedMessages = [];
    fake.generationFiles = [];
    fake.modelContexts = [];
    fake.previewProbeResults = [];
    fake.previewProbeUrls = [];
    fake.projectFiles = {};
    fake.requireReadBeforeWrite = false;
    fake.rejectNextCreateRun = false;
    fake.reports = [];
    fake.runs = new Map();
    fake.throwToolName = null;
    fake.throwVerifier = false;
    fake.toolNames = [];
    fake.verifierInputs = [];
    fake.verifierPorts = [];
    fake.verificationStatuses = [];
    vi.mocked(conversationState.persistCurrentConversation).mockClear();
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

    const result = await modifyCurrentProjectRuntime(store, "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run).toMatchObject({
      status: "completed",
      modelTurns: 1,
      toolCalls: 0,
    });
  });

  it("turns agent response validation errors into retry observations", async () => {
    fake.actions = [
      new AgentStepValidationError({
        attempts: 3,
        invalidResponse: {
          args: {
            tables: [
              {
                columns: [{ dataType: "int2", name: "seat" }],
                name: "room_players",
              },
            ],
          },
          tool: "apply_supabase_schema",
          type: "tool_call",
        },
        validationError: "Invalid model response: unsupported Supabase column type \"int2\".",
      }),
      {
        type: "finish_candidate",
        summary: "Schema response repaired",
      },
    ];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(
      createFakeStore(),
      "Create poker room schema",
    );
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run).toMatchObject({
      modelTurns: 2,
      status: "completed",
    });
    expect(fake.failedMessages).toEqual([]);
    expect(fake.events.map((event) => event.type)).toContain("model.failed");
    expect(JSON.stringify(fake.modelContexts[1])).toContain("model_validation");
    expect(JSON.stringify(fake.modelContexts[1])).toContain("int2");
  });

  it("injects resume observations into a new runtime run", async () => {
    fake.actions = [
      {
        type: "answer",
        message: "Continued from retry context.",
      },
    ];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(
      createFakeStore(),
      "Continue task",
      {
        resumeObservation: {
          content: "Previous run status: budget_exceeded\nFix the Supabase schema.",
          ok: false,
          step: 1,
          summary: "Continuing after budget exhaustion.",
          tool: "spec_retry_context",
        },
      },
    );

    expect(result).toBe(true);
    expect(JSON.stringify(fake.modelContexts[0])).toContain("spec_retry_context");
    expect(JSON.stringify(fake.modelContexts[0])).toContain("budget_exceeded");
  });

  it("classifies answer tasks before baseline commands and skips build checks", async () => {
    fake.actions = [
      {
        type: "answer",
        message: "The app is healthy enough to answer this status question.",
      },
    ];
    fake.commandThrows = true;
    fake.projectFiles = {
      "package.json": JSON.stringify({
        scripts: {
          build: "next build",
          lint: "eslint .",
          test: "vitest run",
        },
      }),
    };
    fake.verificationStatuses = ["passed"];
    const store = createFakeStore();

    const result = await modifyCurrentProjectRuntime(store, "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run.contract.taskType).toBe("answer");
    expect(run.status).toBe("completed");
    expect(fake.commandCalls).toEqual([]);
    expect(fake.previewProbeUrls).toEqual([]);
    expect(fake.completedMessages[0]).toContain("The app is healthy enough");
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

  it("restarts preview and retries once when the verifier probe sees HTTP 500", async () => {
    fake.actions = [
      {
        type: "finish_candidate",
        summary: "Change completed",
      },
    ];
    fake.previewProbeResults = [
      { ok: false, status: 500, summary: "Internal Server Error" },
      { ok: true, status: 200, summary: "ok" },
    ];
    const store = createFakeStore();

    const result = await modifyCurrentProjectRuntime(store, "Change hero copy");

    expect(result).toBe(true);
    expect(fake.previewProbeUrls).toEqual([
      "http://localhost:3000",
      "http://localhost:3000",
    ]);
    expect(fake.devServerStops).toBe(1);
    expect(fake.devServerStarts).toBe(1);
  });

  it("does not project stale run results into another conversation", async () => {
    let store: FakeStore;
    fake.actions = [
      () => {
        store.set({
          agentEvents: [],
          currentAgentRun: null,
          currentConversation: {
            id: "conversation-2",
            messages: [],
            mode: "chat",
            projectId: "project-1",
          },
          currentVerificationReport: null,
        });

        return {
          type: "answer",
          message: "Finished after the user switched conversations.",
        };
      },
    ];
    fake.verificationStatuses = ["passed"];
    store = createFakeStore() as unknown as FakeStore;

    const result = await modifyCurrentProjectRuntime(
      store as never,
      "Answer after context switch",
    );
    const run = [...fake.runs.values()][0];

    expect(result).toBe(true);
    expect(run.status).toBe("completed");
    expect(store.get().currentConversation).toMatchObject({
      id: "conversation-2",
    });
    expect(store.get().currentAgentRun).toBeNull();
    expect(store.get().agentEvents).toEqual([]);
    expect(store.get().currentVerificationReport).toBeNull();
    expect(conversationState.persistCurrentConversation).not.toHaveBeenCalled();
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

  it("sets currentAgentApproval immediately when approval is requested", async () => {
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

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component");
    const state = (store as { get: () => {
      currentAgentApproval: AgentApproval | null;
      currentAgentRun: AgentRun | null;
    } }).get();

    expect(result).toBe(false);
    expect(state.currentAgentRun?.status).toBe("waiting_approval");
    expect(state.currentAgentApproval).toMatchObject({
      normalizedArgsHash: fake.approvals[0]?.normalizedArgsHash,
      runId: state.currentAgentRun?.id,
      targetResources: ["components/Old.tsx"],
      toolName: "delete_files",
    });
  });

  it("continues initial generation without approval when write_files includes package.json", async () => {
    fake.generationFiles = [
      { path: "package.json", content: "{\"scripts\":{\"build\":\"next build\"}}" },
      { path: "app/page.tsx", content: "export default function Page() { return null; }" },
    ];
    fake.actions = [
      {
        type: "finish_candidate",
        summary: "Initial project generated",
      },
    ];
    const store = createFakeStore();
    const project = (store as { get: () => { currentProject: ProjectInfo } })
      .get()
      .currentProject;

    const result = await generateInitialProjectRuntime(store, project, "Build a new app");
    const state = (store as { get: () => {
      currentAgentApproval: AgentApproval | null;
      currentAgentRun: AgentRun | null;
    } }).get();

    expect(result).toBe(true);
    expect(state.currentAgentRun?.status).toBe("completed");
    expect(state.currentAgentApproval).toBeNull();
    expect(fake.approvals).toHaveLength(0);
    expect(fake.toolNames).toEqual(["write_files"]);
    expect(fake.verifierInputs[0]).toMatchObject({
      changedFiles: expect.arrayContaining(["package.json", "app/page.tsx"]),
      packageChanged: true,
    });
  });

  it("keeps stale approvals waiting until the user decides", async () => {
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
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    fake.actions = [
      {
        type: "tool_call",
        tool: "delete_files",
        rationale: "Request it again",
        args: {
          paths: ["components/Old.tsx"],
          summary: "Remove old component",
        },
      },
    ];

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });
    const run = fake.runs.get(waitingRun.id);

    expect(result).toBe(false);
    expect(run?.status).toBe("waiting_approval");
    expect(fake.toolNames).toEqual([]);
    expect(fake.approvals).toHaveLength(1);
    expect(fake.approvals[0]?.decision).toBeUndefined();
    expect(fake.approvals[0]?.resolvedAt).toBeUndefined();
    expect(fake.events.map((event) => event.type)).not.toContain("approval.expired");
  });

  it("resumes an approved action even when the user clicked after expiresAt", async () => {
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
      expiresAt: "2000-01-01T00:10:00.000Z",
      resolvedAt: "2000-01-01T00:11:00.000Z",
    };
    fake.actions = [{ type: "finish_candidate", summary: "Deleted old component" }];
    fake.verificationStatuses = ["passed", "passed"];

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual(["delete_files"]);
    expect(fake.runs.get(waitingRun.id)?.status).toBe("completed");
  });

  it("keeps an in-window denied decision valid after expiresAt", async () => {
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
      decision: "denied",
      expiresAt: "2000-01-01T00:10:00.000Z",
      resolvedAt: "2000-01-01T00:01:00.000Z",
    };
    fake.actions = [{ type: "finish_candidate", summary: "Skipped deletion" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(store, "Remove obsolete component", {
      existingRun: waitingRun,
    });

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual([]);
    expect(fake.modelContexts[1]).toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({
          content: "Approval denied by user.",
          summary: "Approval denied by user.",
        }),
      ]),
    });
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

  it("recovers an inactive exploring run by normalizing to planning", async () => {
    const run = createExistingRun("run-exploring-recover", {
      phase: "exploring",
      status: "exploring",
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run, {
      observations: ["Read-only tool was interrupted."],
    }));
    fake.actions = [{ type: "finish_candidate", summary: "Recovered from exploring" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Recover exploring", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.runs.get(run.id)?.status).toBe("completed");
    expect(fake.events.map((event) => event.type)).toContain("run.recovered");
  });

  it("recovers an inactive mutating run without replaying the interrupted write", async () => {
    const run = createExistingRun("run-mutating-recover", {
      phase: "mutating",
      status: "mutating",
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run));
    fake.actions = [{ type: "finish_candidate", summary: "Recovered from mutation" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Recover mutation", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual([]);
    expect(fake.modelContexts[0]).toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({
          content:
            "The previous write step was interrupted. Reinspect the workspace before applying another mutation.",
        }),
      ]),
    });
    expect(fake.events.find((event) => event.type === "run.recovered")?.payload)
      .toMatchObject({
        nextStatus: "planning",
        previousStatus: "mutating",
      });
  });

  it("recovers an inactive verifying run and re-verifies before completing", async () => {
    const run = createExistingRun("run-verifying-recover", {
      phase: "verifying",
      status: "verifying",
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run, {
      changedFiles: ["app/page.tsx"],
    }));
    fake.actions = [{ type: "finish_candidate", summary: "Recovered from verifier" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Recover verifier", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.verifierInputs).toHaveLength(1);
    expect(fake.runs.get(run.id)?.status).toBe("completed");
    expect(fake.events.map((event) => event.type)).toContain("run.recovered");
  });

  it("recovers an inactive repairing run within the existing repair budget", async () => {
    const run = createExistingRun("run-repairing-recover", {
      phase: "repairing",
      repairCycles: 1,
      status: "repairing",
    });
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run, {
      observations: ["Repair the failed build."],
      repairFeedback: ["Repair the failed build."],
    }));
    fake.actions = [{ type: "finish_candidate", summary: "Recovered repair" }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Recover repair", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.modelContexts[0]).toMatchObject({
      observations: expect.arrayContaining([
        expect.objectContaining({ content: "Repair the failed build." }),
      ]),
    });
    expect(fake.runs.get(run.id)).toMatchObject({
      repairCycles: 1,
      status: "completed",
    });
  });

  it("pauses cleanly after a concurrent persisted stateVersion update", async () => {
    fake.actions = [
      () => {
        persistRunPatch(activeRunId(), {
          pauseRequested: true,
        });
        return { type: "answer", message: "Pause after this turn" };
      },
    ];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(false);
    expect(run).toMatchObject({
      pauseRequested: true,
      status: "paused",
    });
    expect(fake.failedMessages).toEqual([]);
  });

  it("cancels cleanly after a concurrent persisted stateVersion update", async () => {
    fake.actions = [
      () => {
        persistRunPatch(activeRunId(), {
          cancelRequested: true,
        });
        return { type: "answer", message: "Cancel after this turn" };
      },
    ];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(false);
    expect(run).toMatchObject({
      cancelRequested: true,
      status: "cancelled",
    });
    expect(fake.events.map((event) => event.type)).toContain("run.cancelled");
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

  it("uses the Rust preview probe exposed by projectApi", async () => {
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
      { type: "finish_candidate", summary: "Copy updated" },
    ];
    fake.verificationStatuses = ["passed", "passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy");

    expect(result).toBe(true);
    expect(fake.previewProbeUrls).toEqual([
      "http://localhost:3000",
      "http://localhost:3000",
    ]);
  });

  it("fails an active run when the model throws and allows a later write run", async () => {
    fake.actions = [new Error("Model exploded")];

    const failed = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy");
    const failedRun = [...fake.runs.values()][0];

    expect(failed).toBe(false);
    expect(failedRun.status).toBe("failed");

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
      { type: "finish_candidate", summary: "Recovered" },
    ];
    fake.verificationStatuses = ["passed", "passed"];

    const recovered = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy");

    expect(recovered).toBe(true);
  });

  it("fails an active run when a tool throws", async () => {
    fake.throwToolName = "read_files";
    fake.actions = [
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Read the page",
        args: { paths: ["app/page.tsx"] },
      },
    ];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(false);
    expect(run.status).toBe("failed");
  });

  it("fails an active run when the verifier throws", async () => {
    fake.throwVerifier = true;
    fake.actions = [{ type: "answer", message: "Verifier will fail." }];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(false);
    expect(run.status).toBe("failed");
  });

  it("does not turn a cancelled run into failed after interruption", async () => {
    fake.actions = [
      () => {
        persistRunPatch(activeRunId(), {
          cancelRequested: true,
        });
        return { type: "answer", message: "Late answer" };
      },
    ];

    const store = createFakeStore();
    const result = await modifyCurrentProjectRuntime(store, "status?");
    const run = [...fake.runs.values()][0];

    expect(result).toBe(false);
    expect(run.status).toBe("cancelled");
    expect(fake.events.map((event) => event.type)).not.toContain("run.failed");
    expect(fake.failedMessages).toEqual([]);
    expect(fake.completedMessages).toContain("Run cancelled.");
    expect((store as { get: () => { projectError: string | null } }).get().projectError)
      .toBeNull();
  });

  it("preserves answerMessage in the final chat message", async () => {
    fake.actions = [{ type: "answer", message: "Here is the real answer." }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "status?");

    expect(result).toBe(true);
    expect(fake.completedMessages[0]).toContain("Here is the real answer.");
    expect(fake.completedMessages[0]).not.toContain("Done: status?");
  });

  it("preserves finishSummary in the final chat message after resume", async () => {
    const run = createExistingRun("run-finish-resume");
    fake.runs.set(run.id, run);
    fake.checkpoints.push(createCheckpoint(run, {
      changedFiles: ["app/page.tsx"],
    }));
    fake.actions = [{ type: "finish_candidate", summary: "The copy is fixed." }];
    fake.verificationStatuses = ["passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy", {
      existingRun: run,
    });

    expect(result).toBe(true);
    expect(fake.completedMessages[0]).toContain("The copy is fixed.");
    expect(fake.completedMessages[0]).not.toContain("Done: Change hero copy");
  });

  it("restores read snapshots across resume so edit_file can proceed", async () => {
    fake.requireReadBeforeWrite = true;
    const pausedRun = createExistingRun("run-read-resume", {
      status: "paused",
    });
    fake.runs.set(pausedRun.id, pausedRun);
    fake.checkpoints.push(createCheckpoint(pausedRun, {
      readSnapshots: [
        {
          contentHash: hashText("{}"),
          path: "app/page.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    fake.actions = [
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Edit after resume",
        args: {
          new_string: "Hello",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Update copy",
        },
      },
      { type: "finish_candidate", summary: "Edited after resume" },
    ];
    fake.verificationStatuses = ["passed", "passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy", {
      existingRun: pausedRun,
    });

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual(["edit_file"]);
  });

  it("drops stale read snapshots and requires a fresh read before editing", async () => {
    fake.requireReadBeforeWrite = true;
    const pausedRun = createExistingRun("run-stale-read-resume", {
      status: "paused",
    });
    fake.runs.set(pausedRun.id, pausedRun);
    fake.checkpoints.push(createCheckpoint(pausedRun, {
      readSnapshots: [
        {
          contentHash: "stale",
          path: "app/page.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      workspaceFingerprint: "stale-workspace",
    }));
    fake.actions = [
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Edit after stale resume",
        args: {
          new_string: "Hello",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Update copy",
        },
      },
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Re-read",
        args: { paths: ["app/page.tsx"] },
      },
      {
        type: "tool_call",
        tool: "edit_file",
        rationale: "Edit after fresh read",
        args: {
          new_string: "Hello",
          old_string: "Hi",
          path: "app/page.tsx",
          summary: "Update copy",
        },
      },
      { type: "finish_candidate", summary: "Edited after fresh read" },
    ];
    fake.verificationStatuses = ["passed", "passed"];

    const result = await modifyCurrentProjectRuntime(createFakeStore(), "Change hero copy", {
      existingRun: pausedRun,
    });

    expect(result).toBe(true);
    expect(fake.toolNames).toEqual(["edit_file", "read_files", "edit_file"]);
    expect(fake.checkpoints.some((checkpoint) => checkpoint.readSnapshots.length === 0)).toBe(true);
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

  it("injects compact Spec context into agent task planning", async () => {
    const spec = createRuntimeSpec();
    const revision = spec.revisions[0];
    const task = revision.tasks[0];
    const store = createFakeStore();
    (store as unknown as { set: (patch: Record<string, unknown>) => void }).set({
      currentConversation: {
        activeSpecId: spec.id,
        id: spec.conversationId,
        messages: [],
        mode: "spec",
        specIds: [spec.id],
      },
      currentSpec: spec,
    });
    const project = (store as unknown as { get: () => { currentProject: ProjectInfo } })
      .get()
      .currentProject;
    fake.actions = [{ type: "finish_candidate", summary: "Spec task done" }];
    fake.verificationStatuses = ["passed"];

    await runSpecTaskRuntime({
      contract: compileSpecTaskContract({
        executionMode: "modify",
        revision,
        spec,
        task,
      }),
      conversationId: spec.conversationId,
      executionMode: "modify",
      project,
      runId: "run-spec-context",
      store: store as never,
      taskObjective: task.objective,
    });

    const context = fake.modelContexts[0] as AgentStepContext;

    expect(context.specContext?.currentTask.id).toBe(task.id);
    expect(context.specContext?.requirements[0]?.description).toContain("join a poker room");
    expect(context.specContext?.acceptanceCriteria[0]?.description).toContain("Realtime");
    expect(context.specContext?.design.dataModel).toContain("rooms, room_players, game_states");
    expect(context.specContext?.design.integrations).toContain("Supabase Realtime");
  });

  it("forwards read snapshots from runtime checkpoints into the production verifier", async () => {
    const spec = createRuntimeSpec();
    const revision = spec.revisions[0];
    const task = revision.tasks[0];
    const store = createFakeStore();
    const project = (store as unknown as { get: () => { currentProject: ProjectInfo } })
      .get()
      .currentProject;
    fake.actions = [
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Inspect expected file",
        args: { paths: ["app/api/rooms/route.ts"] },
      },
      {
        type: "tool_call",
        tool: "read_files",
        rationale: "Should not be needed after auto verification",
        args: { paths: ["app/api/rooms/route.ts"] },
      },
    ];
    fake.verificationStatuses = ["passed"];

    const result = await runSpecTaskRuntime({
      contract: compileSpecTaskContract({
        executionMode: "modify",
        revision,
        spec,
        task,
      }),
      conversationId: spec.conversationId,
      executionMode: "modify",
      project,
      runId: "run-read-snapshot-verifier-forwarding",
      store: store as never,
      taskObjective: task.objective,
    });

    const verifierInput = fake.verifierInputs[0] as {
      readSnapshots?: Array<{ path: string }>;
    };

    expect(result.run?.status).toBe("completed");
    expect(fake.toolNames).toEqual(["read_files"]);
    expect(verifierInput.readSnapshots?.map((snapshot) => snapshot.path))
      .toEqual(["app/api/rooms/route.ts"]);
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

  it("classifies LLM context budget errors as budget_exceeded", async () => {
    fake.actions = [
      new LlmClientError(
        "context_budget",
        "Fake AI request exceeded the model context length.",
      ),
    ];

    const result = await modifyCurrentProjectRuntime(
      createFakeStore(),
      "Fix the project",
    );
    const persisted = [...fake.runs.values()][0];
    const terminalEvent = fake.events.find((event) => event.type === "run.budget_exceeded");

    expect(result).toBe(false);
    expect(persisted?.status).toBe("budget_exceeded");
    expect(terminalEvent?.payload).toMatchObject({
      failureKind: "context_budget",
      reason: expect.stringContaining("context length"),
    });
    expect(fake.failedMessages[0]).toContain("context length");
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

function activeRunId() {
  const run = [...fake.runs.values()].find((item) =>
    !["completed", "failed", "cancelled", "budget_exceeded"].includes(item.status),
  );

  if (!run) {
    throw new Error("No active run was found.");
  }

  return run.id;
}

function persistRunPatch(runId: string, patch: Partial<AgentRun>) {
  const run = fake.runs.get(runId);

  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  fake.runs.set(runId, {
    ...run,
    ...patch,
    stateVersion: run.stateVersion + 1,
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
}

function createRuntimeSpec(): DevelopmentSpec {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: "revision-1",
    id: "spec-1",
    kind: "initial_build",
    projectId: "project-1",
    revisions: [
      {
        brief: "Build an online poker game.",
        createdAt: "2026-01-01T00:00:00.000Z",
        design: {
          components: [],
          dataModel: ["rooms, room_players, game_states"],
          integrations: ["Supabase Realtime"],
          pages: [],
          summary: "Use Supabase for realtime multiplayer state.",
          technicalDecisions: ["Server writes go through App Router API routes."],
          verificationStrategy: ["Run build after backend wiring."],
        },
        id: "revision-1",
        requirements: {
          acceptanceCriteria: [
            {
              description: "Realtime room state is persisted and broadcast.",
              id: "criterion-1",
              required: true,
            },
          ],
          constraints: [],
          goal: "Players can play online poker together.",
          outOfScope: [],
          unresolvedQuestions: [],
          userStories: [
            {
              description: "As a player, I can join a poker room.",
              id: "story-1",
            },
          ],
        },
        tasks: [
          {
            acceptanceCriteriaIds: ["criterion-1"],
            allowedPaths: ["app/**", "lib/**"],
            dependencyIds: [],
            expectedFiles: ["app/api/rooms/route.ts"],
            id: "task-1",
            objective: "Create the realtime poker room backend.",
            requirementIds: ["story-1"],
            status: "pending",
            title: "Realtime room backend",
          },
        ],
        version: 1,
      },
    ],
    status: "building",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
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

type FakeStore = {
  get: () => Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
};

function createFakeStore() {
  let state: Record<string, unknown> = {
    agentEvents: [],
    agentRuns: [],
    changeHistory: [],
    currentAgentApproval: null,
    currentAgentRun: null,
    currentConversation: { id: "conversation-1", messages: [] },
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
    devServerStatus: "running",
    fileTree: { path: "", children: [{ path: "app/page.tsx" }] },
    previewDiagnostics: [],
    previewRefreshKey: 0,
    previewUrl: "http://localhost:3000",
    previewVerificationSession: null,
    previewVerificationSessions: [],
    projectError: null,
    runProjectCommand: async (_projectId: string, command: string) => {
      fake.commandCalls.push(command);

      if (fake.commandThrows) {
        throw new Error(`Unexpected command: ${command}`);
      }

      return {
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      };
    },
    selectedSiteNodeId: null,
    startDevServer: async () => {
      fake.devServerStarts += 1;
      state = {
        ...state,
        devServerStatus: "running",
        previewUrl: "http://localhost:3000",
      };
    },
    stopDevServer: async () => {
      fake.devServerStops += 1;
      state = {
        ...state,
        devServerStatus: "stopped",
        previewUrl: null,
      };
    },
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
