import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, VerificationReport } from "../agent-core/types";
import type { ProjectConversation, ProjectConversationSummary, ProjectInfo } from "../services/projects";
import type { DevelopmentSpec, GeneratedSpecRevisionPayload, SpecRevision } from "../spec-core/types";
import { computePersistedAcceptanceResults } from "../spec-core/validators";
import {
  __specStoreActionsTestUtils,
  createSpecActions,
} from "./specStoreActions";

const fake = vi.hoisted(() => ({
  agentRuns: new Map<string, unknown>(),
  checkpoints: new Map<string, unknown>(),
  createProjectConversation: vi.fn(),
  createSpec: vi.fn(),
  deleteUnattachedSpec: vi.fn(),
  listProjectConversations: vi.fn(),
  readSpec: vi.fn(),
  requestFeatureSpec: vi.fn(),
  requestInitialSpec: vi.fn(),
  requestSpecRevision: vi.fn(),
  runSpecTaskRuntime: vi.fn(),
  saveSpec: vi.fn(),
  saveProjectConversation: vi.fn(),
  switchProjectConversationMode: vi.fn(),
  verificationReports: new Map<string, unknown>(),
}));

vi.mock("../agent/projectModifier", () => ({
  formatProjectFileTree: vi.fn(() => "app/page.tsx"),
  getContextFilePaths: vi.fn(() => []),
}));

vi.mock("../agent-runtime/runController", () => ({
  runSpecTaskRuntime: (...args: unknown[]) => fake.runSpecTaskRuntime(...args),
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
    getLatestCheckpoint: vi.fn(async (_projectId: string, runId: string) =>
      fake.checkpoints.get(runId) ?? null,
    ),
    getLatestVerificationReport: vi.fn(async (_projectId: string, runId: string) =>
      fake.verificationReports.get(runId) ?? null,
    ),
    getRun: vi.fn(async (_projectId: string, runId: string) =>
      fake.agentRuns.get(runId) ?? null,
    ),
    readSiteSourceMap: vi.fn(async () => null),
    readSiteSpec: vi.fn(async () => null),
  },
}));

vi.mock("../services/keyStore", () => ({
  keyStore: {
    getAiProviderConfig: vi.fn(async () => ({
      apiKey: "test-key",
      baseUrl: "https://example.test",
      model: "test-model",
      provider: "openai",
    })),
  },
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    createProjectConversation: (...args: unknown[]) =>
      fake.createProjectConversation(...args),
    listProjectConversations: (...args: unknown[]) =>
      fake.listProjectConversations(...args),
    listFiles: vi.fn(async () => ({
      children: [],
      kind: "directory",
      name: "app",
      path: "",
    })),
    readFile: vi.fn(async () => ""),
    saveProjectConversation: (...args: unknown[]) =>
      fake.saveProjectConversation(...args),
    switchProjectConversationMode: (...args: unknown[]) =>
      fake.switchProjectConversationMode(...args),
  },
}));

vi.mock("../services/specs", () => ({
  specApi: {
    createSpec: (...args: unknown[]) => fake.createSpec(...args),
    deleteUnattachedSpec: (...args: unknown[]) =>
      fake.deleteUnattachedSpec(...args),
    readSpec: (...args: unknown[]) => fake.readSpec(...args),
    saveSpec: (...args: unknown[]) => fake.saveSpec(...args),
  },
}));

vi.mock("../spec-runtime/requests", () => ({
  requestFeatureSpec: (...args: unknown[]) => fake.requestFeatureSpec(...args),
  requestInitialSpec: (...args: unknown[]) => fake.requestInitialSpec(...args),
  requestSpecRevision: (...args: unknown[]) => fake.requestSpecRevision(...args),
}));

describe("spec store actions", () => {
  beforeEach(() => {
    fake.agentRuns = new Map();
    fake.checkpoints = new Map();
    fake.createProjectConversation.mockReset();
    fake.createSpec.mockReset();
    fake.deleteUnattachedSpec.mockReset();
    fake.listProjectConversations.mockReset();
    fake.readSpec.mockReset();
    fake.requestFeatureSpec.mockReset();
    fake.requestInitialSpec.mockReset();
    fake.requestSpecRevision.mockReset();
    fake.runSpecTaskRuntime.mockReset();
    fake.saveSpec.mockReset();
    fake.saveProjectConversation.mockReset();
    fake.switchProjectConversationMode.mockReset();
    fake.verificationReports = new Map();
    fake.createSpec.mockImplementation(async (_projectId: string, spec: DevelopmentSpec) => spec);
    fake.deleteUnattachedSpec.mockResolvedValue(undefined);
    fake.listProjectConversations.mockResolvedValue([
      createConversationSummary({
        activeSpecId: "spec-initial",
        id: "conversation-1",
        kind: "initial_build",
        mode: "spec",
        title: "Initial build",
      }),
    ]);
    fake.readSpec.mockImplementation(async (_projectId: string, specId: string) =>
      createSpec({ id: specId, status: "completed" }),
    );
    fake.requestFeatureSpec.mockResolvedValue(createGeneratedPayload());
    fake.requestInitialSpec.mockResolvedValue(createGeneratedPayload());
    fake.requestSpecRevision.mockResolvedValue(createGeneratedPayload());
    fake.runSpecTaskRuntime.mockResolvedValue({
      run: null,
      verificationReport: null,
    });
    fake.saveSpec.mockImplementation(async (_projectId: string, spec: DevelopmentSpec) => spec);
    fake.saveProjectConversation.mockImplementation(
      async (_projectId: string, conversation: ProjectConversation) => conversation,
    );
    fake.switchProjectConversationMode.mockImplementation(
      async (projectId: string, input: Record<string, unknown>) =>
        createConversation(projectId, input),
    );
  });

  it("creates a Feature Spec iteration directly without a Chat conversation hop", async () => {
    fake.createProjectConversation.mockImplementation(
      async (projectId: string, input: Record<string, unknown>) =>
        createConversation(projectId, input),
    );
    const store = createStore();
    const actions = createSpecActions(store as never);

    const conversation = await actions.createFeatureSpecIteration(
      "project-1",
      "Checkout copy",
      "Improve checkout copy",
    );

    expect(conversation?.mode).toBe("spec");
    expect(fake.createSpec).toHaveBeenCalledTimes(1);
    expect(fake.createProjectConversation).toHaveBeenCalledTimes(1);
    expect(fake.createProjectConversation).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        kind: "iteration",
        mode: "spec",
        title: "Checkout copy",
      }),
    );
    expect(fake.createProjectConversation.mock.calls[0][1]).toMatchObject({
      activeSpecId: expect.any(String),
      specIds: [expect.any(String)],
    });
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentConversation?.activeSpecId).toBe(
      store.get().currentSpec?.id,
    );
    expect(store.get().historicalSpecs.map((spec) => spec.id)).toEqual([
      store.get().currentSpec?.id,
    ]);
    expect(store.get().chatMessages).toHaveLength(1);
  });

  it("does not leave a conversation when Feature Spec generation fails", async () => {
    fake.requestFeatureSpec.mockRejectedValue(new Error("model unavailable"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createFeatureSpecIteration(
        "project-1",
        "Checkout copy",
        "Improve checkout copy",
      ),
    ).resolves.toBeNull();

    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().projectError).toBe("model unavailable");
  });

  it("does not request a Feature Spec iteration before Initial Build completes", async () => {
    fake.listProjectConversations.mockResolvedValue([
      createConversationSummary({
        activeSpecId: "spec-initial",
        id: "conversation-1",
        kind: "initial_build",
        mode: "spec",
        title: "Initial build",
      }),
    ]);
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-1",
        id: "spec-initial",
        status: "review",
      }),
    );
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createFeatureSpecIteration(
        "project-1",
        "Checkout copy",
        "Improve checkout copy",
      ),
    ).resolves.toBeNull();

    expect(fake.requestFeatureSpec).not.toHaveBeenCalled();
    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before creating iterations",
    );
  });

  it("does not let an existing iteration summary bypass the Feature Spec gate", async () => {
    const initialBuild = createConversationSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    fake.listProjectConversations.mockResolvedValue([initialBuild]);
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "review",
      }),
    );
    const store = createStore({
      conversationSummaries: [
        initialBuild,
        createConversationSummary({
          id: "conversation-existing",
          kind: "iteration",
          mode: "chat",
          title: "Existing iteration",
        }),
      ],
    });
    const actions = createSpecActions(store as never);

    await expect(
      actions.createFeatureSpecIteration(
        "project-1",
        "Checkout copy",
        "Improve checkout copy",
      ),
    ).resolves.toBeNull();

    expect(fake.listProjectConversations).toHaveBeenCalledWith(
      "project-1",
      true,
    );
    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(fake.requestFeatureSpec).not.toHaveBeenCalled();
    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before creating iterations",
    );
  });

  it("does not create a Feature Spec iteration while a Spec operation is busy", async () => {
    const store = createStore({
      isRevisingSpec: true,
    });
    const actions = createSpecActions(store as never);

    const conversation = await actions.createFeatureSpecIteration(
      "project-1",
      "Checkout copy",
      "Improve checkout copy",
    );

    expect(conversation).toBeNull();
    expect(fake.requestFeatureSpec).not.toHaveBeenCalled();
    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "Wait for the current Spec operation to finish before creating a new iteration.",
    );
  });

  it("deletes the unattached spec when conversation creation fails", async () => {
    fake.createProjectConversation.mockRejectedValue(new Error("host gate rejected"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createFeatureSpecIteration(
        "project-1",
        "Checkout copy",
        "Improve checkout copy",
      ),
    ).resolves.toBeNull();

    const createdSpec = fake.createSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(fake.deleteUnattachedSpec).toHaveBeenCalledWith(
      "project-1",
      createdSpec.id,
    );
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().projectError).toBe("host gate rejected");
  });

  it("returns null without creating a spec when Initial Spec generation fails", async () => {
    fake.requestInitialSpec.mockRejectedValue(new Error("initial model unavailable"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createInitialSpec("project-1", "Build a storefront"),
    ).resolves.toBeNull();

    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().projectError).toBe("initial model unavailable");
  });

  it("returns null without creating an Initial Build conversation when Initial Spec persistence fails", async () => {
    fake.createSpec.mockRejectedValue(new Error("spec persistence failed"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createInitialSpec("project-1", "Build a storefront"),
    ).resolves.toBeNull();

    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(fake.deleteUnattachedSpec).not.toHaveBeenCalled();
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().projectError).toBe("spec persistence failed");
  });

  it("deletes the unattached Initial Spec when Initial Build conversation creation fails", async () => {
    fake.createProjectConversation.mockRejectedValue(new Error("host gate rejected"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createInitialSpec("project-1", "Build a storefront"),
    ).resolves.toBeNull();

    const createdSpec = fake.createSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(createdSpec.kind).toBe("initial_build");
    expect(fake.deleteUnattachedSpec).toHaveBeenCalledWith(
      "project-1",
      createdSpec.id,
    );
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().projectError).toBe("host gate rejected");
  });

  it("preserves the Initial Build conversation error when unattached Spec cleanup fails", async () => {
    fake.createProjectConversation.mockRejectedValue(new Error("host gate rejected"));
    fake.deleteUnattachedSpec.mockRejectedValue(new Error("cleanup failed"));
    const store = createStore();
    const actions = createSpecActions(store as never);

    await expect(
      actions.createInitialSpec("project-1", "Build a storefront"),
    ).resolves.toBeNull();

    expect(store.get().projectError).toBe("host gate rejected");
    expect(store.get().terminalLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Failed to clean up unattached Spec"),
        expect.stringContaining("host gate rejected"),
      ]),
    );
  });

  it("creates the Initial Build conversation and Spec together", async () => {
    fake.createProjectConversation.mockImplementation(
      async (projectId: string, input: Record<string, unknown>) =>
        createConversation(projectId, input),
    );
    const store = createStore();
    const actions = createSpecActions(store as never);

    const conversation = await actions.createInitialSpec(
      "project-1",
      "Build a storefront",
      "Initial build",
    );

    const createdSpec = fake.createSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(createdSpec.kind).toBe("initial_build");
    expect(conversation?.kind).toBe("initial_build");
    expect(conversation?.mode).toBe("spec");
    expect(fake.createProjectConversation).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: createdSpec.id,
        kind: "initial_build",
        mode: "spec",
        specIds: [createdSpec.id],
        title: "Initial build",
      }),
    );
    expect(store.get().currentConversation?.activeSpecId).toBe(createdSpec.id);
    expect(store.get().currentSpec?.id).toBe(createdSpec.id);
    expect(store.get().historicalSpecs.map((spec) => spec.id)).toEqual([
      createdSpec.id,
    ]);
    expect(store.get().chatMessages).toHaveLength(1);
  });

  it("loads historical specs in Chat mode without activating them", async () => {
    const historicalSpec = createSpec({
      id: "spec-history",
      status: "completed",
    });
    fake.readSpec.mockResolvedValue(historicalSpec);
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: null,
        conversationId: "conversation-1",
        mode: "chat",
        specIds: ["spec-history"],
        title: "Chat iteration",
      }),
    });
    const actions = createSpecActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadCurrentSpec();

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-history");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([historicalSpec]);
  });

  it("keeps readable Chat history specs when one historical Spec cannot load", async () => {
    const readableSpec = createSpec({
      id: "spec-readable",
      status: "completed",
    });
    fake.readSpec.mockImplementation(async (_projectId: string, specId: string) => {
      if (specId === "spec-missing") {
        throw new Error("spec file missing");
      }

      return readableSpec;
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: null,
        conversationId: "conversation-1",
        mode: "chat",
        specIds: ["spec-readable", "spec-missing"],
        title: "Chat iteration",
      }),
      historicalSpecs: [
        createSpec({
          id: "spec-stale",
          status: "completed",
        }),
      ],
    });
    const actions = createSpecActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadCurrentSpec();

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-readable");
    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-missing");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([readableSpec]);
    expect(store.get().projectError).toBe(
      "Failed to load Spec history: spec-missing: spec file missing",
    );
  });

  it("clears stale active Spec state when the active Spec cannot load", async () => {
    const staleSpec = createSpec({
      id: "spec-stale",
      status: "completed",
    });
    fake.readSpec.mockRejectedValue(new Error("active spec file missing"));
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: "spec-missing",
        conversationId: "conversation-1",
        mode: "spec",
        specIds: ["spec-missing"],
        title: "Spec iteration",
      }),
      currentSpec: staleSpec,
      historicalSpecs: [staleSpec],
    });
    const actions = createSpecActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadCurrentSpec();

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-missing");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
    expect(store.get().projectError).toBe("active spec file missing");
  });

  it("does not activate a stale Spec when activeSpecId changes while loading", async () => {
    const staleSpec = createSpec({
      id: "spec-stale",
      status: "completed",
    });
    let store: ReturnType<typeof createStore>;
    fake.readSpec.mockImplementation(async () => {
      store.set({
        currentConversation: createConversation("project-1", {
          activeSpecId: null,
          conversationId: "conversation-1",
          mode: "chat",
          specIds: ["spec-stale"],
          title: "Chat iteration",
        }),
        currentSpec: null,
        historicalSpecs: [],
        isLoadingSpec: true,
      });
      return staleSpec;
    });
    store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: "spec-stale",
        conversationId: "conversation-1",
        mode: "spec",
        specIds: ["spec-stale"],
        title: "Spec iteration",
      }),
      currentSpec: null,
      historicalSpecs: [],
    });
    const actions = createSpecActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadCurrentSpec();

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-stale");
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().currentConversation?.activeSpecId).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
    expect(store.get().isLoadingSpec).toBe(true);
  });

  it("persists a task runId before launching Spec runtime", async () => {
    const revision = createExecutableRevision({
      tasks: [createExecutableTask("task-1")],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const conversation = createConversation("project-1", {
      activeSpecId: spec.id,
      conversationId: spec.conversationId,
      mode: "spec",
      specIds: [spec.id],
      title: "Spec iteration",
    });
    const store = createStore({
      currentConversation: conversation,
      currentSpec: spec,
    });
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      const runningTask = store.get().currentSpec?.revisions[0].tasks[0];

      expect(runningTask).toMatchObject({
        runId: input.runId,
        status: "running",
      });
      expect(input.runId).toMatch(/^run-/);

      return {
        run: createRun(input.runId, { status: "paused" }),
        verificationReport: null,
      };
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().currentSpec?.revisions[0].tasks[0].status).toBe("running");
  });

  it("continues execution from an approved Spec after reload", async () => {
    const revision = createExecutableRevision({
      approvedAt: "2026-01-01T00:00:01.000Z",
      tasks: [createExecutableTask("task-1")],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "approved",
    });
    const store = createStore({
      currentSpec: spec,
    });
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, { status: "paused" }),
      verificationReport: null,
    }));
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: expect.stringMatching(/^run-/),
      status: "running",
    });
  });

  it("marks a missing AgentRun as retryable blocked instead of leaving it running", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-missing",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const task = store.get().currentSpec?.revisions[0].tasks[0];
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(task).toMatchObject({
      error: "AgentRun run-missing was not found.",
      status: "failed",
    });
  });

  it("keeps waiting approval runs as running during Spec reconcile", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-waiting",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-waiting", createRun("run-waiting", {
      phase: "waiting_approval",
      status: "waiting_approval",
    }));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: "run-waiting",
      status: "running",
    });
  });

  it("blocks completion when a required acceptance criterion is pending", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "verifying",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain("criterion-1");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "acceptance criteria",
      success: false,
    });
    expect(store.get().runProjectCommand).not.toHaveBeenCalled();
  });

  it("blocks completion when a required acceptance criterion failed", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "verifying",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set("run-1", createVerificationReport("run-1", "failed"));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain("criterion-1");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "acceptance criteria",
      success: false,
    });
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      error: expect.stringContaining("Verification report"),
      status: "failed",
    });
    expect(
      store.get().currentSpec
        ? computePersistedAcceptanceResults(store.get().currentSpec!)[0]
        : null,
    ).toMatchObject({
      criterionId: "criterion-1",
      status: "failed",
      summary: expect.stringContaining("task-1"),
    });
    expect(store.get().runProjectCommand).not.toHaveBeenCalled();
  });

  it("blocks completion when any task verification report failed even if required criteria passed", async () => {
    const payload = createGeneratedPayload();
    const revision = createExecutableRevision({
      requirements: {
        ...payload.requirements,
        acceptanceCriteria: [
          ...payload.requirements.acceptanceCriteria,
          {
            description: "Optional polish is verified.",
            id: "criterion-optional",
            required: false,
          },
        ],
      },
      tasks: [
        createExecutableTask("task-1", {
          acceptanceCriteriaIds: ["criterion-1"],
          runId: "run-1",
          status: "passed",
        }),
        createExecutableTask("task-2", {
          acceptanceCriteriaIds: ["criterion-optional"],
          runId: "run-2",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "verifying",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.agentRuns.set("run-2", createRun("run-2", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set("run-1", createVerificationReport("run-1", "passed"));
    fake.verificationReports.set("run-2", createVerificationReport("run-2", "failed"));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain("task-2");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "task verification reports",
      success: false,
    });
    expect(store.get().currentSpec?.revisions[0].tasks).toMatchObject([
      {
        id: "task-1",
        status: "passed",
      },
      {
        error: expect.stringContaining("Verification report"),
        id: "task-2",
        status: "failed",
      },
    ]);
    expect(store.get().runProjectCommand).not.toHaveBeenCalled();
  });

  it("clears stale final verification state when retrying a failed Spec task", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          error: "Verification report for AgentRun run-1 did not pass.",
          runId: "run-1",
          status: "failed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      failureMessage: "Task verification reports are not all passing: task-1.",
      finalVerification: {
        checkedAt: "2026-01-01T00:03:00.000Z",
        command: "task verification reports",
        output: "Task verification reports are not all passing: task-1.",
        success: false,
      },
      revisions: [revision],
      status: "blocked",
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecTask("task-1");

    const resetSpec = fake.saveSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(resetSpec.status).toBe("building");
    expect(resetSpec.failureMessage).toBeUndefined();
    expect(resetSpec.finalVerification).toBeUndefined();
    expect(resetSpec.revisions[0].tasks[0]).toMatchObject({
      runId: undefined,
      status: "pending",
    });
  });

  it("does not retry verification without a failed final verification marker", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      failureMessage: "Unrelated blocked state.",
      revisions: [revision],
      status: "blocked",
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecVerification();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(store.get().runProjectCommand).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(spec);
  });

  it("retries verification after a failed final verification", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      failureMessage: "Final npm run build failed:\nbuild failed",
      finalVerification: {
        checkedAt: "2026-01-01T00:03:00.000Z",
        command: "npm run build",
        output: "build failed",
        success: false,
      },
      revisions: [revision],
      status: "blocked",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set("run-1", createVerificationReport("run-1", "passed"));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecVerification();

    expect(store.get().currentSpec?.status).toBe("completed");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm run build",
      success: true,
    });
    expect(store.get().runProjectCommand).toHaveBeenCalledWith(
      "project-1",
      "npm run build",
    );
  });

  it("completes when every required criterion and final build pass", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "verifying",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set("run-1", createVerificationReport("run-1", "passed"));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("completed");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm run build",
      success: true,
    });
    expect(store.get().runProjectCommand).toHaveBeenCalledWith(
      "project-1",
      "npm run build",
    );
  });

  it("runs npm install before final build when a Feature Spec changes package.json", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      kind: "feature",
      revisions: [revision],
      status: "verifying",
    });
    fake.agentRuns.set("run-1", createRun("run-1", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set("run-1", createVerificationReport("run-1", "passed"));
    fake.checkpoints.set("run-1", {
      packageChanged: true,
    });
    const runProjectCommand = vi.fn(async (_projectId: string, command: string) => ({
      output: `${command} ok`,
      success: true,
    }));
    const store = createStore({
      currentSpec: spec,
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(runProjectCommand.mock.calls.map((call) => call[1])).toEqual([
      "npm install",
      "npm run build",
    ]);
    expect(store.get().currentSpec?.finalVerification?.command).toBe(
      "npm install && npm run build",
    );
  });

  it("rejects direct Chat switching while Spec execution is locked", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-active",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const store = createStore({
      currentAgentRun: createRun("run-active", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
      }),
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat();

    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().projectError).toBe(
      "Cancel the active Spec execution before switching to Chat.",
    );
  });

  it("does not switch to Chat with a stale Spec from another conversation", async () => {
    const staleSpec = createSpec({
      conversationId: "conversation-stale",
      id: "spec-stale",
      projectId: "project-1",
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: "spec-current",
        conversationId: "conversation-1",
        mode: "spec",
        specIds: ["spec-current"],
        title: "Spec iteration",
      }),
      currentSpec: staleSpec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentSpec).toBe(staleSpec);
    expect(store.get().projectError).toBe(
      "Active Spec does not belong to the current conversation.",
    );
  });

  it("cancels the running Spec before switching to Chat", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-active",
          status: "running",
        }),
        createExecutableTask("task-2", {
          dependencyIds: ["task-1"],
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const conversation = createConversation("project-1", {
      activeSpecId: spec.id,
      conversationId: spec.conversationId,
      mode: "spec",
      specIds: [spec.id],
      title: "Spec iteration",
    });
    const store = createStore({
      cancelCurrentAgentRunAndWait: vi.fn(async () =>
        createRun("run-active", {
          contract: createSpecRunContract(spec, revision.tasks[0]),
          status: "cancelled",
        }),
      ),
      currentAgentRun: createRun("run-active", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
      }),
      currentConversation: conversation,
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    const cancelledSpec = fake.saveSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(cancelledSpec.status).toBe("cancelled");
    expect(cancelledSpec.revisions[0].tasks.map((task) => task.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(fake.switchProjectConversationMode).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: null,
        conversationId: conversation.id,
        targetMode: "chat",
      }),
    );
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().currentConversation?.activeSpecId).toBeNull();
    expect(store.get().currentSpec).toBeNull();
  });

  it("loads a persisted running AgentRun before cancelling and switching to Chat", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-active",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const conversation = createConversation("project-1", {
      activeSpecId: spec.id,
      conversationId: spec.conversationId,
      mode: "spec",
      specIds: [spec.id],
      title: "Spec iteration",
    });
    const persistedRun = createRun("run-active", {
      contract: createSpecRunContract(spec, revision.tasks[0]),
      status: "planning",
    });
    const cancelCurrentAgentRunAndWait = vi.fn(async () =>
      createRun("run-active", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
        status: "cancelled",
      }),
    );

    fake.agentRuns.set("run-active", persistedRun);
    const store = createStore({
      cancelCurrentAgentRunAndWait,
      currentAgentRun: null,
      currentConversation: conversation,
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(cancelCurrentAgentRunAndWait).toHaveBeenCalledTimes(1);
    expect(fake.saveSpec).toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: null,
        conversationId: conversation.id,
        targetMode: "chat",
      }),
    );
    expect(store.get().currentConversation?.mode).toBe("chat");
  });

  it("keeps Spec mode when a running task is missing its runId during cancel switch", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const cancelCurrentAgentRunAndWait = vi.fn(async () => null);
    const store = createStore({
      cancelCurrentAgentRunAndWait,
      currentAgentRun: null,
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(cancelCurrentAgentRunAndWait).not.toHaveBeenCalled();
    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().projectError).toBe("Running task is missing its AgentRun id.");
  });

  it("does not cancel a stale AgentRun whose id is not the running task runId", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-current",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const cancelCurrentAgentRunAndWait = vi.fn(async () =>
      createRun("run-stale", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
        status: "cancelled",
      }),
    );
    const store = createStore({
      cancelCurrentAgentRunAndWait,
      currentAgentRun: createRun("run-stale", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
      }),
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(cancelCurrentAgentRunAndWait).not.toHaveBeenCalled();
    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().projectError).toBe(
      "Active AgentRun does not belong to the current Spec task.",
    );
  });

  it("keeps Spec mode when cancellation does not reach cancelled", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-active",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    const store = createStore({
      cancelCurrentAgentRunAndWait: vi.fn(async () =>
        createRun("run-active", {
          contract: createSpecRunContract(spec, revision.tasks[0]),
          status: "failed",
        }),
      ),
      currentAgentRun: createRun("run-active", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
      }),
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().projectError).toBe(
      "AgentRun cancellation did not reach cancelled state.",
    );
  });

  it("does not switch to Chat while a Spec revision is in progress", async () => {
    const spec = createSpec({
      status: "revising",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentSpec?.status).toBe("revising");
    expect(store.get().projectError).toBe(
      "Wait for the Spec revision to finish before switching modes.",
    );
  });

  it("does not switch to Chat while the revision action is busy", async () => {
    const spec = createSpec({
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
      isRevisingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentSpec?.status).toBe("review");
    expect(store.get().projectError).toBe(
      "Wait for the Spec revision to finish before switching modes.",
    );
  });

  it("does not approve while the revision action is busy", async () => {
    const revision = createExecutableRevision();
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
      isRevisingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("review");
  });

  it("does not request another revision while the revision action is busy", async () => {
    const revision = createExecutableRevision();
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
      isRevisingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.reviseCurrentSpec("Tighten the requirements");

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.requestSpecRevision).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("review");
  });

  it("restores review state when a revision request fails", async () => {
    fake.requestSpecRevision.mockRejectedValue(new Error("revision failed"));
    const revision = createExecutableRevision();
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        modeChangedAt: "2026-01-01T00:00:00.000Z",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.reviseCurrentSpec("Tighten the requirements");

    expect(store.get().currentSpec?.status).toBe("review");
    expect(store.get().currentSpec?.currentRevisionId).toBe(revision.id);
    expect(store.get().projectError).toBe("revision failed");
  });

  it("does not revive a cancelled Spec when a stale revision request fails", async () => {
    const revision = createExecutableRevision();
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const cancelledSpec = createSpec({
      cancelledAt: "2026-01-01T00:01:00.000Z",
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "cancelled",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        modeChangedAt: "2026-01-01T00:00:00.000Z",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    fake.requestSpecRevision.mockImplementation(async () => {
      store.set({ currentSpec: cancelledSpec });
      throw new Error("revision failed");
    });
    const actions = createSpecActions(store as never);

    await actions.reviseCurrentSpec("Tighten the requirements");

    expect(fake.saveSpec).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("cancelled");
    expect(store.get().currentSpec?.cancelledAt).toBe(cancelledSpec.cancelledAt);
    expect(store.get().projectError).toBe("revision failed");
  });

  it("discards stale revision responses after the active Spec changes", async () => {
    const revision = createExecutableRevision();
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "review",
    });
    const replacementSpec = createSpec({
      conversationId: "conversation-2",
      id: "spec-2",
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        modeChangedAt: "2026-01-01T00:00:00.000Z",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
    });
    fake.requestSpecRevision.mockImplementation(async () => {
      store.set({
        currentConversation: createConversation("project-1", {
          activeSpecId: replacementSpec.id,
          conversationId: replacementSpec.conversationId,
          mode: "spec",
          modeChangedAt: "2026-01-01T00:01:00.000Z",
          specIds: [replacementSpec.id],
          title: "Other Spec",
        }),
        currentSpec: replacementSpec,
      });
      return createGeneratedPayload();
    });
    const actions = createSpecActions(store as never);

    await actions.reviseCurrentSpec("Tighten the requirements");

    expect(fake.saveSpec).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec).toBe(replacementSpec);
    expect(store.get().currentSpec?.revisions).toHaveLength(1);
  });

  it("recursively blocks all pending downstream tasks", () => {
    const spec = createSpec({
      tasks: [
        createTask("task-1", { status: "failed" }),
        createTask("task-2", { dependencyIds: ["task-1"] }),
        createTask("task-3", { dependencyIds: ["task-2"] }),
        createTask("task-4", {
          dependencyIds: ["task-1"],
          runId: "run-4",
          status: "passed",
        }),
      ],
    });

    const nextSpec =
      __specStoreActionsTestUtils.markBlockedDownstreamTasks(spec, "task-1");
    const tasks = nextSpec.revisions[0].tasks;

    expect(tasks.find((task) => task.id === "task-2")).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
    expect(tasks.find((task) => task.id === "task-3")).toMatchObject({
      blockedByTaskId: "task-2",
      status: "blocked",
    });
    expect(tasks.find((task) => task.id === "task-4")).toMatchObject({
      runId: "run-4",
      status: "passed",
    });
  });

  it("restores only the retryable downstream graph", () => {
    const revision = createRevision({
      tasks: [
        createTask("task-1", {
          error: "failed",
          runId: "run-1",
          status: "failed",
        }),
        createTask("task-2", {
          blockedByTaskId: "task-1",
          dependencyIds: ["task-1"],
          error: "blocked",
          status: "blocked",
        }),
        createTask("task-3", {
          blockedByTaskId: "task-2",
          dependencyIds: ["task-2"],
          error: "blocked",
          status: "blocked",
        }),
        createTask("task-4", {
          dependencyIds: ["task-1"],
          runId: "run-4",
          status: "passed",
        }),
        createTask("task-5", {
          error: "unrelated",
          runId: "run-5",
          status: "failed",
        }),
        createTask("task-6", {
          blockedByTaskId: "task-5",
          dependencyIds: ["task-5"],
          error: "unrelated block",
          status: "blocked",
        }),
      ],
    });

    const nextRevision =
      __specStoreActionsTestUtils.restoreRetryableTaskGraph(revision, "task-1");
    const taskById = new Map(nextRevision.tasks.map((task) => [task.id, task]));

    expect(taskById.get("task-1")).toMatchObject({ status: "pending" });
    expect(taskById.get("task-1")?.runId).toBeUndefined();
    expect(taskById.get("task-2")).toMatchObject({ status: "pending" });
    expect(taskById.get("task-2")?.blockedByTaskId).toBeUndefined();
    expect(taskById.get("task-3")).toMatchObject({ status: "pending" });
    expect(taskById.get("task-3")?.blockedByTaskId).toBeUndefined();
    expect(taskById.get("task-4")).toMatchObject({
      runId: "run-4",
      status: "passed",
    });
    expect(taskById.get("task-5")).toMatchObject({
      runId: "run-5",
      status: "failed",
    });
    expect(taskById.get("task-6")).toMatchObject({
      blockedByTaskId: "task-5",
      status: "blocked",
    });
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    agentRuns: [],
    cancelCurrentAgentRunAndWait: vi.fn(async () => null),
    changeHistory: [],
    chatMessages: [],
    conversationSummaries: [],
    currentAgentRun: null,
    currentConversation: null,
    currentProject: createProject(),
    currentSpec: null,
    fileTree: {
      children: [],
      kind: "directory",
      name: "app",
      path: "",
    },
    historicalSpecs: [],
    isCreatingConversation: false,
    isExecutingSpec: false,
    isGeneratingSpec: false,
    isLoadingSpec: false,
    isRevisingSpec: false,
    isSwitchingIterationMode: false,
    isVerifyingSpec: false,
    projectError: null,
    projects: [createProject()],
    runProjectCommand: vi.fn(async () => ({
      output: "ok",
      success: true,
    })),
    showArchivedConversations: false,
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

function createProject(): ProjectInfo {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    framework: "next-app-router",
    id: "project-1",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    name: "Project",
    path: "D:/projects/project-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createConversation(
  projectId: string,
  input: Record<string, unknown>,
): ProjectConversation {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    activeSpecId: (input.activeSpecId ?? null) as string | null,
    archivedAt: null,
    createdAt: now,
    id: (input.conversationId as string | undefined) ?? "conversation-1",
    kind: (input.kind as ProjectConversation["kind"] | undefined) ?? "iteration",
    lastMessageAt: now,
    messages: [],
    mode: (input.targetMode as ProjectConversation["mode"] | undefined) ??
      (input.mode as ProjectConversation["mode"] | undefined) ??
      "spec",
    modeChangedAt: (input.modeChangedAt as string | undefined) ?? now,
    projectId,
    specIds: (input.specIds as string[] | undefined) ?? [],
    title: (input.title as string | undefined) ?? "Spec iteration",
    updatedAt: now,
  };
}

function createConversationSummary(
  patch: Partial<ProjectConversationSummary> = {},
): ProjectConversationSummary {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    mode: "chat",
    projectId: "project-1",
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function createGeneratedPayload(): GeneratedSpecRevisionPayload {
  return {
    brief: "Improve checkout copy",
    design: {
      components: [],
      dataModel: [],
      integrations: [],
      pages: [],
      summary: "Update copy",
      technicalDecisions: [],
      verificationStrategy: [],
    },
    requirements: {
      acceptanceCriteria: [
        {
          description: "Checkout copy is clearer",
          id: "criterion-1",
          required: true,
        },
      ],
      constraints: [],
      goal: "Improve checkout copy",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [
        {
          description: "As a shopper I understand checkout next steps",
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
        objective: "Update checkout copy",
        requirementIds: ["story-1"],
        title: "Copy update",
      },
    ],
  };
}

function createSpec(patch: Partial<DevelopmentSpec> & { tasks?: SpecRevision["tasks"] } = {}): DevelopmentSpec {
  const revision = createRevision({ tasks: patch.tasks });

  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentRevisionId: revision.id,
    id: "spec-1",
    kind: "feature",
    projectId: "project-1",
    revisions: [revision],
    status: "building",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function createExecutableRevision(
  patch: Partial<SpecRevision> = {},
): SpecRevision {
  const payload = createGeneratedPayload();

  return createRevision({
    requirements: payload.requirements,
    tasks: [createExecutableTask("task-1")],
    ...patch,
  });
}

function createRevision(patch: Partial<SpecRevision> = {}): SpecRevision {
  return {
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
      acceptanceCriteria: [],
      constraints: [],
      goal: "Goal",
      outOfScope: [],
      unresolvedQuestions: [],
      userStories: [],
    },
    tasks: [],
    version: 1,
    ...patch,
  };
}

function createExecutableTask(
  id: string,
  patch: Partial<SpecRevision["tasks"][number]> = {},
): SpecRevision["tasks"][number] {
  return createTask(id, {
    acceptanceCriteriaIds: ["criterion-1"],
    allowedPaths: ["app/page.tsx"],
    expectedFiles: ["app/page.tsx"],
    requirementIds: ["story-1"],
    ...patch,
  });
}

function createTask(
  id: string,
  patch: Partial<SpecRevision["tasks"][number]> = {},
): SpecRevision["tasks"][number] {
  return {
    acceptanceCriteriaIds: [],
    allowedPaths: [],
    dependencyIds: [],
    expectedFiles: [],
    id,
    objective: `Objective ${id}`,
    requirementIds: [],
    status: "pending",
    title: `Task ${id}`,
    ...patch,
  };
}

function createRun(runId: string, patch: Partial<AgentRun> = {}): AgentRun {
  const now = "2026-01-01T00:00:00.000Z";

  return {
    cancelRequested: false,
    completedAt: undefined,
    contract: {
      acceptanceCriteria: [],
      budget: {
        maxModelTurns: 1,
        maxMutations: 1,
        maxRepairCycles: 1,
        maxToolCalls: 1,
      },
      objective: "Run task",
      permissions: {
        databaseChange: "deny",
        dependencyChange: "deny",
        fileDelete: "deny",
        fileWrite: true,
        previewDeployment: "deny",
        productionDeployment: "deny",
      },
      scope: {
        allowedPaths: ["app/page.tsx"],
        forbiddenPaths: [],
      },
      taskType: "component_edit",
    },
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

function createVerificationReport(
  runId: string,
  status: VerificationReport["status"],
): VerificationReport {
  return {
    artifactIds: [],
    checks: [],
    createdAt: "2026-01-01T00:02:00.000Z",
    id: `report-${runId}`,
    missingEvidence: status === "passed" ? [] : ["criterion failed"],
    newlyIntroducedFailures: [],
    repairFeedback: status === "passed" ? [] : ["Fix the criterion"],
    runId,
    status,
  };
}

function createSpecRunContract(
  spec: DevelopmentSpec,
  task: SpecRevision["tasks"][number],
): AgentRun["contract"] {
  return {
    acceptanceCriteria: spec.revisions[0].requirements.acceptanceCriteria,
    budget: {
      maxModelTurns: 1,
      maxMutations: 1,
      maxRepairCycles: 1,
      maxToolCalls: 1,
    },
    objective: task.objective,
    permissions: {
      databaseChange: "deny",
      dependencyChange: "deny",
      fileDelete: "deny",
      fileWrite: true,
      previewDeployment: "deny",
      productionDeployment: "deny",
    },
    scope: {
      allowedPaths: task.allowedPaths,
      forbiddenPaths: [],
    },
    source: {
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      executionMode: "modify",
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: spec.currentRevisionId,
      specId: spec.id,
      taskId: task.id,
    },
    taskType: "component_edit",
  };
}

type RuntimeInput = {
  runId: string;
};

type StoreState = {
  agentRuns: AgentRun[];
  cancelCurrentAgentRunAndWait: () => Promise<AgentRun | null>;
  changeHistory: unknown[];
  chatMessages: ProjectConversation["messages"];
  conversationSummaries: ProjectConversationSummary[];
  currentAgentRun: AgentRun | null;
  currentConversation: ProjectConversation | null;
  currentProject: ProjectInfo | null;
  currentSpec: DevelopmentSpec | null;
  fileTree: unknown;
  historicalSpecs: DevelopmentSpec[];
  isCreatingConversation: boolean;
  isExecutingSpec: boolean;
  isGeneratingSpec: boolean;
  isLoadingSpec: boolean;
  isRevisingSpec: boolean;
  isSwitchingIterationMode: boolean;
  isVerifyingSpec: boolean;
  projectError: string | null;
  projects: ProjectInfo[];
  runProjectCommand: (projectId: string, command: string) => Promise<{
    output: string;
    success: boolean;
  }>;
  showArchivedConversations: boolean;
  terminalLogs: string[];
};
