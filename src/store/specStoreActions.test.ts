import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentApproval,
  AgentRun,
  AgentRunCheckpoint,
  VerificationReport,
} from "../agent-core/types";
import type { ProjectConversation, ProjectConversationSummary, ProjectInfo } from "../services/projects";
import type { DevelopmentSpec, GeneratedSpecRevisionPayload, SpecRevision } from "../spec-core/types";
import { computePersistedAcceptanceResults } from "../spec-core/validators";
import {
  __specStoreActionsTestUtils,
  createSpecActions,
} from "./specStoreActions";
import {
  clearAllSpecExecutionCancellationsForTests,
  requestSpecExecutionCancellation,
} from "../spec-runtime/executionCancellation";

const fake = vi.hoisted(() => ({
  agentRuns: new Map<string, unknown>(),
  approvals: [] as AgentApproval[],
  buildProjectBackendContext: vi.fn(),
  checkpoints: new Map<string, unknown>(),
  createProjectConversation: vi.fn(),
  createSpec: vi.fn(),
  deleteUnattachedSpec: vi.fn(),
  events: new Map<string, unknown[]>(),
  listProjectConversations: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  readSpec: vi.fn(),
  requestFeatureSpec: vi.fn(),
  requestInitialSpec: vi.fn(),
  requestSpecRevision: vi.fn(),
  runSpecTaskRuntime: vi.fn(),
  saveSpec: vi.fn(),
  saveProjectConversation: vi.fn(),
  specs: new Map<string, DevelopmentSpec>(),
  switchProjectConversationMode: vi.fn(),
  verificationReports: new Map<string, unknown>(),
}));

vi.mock("../agent/projectModifier", () => ({
  formatProjectFileTree: vi.fn(() => "app/page.tsx"),
  getContextFilePaths: vi.fn(() => []),
}));

vi.mock("../agent/project/backendContext", () => ({
  buildProjectBackendContext: (...args: unknown[]) =>
    fake.buildProjectBackendContext(...args),
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
    listApprovals: vi.fn(async (_projectId: string, runId: string) =>
      fake.approvals.filter((approval) => approval.runId === runId),
    ),
    listEvents: vi.fn(async (_projectId: string, runId: string) =>
      fake.events.get(runId) ?? [],
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
    listFiles: (...args: unknown[]) => fake.listFiles(...args),
    readFile: (...args: unknown[]) => fake.readFile(...args),
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
    fake.approvals = [];
    fake.buildProjectBackendContext.mockReset();
    fake.checkpoints = new Map();
    fake.createProjectConversation.mockReset();
    fake.createSpec.mockReset();
    fake.deleteUnattachedSpec.mockReset();
    fake.events = new Map();
    fake.listProjectConversations.mockReset();
    fake.listFiles.mockReset();
    fake.readFile.mockReset();
    fake.readSpec.mockReset();
    fake.requestFeatureSpec.mockReset();
    fake.requestInitialSpec.mockReset();
    fake.requestSpecRevision.mockReset();
    fake.runSpecTaskRuntime.mockReset();
    fake.saveSpec.mockReset();
    fake.saveProjectConversation.mockReset();
    __specStoreActionsTestUtils.resetSpecExecutionLease();
    fake.specs = new Map();
    fake.switchProjectConversationMode.mockReset();
    fake.verificationReports = new Map();
    clearAllSpecExecutionCancellationsForTests();
    fake.buildProjectBackendContext.mockResolvedValue({
      supabase: { configured: true },
    });
    fake.createSpec.mockImplementation(async (_projectId: string, spec: DevelopmentSpec) => {
      fake.specs.set(spec.id, spec);
      return spec;
    });
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
      fake.specs.get(specId) ?? createSpec({ id: specId, status: "completed" }),
    );
    fake.listFiles.mockResolvedValue({
      children: [],
      kind: "directory",
      name: "app",
      path: "",
    });
    fake.readFile.mockImplementation(async (_projectId: string, path: string) => {
      if (path === "pnpm-lock.yaml") {
        throw new Error("not found");
      }

      return "";
    });
    fake.requestFeatureSpec.mockResolvedValue(createGeneratedPayload());
    fake.requestInitialSpec.mockResolvedValue(createGeneratedPayload());
    fake.requestSpecRevision.mockResolvedValue(createGeneratedPayload());
    fake.runSpecTaskRuntime.mockResolvedValue({
      run: null,
      verificationReport: null,
    });
    fake.saveSpec.mockImplementation(async (_projectId: string, spec: DevelopmentSpec) => {
      fake.specs.set(spec.id, spec);
      return spec;
    });
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

  it("uses target project context when creating a Feature Spec for another project", async () => {
    const currentProject = createProject({
      id: "project-current",
      name: "Current Project",
    });
    const targetProject = createProject({
      id: "project-target",
      name: "Target Project",
    });
    fake.listProjectConversations.mockResolvedValue([
      createConversationSummary({
        activeSpecId: "spec-target-initial",
        id: "conversation-target-initial",
        kind: "initial_build",
        mode: "spec",
        projectId: targetProject.id,
        title: "Initial build",
      }),
    ]);
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-target-initial",
        id: "spec-target-initial",
        projectId: targetProject.id,
        status: "completed",
      }),
    );
    fake.listFiles.mockResolvedValue({
      children: [
        {
          kind: "file",
          name: "page.tsx",
          path: "app/page.tsx",
        },
      ],
      kind: "directory",
      name: "app",
      path: "",
    });
    fake.createProjectConversation.mockImplementation(
      async (projectId: string, input: Record<string, unknown>) =>
        createConversation(projectId, input),
    );
    const store = createStore({
      changeHistory: [{ id: "stale-change" }],
      currentConversation: createConversation(currentProject.id, {
        conversationId: "conversation-current",
        mode: "chat",
        title: "Current chat",
      }),
      currentProject,
      fileTree: {
        children: [
          {
            kind: "file",
            name: "stale.tsx",
            path: "app/stale.tsx",
          },
        ],
        kind: "directory",
        name: "app",
        path: "",
      },
      projects: [currentProject, targetProject],
    });
    const actions = createSpecActions(store as never);

    await actions.createFeatureSpecIteration(
      targetProject.id,
      "Checkout copy",
      "Improve checkout copy",
    );

    const requestInput = fake.requestFeatureSpec.mock.calls[0][0] as {
      context: {
        changeHistory: unknown[];
        currentConversation: {
          id?: string;
          messages: unknown[];
          title?: string;
        };
      };
    };
    expect(fake.listFiles).toHaveBeenCalledWith(targetProject.id);
    expect(requestInput.context.changeHistory).toEqual([]);
    expect(requestInput.context.currentConversation).toEqual({
      id: undefined,
      messages: [],
      title: undefined,
    });
    expect(fake.createProjectConversation).toHaveBeenCalledWith(
      targetProject.id,
      expect.objectContaining({
        kind: "iteration",
        mode: "spec",
      }),
    );
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

  it("switches an existing Chat iteration to Spec without creating a new conversation", async () => {
    const historicalSpec = createSpec({
      id: "spec-history",
      status: "completed",
    });
    const conversation = createConversation("project-1", {
      activeSpecId: null,
      conversationId: "conversation-1",
      mode: "chat",
      specIds: [historicalSpec.id],
      title: "Chat iteration",
    });
    const store = createStore({
      currentConversation: conversation,
      currentSpec: null,
      historicalSpecs: [historicalSpec],
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToSpec("Add saved searches");

    const createdSpec = fake.createSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: createdSpec.id,
        conversationId: conversation.id,
        specIds: [historicalSpec.id, createdSpec.id],
        targetMode: "spec",
      }),
    );
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentConversation?.activeSpecId).toBe(createdSpec.id);
    expect(store.get().currentSpec?.id).toBe(createdSpec.id);
    expect(store.get().historicalSpecs.map((spec) => spec.id)).toEqual(
      expect.arrayContaining([historicalSpec.id, createdSpec.id]),
    );
  });

  it("cleans up an unattached Spec and keeps Chat mode when Chat to Spec switch fails", async () => {
    fake.switchProjectConversationMode.mockRejectedValue(new Error("mode switch rejected"));
    const historicalSpec = createSpec({
      id: "spec-history",
      status: "completed",
    });
    const conversation = createConversation("project-1", {
      activeSpecId: null,
      conversationId: "conversation-1",
      mode: "chat",
      specIds: [historicalSpec.id],
      title: "Chat iteration",
    });
    const store = createStore({
      currentConversation: conversation,
      currentSpec: null,
      historicalSpecs: [historicalSpec],
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToSpec("Add saved searches");

    const createdSpec = fake.createSpec.mock.calls[0][1] as DevelopmentSpec;
    expect(fake.deleteUnattachedSpec).toHaveBeenCalledWith(
      "project-1",
      createdSpec.id,
    );
    expect(store.get().currentConversation).toBe(conversation);
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([historicalSpec]);
    expect(store.get().projectError).toBe("mode switch rejected");
    expect(store.get().isGeneratingSpec).toBe(false);
    expect(store.get().isSwitchingIterationMode).toBe(false);
  });

  it("drops a stale Chat to Spec response when the conversation changes", async () => {
    let store: ReturnType<typeof createStore>;
    const conversation = createConversation("project-1", {
      activeSpecId: null,
      conversationId: "conversation-1",
      mode: "chat",
      specIds: [],
      title: "Chat iteration",
    });
    fake.requestFeatureSpec.mockImplementation(async () => {
      store.set({
        currentConversation: createConversation("project-1", {
          activeSpecId: null,
          conversationId: "conversation-2",
          mode: "chat",
          specIds: [],
          title: "Other iteration",
        }),
      });
      return createGeneratedPayload();
    });
    store = createStore({
      currentConversation: conversation,
      currentSpec: null,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToSpec("Add saved searches");

    expect(fake.createSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(fake.deleteUnattachedSpec).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.id).toBe("conversation-2");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().isGeneratingSpec).toBe(false);
    expect(store.get().isSwitchingIterationMode).toBe(false);
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

  it("does not load historical specs from another conversation", async () => {
    const foreignSpec = createSpec({
      conversationId: "conversation-other",
      id: "spec-history",
      status: "completed",
    });
    fake.readSpec.mockResolvedValue(foreignSpec);
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

    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
    expect(store.get().projectError).toBe(
      "Failed to load Spec history: spec-history: Spec does not belong to the current conversation.",
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

  it("does not activate an active Spec from another conversation", async () => {
    const foreignSpec = createSpec({
      conversationId: "conversation-other",
      id: "spec-active",
      status: "completed",
    });
    fake.readSpec.mockResolvedValue(foreignSpec);
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: "spec-active",
        conversationId: "conversation-1",
        mode: "spec",
        specIds: ["spec-active"],
        title: "Spec iteration",
      }),
      currentSpec: null,
      historicalSpecs: [],
    });
    const actions = createSpecActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadCurrentSpec();

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-active");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
    expect(store.get().projectError).toBe(
      "Spec does not belong to the current conversation.",
    );
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

  it("blocks the Spec when launching a task runtime throws after runId persistence", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1"),
        createExecutableTask("task-2", {
          dependencyIds: ["task-1"],
        }),
      ],
    });
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
    });
    fake.runSpecTaskRuntime.mockRejectedValue(new Error("runtime crashed"));
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    const currentTasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toBe("Task Task task-1 failed.");
    expect(currentTasks[0]).toMatchObject({
      error: "runtime crashed",
      runId: expect.stringMatching(/^run-/),
      status: "failed",
    });
    expect(currentTasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
  });

  it("auto-retries when Spec runtime returns no passed verification report", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1"),
        createExecutableTask("task-2", {
          dependencyIds: ["task-1"],
        }),
      ],
    });
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
    });
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      expect(input.runId).toMatch(/^run-/);

      return {
        run: null,
        verificationReport: null,
      };
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    const currentTasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    const firstRunId = fake.runSpecTaskRuntime.mock.calls[0][0].runId;
    const finalRunId = fake.runSpecTaskRuntime.mock.calls[2][0].runId;
    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(3);
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().terminalLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "[spec] Auto-retrying task task-1 (1/2) after: AgentRun ended without a passed verification report.",
        ),
        expect.stringContaining(
          "[spec] Auto-retrying task task-1 (2/2) after: AgentRun ended without a passed verification report.",
        ),
      ]),
    );
    expect(currentTasks[0]).toMatchObject({
      autoRetryCount: 2,
      error: "AgentRun ended without a passed verification report.",
      runId: finalRunId,
      status: "failed",
    });
    expect(finalRunId).not.toBe(firstRunId);
    expect(currentTasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
  });

  it("passes previous run context into automatic Spec task retries", async () => {
    const revision = createExecutableRevision({
      tasks: [createExecutableTask("task-1")],
    });
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
    });
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      if (fake.runSpecTaskRuntime.mock.calls.length === 1) {
        fake.agentRuns.set(input.runId, createRun(input.runId, {
          completedAt: "2026-01-01T00:02:00.000Z",
          modelTurns: 44,
          phase: "budget_exceeded",
          status: "budget_exceeded",
        }));
        fake.checkpoints.set(input.runId, createCheckpoint(input.runId, {
          changedFiles: ["app/api/rooms/route.ts"],
          observations: [
            JSON.stringify({
              content: "Invalid model response: unsupported Supabase default value \"''\".",
              ok: false,
              summary: "Model response validation failed",
              tool: "model_validation",
            }),
          ],
        }));
        fake.verificationReports.set(
          input.runId,
          createVerificationReport(input.runId, "failed"),
        );
        fake.events.set(input.runId, [
          {
            artifactIds: [],
            id: "event-context-budget",
            payload: {
              failureKind: "context_budget",
              reason: "Fake AI request exceeded the model context length.",
            },
            runId: input.runId,
            sequence: 1,
            timestamp: "2026-01-01T00:02:00.000Z",
            type: "run.budget_exceeded",
          },
        ]);

        return {
          run: createRun(input.runId, {
            completedAt: "2026-01-01T00:02:00.000Z",
            phase: "budget_exceeded",
            status: "budget_exceeded",
          }),
          verificationReport: createVerificationReport(input.runId, "failed"),
        };
      }

      expect(input.resumeObservation).toMatchObject({
        ok: false,
        tool: "spec_retry_context",
      });
      expect(input.resumeObservation?.content).toContain("Previous run status: budget_exceeded");
      expect(input.resumeObservation?.content).toContain("Terminal failure kind: context_budget");
      expect(input.resumeObservation?.content).toContain("context length");
      expect(input.resumeObservation?.content).toContain("app/api/rooms/route.ts");
      expect(input.resumeObservation?.content).toContain("model_validation");
      expect(input.resumeObservation?.content).toContain("unsupported Supabase default value");
      const passedReport = createVerificationReport(input.runId, "passed");
      fake.verificationReports.set(input.runId, passedReport);

      return {
        run: createRun(input.runId, {
          completedAt: "2026-01-01T00:03:00.000Z",
          phase: "completed",
          status: "completed",
        }),
        verificationReport: passedReport,
      };
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    expect(fake.runSpecTaskRuntime.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fake.runSpecTaskRuntime.mock.calls[1][0].resumeObservation?.content)
      .toContain("Previous run status: budget_exceeded");
  });

  it("does not project a stale Spec task result into the current Spec", async () => {
    const revision = createExecutableRevision({
      tasks: [createExecutableTask("task-1")],
    });
    const runningSpec = createSpec({
      conversationId: "conversation-old",
      currentRevisionId: revision.id,
      id: "spec-old",
      revisions: [revision],
      status: "review",
    });
    const visibleSpec = createSpec({
      conversationId: "conversation-new",
      id: "spec-new",
      status: "building",
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-visible",
          status: "running",
        }),
      ],
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: runningSpec.id,
        conversationId: runningSpec.conversationId,
        mode: "spec",
        specIds: [runningSpec.id],
        title: "Old Spec",
      }),
      currentSpec: runningSpec,
    });

    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      store.set({
        currentConversation: createConversation("project-1", {
          activeSpecId: visibleSpec.id,
          conversationId: visibleSpec.conversationId,
          mode: "spec",
          specIds: [visibleSpec.id],
          title: "Visible Spec",
        }),
        currentSpec: visibleSpec,
      });

      return {
        run: createRun(input.runId, {
          completedAt: "2026-01-01T00:01:00.000Z",
          phase: "completed",
          status: "completed",
        }),
        verificationReport: createVerificationReport(input.runId, "passed"),
      };
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    expect(store.get().currentSpec?.id).toBe("spec-new");
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: "run-visible",
      status: "running",
    });
    expect(fake.specs.get("spec-old")?.revisions[0].tasks[0].status).toBe("passed");
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

  it("recovers a stale busy flag when the persisted running task already failed", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-stale-failed",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-stale-failed", createRun("run-stale-failed", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, {
        phase: "paused",
        status: "paused",
      }),
      verificationReport: null,
    }));
    const store = createStore({
      currentSpec: spec,
      isExecutingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution({ recoverStaleRun: true });

    const task = store.get().currentSpec?.revisions[0].tasks[0];
    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({
      runId: expect.stringMatching(/^run-/),
      status: "running",
    });
    expect(task?.runId).not.toBe("run-stale-failed");
    expect(task?.autoRetryCount).toBe(1);
    expect(store.get().isExecutingSpec).toBe(false);
    expect(store.get().terminalLogs).toContain(
      "[spec] Recovering orphaned Spec execution lock for a terminal task run.",
    );
  });

  it("does not recover a terminal task run while the active lease is current", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-terminal",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-terminal", createRun("run-terminal", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    __specStoreActionsTestUtils.setSpecExecutionLease(createExecutionLease(spec));
    const store = createStore({
      currentSpec: spec,
      isExecutingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution({ recoverStaleRun: true });

    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: "run-terminal",
      status: "running",
    });
    expect(store.get().terminalLogs).toContain(
      "[spec] Reconcile request skipped because the active Spec execution lease is still current.",
    );
  });

  it("recovers when the active execution lease times out", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-timed-out",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-timed-out", createRun("run-timed-out", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, {
        phase: "paused",
        status: "paused",
      }),
      verificationReport: null,
    }));
    __specStoreActionsTestUtils.setSpecExecutionLease(
      createExecutionLease(spec, "2000-01-01T00:00:00.000Z"),
    );
    const store = createStore({
      currentSpec: spec,
      isExecutingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution({ recoverStaleRun: true });

    const task = store.get().currentSpec?.revisions[0].tasks[0];
    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(task).toMatchObject({
      runId: expect.stringMatching(/^run-/),
      status: "running",
    });
    expect(task?.runId).not.toBe("run-timed-out");
    expect(store.get().terminalLogs).toContain(
      "[spec] Recovering stale Spec execution lease after heartbeat timeout.",
    );
  });

  it("does not let a superseded session save stale task results", async () => {
    const revision = createExecutableRevision({
      approvedAt: "2026-01-01T00:00:01.000Z",
      tasks: [createExecutableTask("task-1")],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "approved",
    });
    let firstRunId = "";
    let resolveFirstRun!: (value: {
      run: AgentRun;
      verificationReport: VerificationReport;
    }) => void;
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      if (!firstRunId) {
        firstRunId = input.runId;
        return new Promise((resolve) => {
          resolveFirstRun = resolve;
        });
      }

      return {
        run: createRun(input.runId, {
          phase: "paused",
          status: "paused",
        }),
        verificationReport: null,
      };
    });
    const store = createStore({ currentSpec: spec });
    const actions = createSpecActions(store as never);

    const firstExecution = actions.continueCurrentSpecExecution();
    await flushPromises();
    fake.agentRuns.set(firstRunId, createRun(firstRunId, {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    __specStoreActionsTestUtils.setSpecExecutionLease(
      createExecutionLease(spec, "2000-01-01T00:00:00.000Z"),
    );

    await actions.continueCurrentSpecExecution({ recoverStaleRun: true });
    const recoveredRunId = store.get().currentSpec?.revisions[0].tasks[0].runId;

    resolveFirstRun({
      run: createRun(firstRunId, {
        completedAt: "2026-01-01T00:03:00.000Z",
        phase: "completed",
        status: "completed",
      }),
      verificationReport: createVerificationReport(firstRunId, "passed"),
    });
    await firstExecution;

    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(2);
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: recoveredRunId,
      status: "running",
    });
    expect(recoveredRunId).not.toBe(firstRunId);
  });

  it("does not retry the current running Spec task while execution is active", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-stale-failed",
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
    fake.agentRuns.set("run-stale-failed", createRun("run-stale-failed", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, {
        phase: "paused",
        status: "paused",
      }),
      verificationReport: null,
    }));
    const store = createStore({
      currentSpec: spec,
      isExecutingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.retryCurrentSpecTaskExecution();

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({
      runId: "run-stale-failed",
      status: "running",
    });
    expect(tasks[1]).toMatchObject({ status: "pending" });
    expect(store.get().isExecutingSpec).toBe(true);
    expect(store.get().terminalLogs).toContain(
      "[spec] Retry request skipped because Spec execution is already busy.",
    );
  });

  it("does not continue execution for a stale Spec from another conversation", async () => {
    const revision = createExecutableRevision({
      approvedAt: "2026-01-01T00:00:01.000Z",
      tasks: [createExecutableTask("task-1")],
    });
    const staleSpec = createSpec({
      conversationId: "conversation-stale",
      currentRevisionId: revision.id,
      id: "spec-stale",
      revisions: [revision],
      status: "approved",
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

    await actions.continueCurrentSpecExecution();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(staleSpec);
    expect(store.get().projectError).toBe(
      "Active Spec does not belong to the current conversation.",
    );
  });

  it("blocks downstream tasks when a running task is missing its runId during reconcile", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          status: "running",
        }),
        createExecutableTask("task-2", {
          dependencyIds: ["task-1"],
        }),
        createExecutableTask("task-3", {
          dependencyIds: ["task-2"],
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

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(tasks[0]).toMatchObject({
      error: "Running task is missing its AgentRun id.",
      status: "failed",
    });
    expect(tasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
    expect(tasks[2]).toMatchObject({
      blockedByTaskId: "task-2",
      status: "blocked",
    });
  });

  it("marks a missing AgentRun as retryable blocked instead of leaving it running", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-missing",
          status: "running",
        }),
        createExecutableTask("task-2", {
          dependencyIds: ["task-1"],
        }),
        createExecutableTask("task-3", {
          dependencyIds: ["task-2"],
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

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(tasks[0]).toMatchObject({
      error: "AgentRun run-missing was not found.",
      status: "failed",
    });
    expect(tasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
    expect(tasks[2]).toMatchObject({
      blockedByTaskId: "task-2",
      status: "blocked",
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
      contract: createSpecRunContract(spec, revision.tasks[0]),
      phase: "waiting_approval",
      status: "waiting_approval",
    }));
    fake.approvals.push(createApproval("approval-1", "run-waiting"));
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
    expect(store.get().currentAgentRun?.id).toBe("run-waiting");
    expect(store.get().agentRuns.map((run) => run.id)).toEqual(["run-waiting"]);
    expect(store.get().currentAgentApproval?.id).toBe("approval-1");
  });

  it("keeps paused runs as running during Spec reconcile", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-paused",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-paused", createRun("run-paused", {
      contract: createSpecRunContract(spec, revision.tasks[0]),
      phase: "paused",
      status: "paused",
    }));
    const store = createStore({
      currentAgentApproval: createApproval("approval-stale", "run-paused"),
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      runId: "run-paused",
      status: "running",
    });
    expect(store.get().currentAgentRun?.id).toBe("run-paused");
    expect(store.get().currentAgentRun?.status).toBe("paused");
    expect(store.get().agentRuns.map((run) => run.id)).toEqual(["run-paused"]);
    expect(store.get().currentAgentApproval).toBeNull();
  });

  it("reconciles a completed run as passed and continues the next task", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-completed",
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
    fake.agentRuns.set("run-completed", createRun("run-completed", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set(
      "run-completed",
      createVerificationReport("run-completed", "passed"),
    );
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, {
        phase: "paused",
        status: "paused",
      }),
      verificationReport: null,
    }));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(tasks[0]).toMatchObject({
      error: undefined,
      runId: "run-completed",
      status: "passed",
    });
    expect(tasks[1]).toMatchObject({
      runId: expect.stringMatching(/^run-/),
      status: "running",
    });
    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(fake.runSpecTaskRuntime.mock.calls[0][0]).toMatchObject({
      runId: tasks[1].runId,
      taskObjective: tasks[1].objective,
    });
    expect(store.get().currentSpec?.status).toBe("building");
  });

  it("maps a budget-exceeded run to a retryable failed task during reconcile", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          autoRetryCount: 2,
          runId: "run-budget",
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
    fake.agentRuns.set("run-budget", createRun("run-budget", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "budget_exceeded",
      status: "budget_exceeded",
    }));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toBe("Task Task task-1 failed.");
    expect(tasks[0]).toMatchObject({
      error: "AgentRun ended with status budget_exceeded.",
      runId: "run-budget",
      status: "failed",
    });
    expect(tasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
  });

  it("uses newly introduced verifier failures as the Spec task failure message", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          autoRetryCount: 2,
          runId: "run-new-failure",
          status: "running",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "building",
    });
    fake.agentRuns.set("run-new-failure", createRun("run-new-failure", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "failed",
      status: "failed",
    }));
    fake.verificationReports.set("run-new-failure", {
      ...createVerificationReport("run-new-failure", "failed"),
      missingEvidence: [],
      newlyIntroducedFailures: ["npm run build failed: TypeScript error in app/page.tsx."],
      repairFeedback: [],
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const task = store.get().currentSpec?.revisions[0].tasks[0];
    expect(task).toMatchObject({
      error: "npm run build failed: TypeScript error in app/page.tsx.",
      runId: "run-new-failure",
      status: "failed",
    });
  });

  it("does not auto-retry a loop-exhausted terminal run during reconcile", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-loop",
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
    fake.agentRuns.set("run-loop", createRun("run-loop", {
      completedAt: "2026-01-01T00:02:00.000Z",
      phase: "budget_exceeded",
      status: "budget_exceeded",
    }));
    fake.events.set("run-loop", [
      {
        artifactIds: [],
        id: "event-loop",
        payload: {
          failureKind: "loop_exhausted",
          reason: "The same failure repeated after one focused rescue attempt.",
        },
        runId: "run-loop",
        sequence: 1,
        timestamp: "2026-01-01T00:02:00.000Z",
        type: "run.budget_exceeded",
      },
    ]);
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const tasks = store.get().currentSpec?.revisions[0].tasks ?? [];
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(tasks[0]).toMatchObject({
      error: "The same failure repeated after one focused rescue attempt.",
      runId: "run-loop",
      status: "failed",
    });
    expect(tasks[0]?.autoRetryCount).toBeUndefined();
    expect(tasks[1]).toMatchObject({
      blockedByTaskId: "task-1",
      status: "blocked",
    });
    expect(store.get().terminalLogs.join("\n")).not.toContain("Auto-retrying task task-1");
  });

  it("blocks completion when a required acceptance criterion is pending", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          autoRetryCount: 2,
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
          autoRetryCount: 2,
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

  it("auto-retries a task when final acceptance evidence uses a failed report", async () => {
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
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => {
      const run = createRun(input.runId, {
        completedAt: "2026-01-01T00:03:00.000Z",
        phase: "completed",
        status: "completed",
      });
      const report = createVerificationReport(input.runId, "passed");
      fake.agentRuns.set(input.runId, run);
      fake.verificationReports.set(input.runId, report);

      return {
        run,
        verificationReport: report,
      };
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    const retriedRunId = fake.runSpecTaskRuntime.mock.calls[0][0].runId;
    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("completed");
    expect(store.get().currentSpec?.revisions[0].tasks[0]).toMatchObject({
      autoRetryCount: 1,
      error: undefined,
      runId: retriedRunId,
      status: "passed",
    });
    expect(store.get().terminalLogs).toContain(
      "[spec] Auto-retrying task task-1 (1/2) after: Acceptance criteria are not passing: criterion-1.",
    );
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
          autoRetryCount: 2,
          runId: "run-1",
          status: "passed",
        }),
        createExecutableTask("task-2", {
          acceptanceCriteriaIds: ["criterion-optional"],
          autoRetryCount: 2,
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

  it("does not retry a failed task for a stale Spec from another conversation", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          error: "failed",
          runId: "run-1",
          status: "failed",
        }),
      ],
    });
    const staleSpec = createSpec({
      conversationId: "conversation-stale",
      currentRevisionId: revision.id,
      id: "spec-stale",
      revisions: [revision],
      status: "blocked",
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

    await actions.retrySpecTask("task-1");

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(staleSpec);
    expect(store.get().projectError).toBe(
      "Active Spec does not belong to the current conversation.",
    );
  });

  it("does not retry a failed task while another Spec workflow is busy", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          error: "failed",
          runId: "run-1",
          status: "failed",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      revisions: [revision],
      status: "blocked",
    });
    const store = createStore({
      currentSpec: spec,
      isSwitchingIterationMode: true,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecTask("task-1");

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(spec);
  });

  it("does not retry a blocked task while its blocking dependency is still failed", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          error: "Task failed.",
          runId: "run-1",
          status: "failed",
        }),
        createExecutableTask("task-2", {
          blockedByTaskId: "task-1",
          dependencyIds: ["task-1"],
          error: "Blocked because dependency task-1 failed.",
          status: "blocked",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      failureMessage: "Task Task task-1 failed.",
      revisions: [revision],
      status: "blocked",
    });
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecTask("task-2");

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(spec);
  });

  it("retries a recoverable blocked task once its dependencies have passed", async () => {
    const revision = createExecutableRevision({
      tasks: [
        createExecutableTask("task-1", {
          runId: "run-1",
          status: "passed",
        }),
        createExecutableTask("task-2", {
          blockedByTaskId: "task-1",
          dependencyIds: ["task-1"],
          error: "Blocked because dependency task-1 failed.",
          status: "blocked",
        }),
      ],
    });
    const spec = createSpec({
      currentRevisionId: revision.id,
      failureMessage: "Task Task task-1 failed.",
      revisions: [revision],
      status: "blocked",
    });
    fake.runSpecTaskRuntime.mockImplementation(async (input: RuntimeInput) => ({
      run: createRun(input.runId, {
        phase: "paused",
        status: "paused",
      }),
      verificationReport: null,
    }));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.retrySpecTask("task-2");

    expect(fake.runSpecTaskRuntime).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().currentSpec?.revisions[0].tasks).toMatchObject([
      {
        id: "task-1",
        status: "passed",
      },
      {
        blockedByTaskId: undefined,
        error: undefined,
        id: "task-2",
        runId: expect.stringMatching(/^run-/),
        status: "running",
      },
    ]);
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

  it("does not retry verification while another Spec workflow is busy", async () => {
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
    const store = createStore({
      currentSpec: spec,
      isGeneratingSpec: true,
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
    expect(store.get().currentSpec?.failureMessage).toBeUndefined();
    expect(store.get().runProjectCommand).toHaveBeenCalledWith(
      "project-1",
      "npm run build",
    );
  });

  it("retries verification after failed acceptance criteria evidence", async () => {
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
      failureMessage: "Required acceptance criteria are not all passing: criterion-1.",
      finalVerification: {
        checkedAt: "2026-01-01T00:03:00.000Z",
        command: "acceptance criteria",
        output: "Required acceptance criteria are not all passing: criterion-1.",
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

    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("completed");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm run build",
      success: true,
    });
    expect(store.get().currentSpec?.failureMessage).toBeUndefined();
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
    expect(store.get().currentSpec?.failureMessage).toBeUndefined();
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

  it("uses pnpm for final verification when pnpm-lock.yaml is present", async () => {
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
      fileTree: {
        children: [
          {
            kind: "file",
            name: "pnpm-lock.yaml",
            path: "pnpm-lock.yaml",
          },
        ],
        kind: "directory",
        name: "",
        path: "",
      },
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(runProjectCommand.mock.calls.map((call) => call[1])).toEqual([
      "pnpm install",
      "pnpm build",
    ]);
    expect(store.get().currentSpec?.finalVerification?.command).toBe(
      "pnpm install && pnpm build",
    );
    expect(store.get().currentSpec?.finalVerification?.output).toContain(
      "pnpm install ok",
    );
  });

  it("runs npm install when checkpoint changedFiles includes package.json", async () => {
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
      changedFiles: ["app/page.tsx", "package.json"],
      packageChanged: false,
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

  it("persists fallback evidence when final npm install fails without output", async () => {
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
    const runProjectCommand = vi.fn(async () => ({
      output: "   ",
      success: false,
    }));
    const store = createStore({
      currentSpec: spec,
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain("No command output.");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm install",
      output: "No command output.",
      success: false,
    });
    expect(runProjectCommand).toHaveBeenCalledTimes(1);
  });

  it("persists final npm install thrown errors as verification evidence", async () => {
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
    const runProjectCommand = vi.fn(async () => {
      throw new Error("install process crashed");
    });
    const store = createStore({
      currentSpec: spec,
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain(
      "install process crashed",
    );
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm install",
      output: "install process crashed",
      success: false,
    });
    expect(runProjectCommand).toHaveBeenCalledTimes(1);
  });

  it("persists final build thrown errors as verification evidence", async () => {
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
    const runProjectCommand = vi.fn(async () => {
      throw new Error("build process crashed");
    });
    const store = createStore({
      currentSpec: spec,
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("blocked");
    expect(store.get().currentSpec?.failureMessage).toContain(
      "build process crashed",
    );
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm run build",
      output: "build process crashed",
      success: false,
    });
    expect(runProjectCommand).toHaveBeenCalledWith("project-1", "npm run build");
  });

  it("persists fallback evidence when final build succeeds without output", async () => {
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
    const runProjectCommand = vi.fn(async () => ({
      output: "   ",
      success: true,
    }));
    const store = createStore({
      currentSpec: spec,
      runProjectCommand,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("completed");
    expect(store.get().currentSpec?.finalVerification).toMatchObject({
      command: "npm run build",
      output: "npm run build completed successfully without command output.",
      success: true,
    });
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

  it("keeps a terminal Spec visible in history when switching to Chat", async () => {
    const spec = createSpec({
      completedAt: "2026-01-01T00:01:00.000Z",
      status: "completed",
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
      historicalSpecs: [],
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: null,
        conversationId: conversation.id,
        specIds: [spec.id],
        targetMode: "chat",
      }),
    );
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([spec]);
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

  it("ignores an unrelated active AgentRun and cancels the current Spec run", async () => {
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
    const conversation = createConversation("project-1", {
      activeSpecId: spec.id,
      conversationId: spec.conversationId,
      mode: "spec",
      specIds: [spec.id],
      title: "Spec iteration",
    });
    const persistedRun = createRun("run-current", {
      contract: createSpecRunContract(spec, revision.tasks[0]),
      status: "planning",
    });
    let store: ReturnType<typeof createStore>;
    const cancelCurrentAgentRunAndWait = vi.fn(async () => {
      expect(store.get().currentAgentRun?.id).toBe("run-current");
      return createRun("run-current", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
        status: "cancelled",
      });
    });

    fake.agentRuns.set("run-current", persistedRun);
    store = createStore({
      cancelCurrentAgentRunAndWait,
      currentAgentRun: createRun("run-unrelated", {
        contract: createSpecRunContract(spec, revision.tasks[0]),
      }),
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

  it("does not cancel a stale AgentRun when the current Spec run is missing", async () => {
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
      "AgentRun run-current was not found.",
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

  it("keeps Spec mode when cancellation returns a stale cancelled run", async () => {
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
        createRun("run-stale", {
          contract: createSpecRunContract(spec, revision.tasks[0]),
          status: "cancelled",
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
    expect(store.get().currentSpec?.status).toBe("building");
    expect(store.get().projectError).toBe(
      "Cancelled AgentRun does not belong to the current Spec task.",
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

  it("does not switch to Chat while Spec generation is busy", async () => {
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
      isGeneratingSpec: true,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.switchProjectConversationMode).not.toHaveBeenCalled();
    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().currentSpec?.status).toBe("review");
    expect(store.get().projectError).toBe(
      "Wait for the active Spec operation to finish before switching modes.",
    );
  });

  it("requests safe-boundary cancellation when switching verifying Spec to Chat", async () => {
    const spec = createVerifyingSpec();
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: spec.id,
        conversationId: spec.conversationId,
        mode: "spec",
        specIds: [spec.id],
        title: "Spec iteration",
      }),
      currentSpec: spec,
      isVerifyingSpec: false,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    const cancelledSpec = fake.saveSpec.mock.calls[
      fake.saveSpec.mock.calls.length - 1
    ][1] as DevelopmentSpec;
    expect(cancelledSpec.status).toBe("cancelled");
    expect(fake.switchProjectConversationMode).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        activeSpecId: null,
        conversationId: spec.conversationId,
        targetMode: "chat",
      }),
    );
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().currentSpec).toBeNull();
  });

  it("stops final verification after install when cancellation is requested", async () => {
    const spec = createVerifyingSpec({ kind: "initial_build" });
    const commands: string[] = [];
    const store = createStore({
      currentSpec: spec,
      runProjectCommand: vi.fn(async (_projectId: string, command: string) => {
        commands.push(command);

        if (command === "npm install") {
          requestSpecExecutionCancellation({
            conversationId: spec.conversationId,
            modeChangedAt: store.get().currentConversation?.modeChangedAt ?? "",
            projectId: spec.projectId,
            specId: spec.id,
          });
        }

        return {
          output: "ok",
          success: true,
        };
      }),
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(commands).toEqual(["npm install"]);
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().historicalSpecs[0].status).toBe("cancelled");
  });

  it("does not complete final verification when cancellation is requested after build", async () => {
    const spec = createVerifyingSpec();
    const commands: string[] = [];
    const store = createStore({
      currentSpec: spec,
      runProjectCommand: vi.fn(async (_projectId: string, command: string) => {
        commands.push(command);
        requestSpecExecutionCancellation({
          conversationId: spec.conversationId,
          modeChangedAt: store.get().currentConversation?.modeChangedAt ?? "",
          projectId: spec.projectId,
          specId: spec.id,
        });

        return {
          output: "ok",
          success: true,
        };
      }),
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(commands).toEqual(["npm run build"]);
    expect(store.get().currentConversation?.mode).toBe("chat");
    expect(store.get().historicalSpecs[0].status).toBe("cancelled");
    expect(store.get().historicalSpecs[0].status).not.toBe("completed");
  });

  it("ignores cancellation requests for an old Spec id", async () => {
    requestSpecExecutionCancellation({
      conversationId: "conversation-old",
      modeChangedAt: "2026-01-01T00:00:00.000Z",
      projectId: "project-1",
      specId: "spec-old",
    });
    const spec = createVerifyingSpec();
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.continueCurrentSpecExecution();

    expect(store.get().currentSpec?.status).toBe("completed");
  });

  it("keeps Spec mode when safe-boundary switch fails", async () => {
    const spec = createVerifyingSpec();
    fake.switchProjectConversationMode.mockRejectedValue(new Error("switch failed"));
    const store = createStore({
      currentSpec: spec,
    });
    const actions = createSpecActions(store as never);

    await actions.switchCurrentIterationToChat({ cancelActiveSpec: true });

    expect(store.get().currentConversation?.mode).toBe("spec");
    expect(store.get().projectError).toBe("switch failed");
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

  it("does not approve while another Spec workflow action is busy", async () => {
    for (const busyFlag of [
      "isGeneratingSpec",
      "isVerifyingSpec",
      "isSwitchingIterationMode",
    ] as const) {
      fake.saveSpec.mockClear();
      fake.runSpecTaskRuntime.mockClear();
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
        [busyFlag]: true,
      });
      const actions = createSpecActions(store as never);

      await actions.approveAndExecuteCurrentSpec();

      expect(fake.saveSpec).not.toHaveBeenCalled();
      expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
      expect(store.get().currentSpec?.status).toBe("review");
    }
  });

  it("does not approve a stale Spec from another conversation", async () => {
    const revision = createExecutableRevision();
    const staleSpec = createSpec({
      conversationId: "conversation-stale",
      currentRevisionId: revision.id,
      id: "spec-stale",
      revisions: [revision],
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: staleSpec.id,
        conversationId: "conversation-1",
        mode: "spec",
        specIds: [staleSpec.id],
        title: "Spec iteration",
      }),
      currentSpec: staleSpec,
    });
    const actions = createSpecActions(store as never);

    await actions.approveAndExecuteCurrentSpec();

    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.runSpecTaskRuntime).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(staleSpec);
    expect(store.get().projectError).toBe(
      "Active Spec does not belong to the current conversation.",
    );
  });

  it("returns true after creating a revised Spec draft", async () => {
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
    });
    const actions = createSpecActions(store as never);

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(true);
    expect(fake.saveSpec).toHaveBeenCalledTimes(2);
    expect(store.get().currentSpec?.status).toBe("review");
    expect(store.get().currentSpec?.revisions).toHaveLength(2);
    expect(store.get().currentSpec?.currentRevisionId).not.toBe(revision.id);
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

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.requestSpecRevision).not.toHaveBeenCalled();
    expect(store.get().currentSpec?.status).toBe("review");
  });

  it("does not request a revision while another Spec workflow action is busy", async () => {
    for (const busyFlag of [
      "isExecutingSpec",
      "isGeneratingSpec",
      "isVerifyingSpec",
      "isSwitchingIterationMode",
    ] as const) {
      fake.saveSpec.mockClear();
      fake.requestSpecRevision.mockClear();
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
        [busyFlag]: true,
      });
      const actions = createSpecActions(store as never);

      const result = await actions.reviseCurrentSpec("Tighten the requirements");

      expect(result).toBe(false);
      expect(fake.saveSpec).not.toHaveBeenCalled();
      expect(fake.requestSpecRevision).not.toHaveBeenCalled();
      expect(store.get().currentSpec?.status).toBe("review");
    }
  });

  it("does not request a revision for a stale Spec from another conversation", async () => {
    const revision = createExecutableRevision();
    const staleSpec = createSpec({
      conversationId: "conversation-stale",
      currentRevisionId: revision.id,
      id: "spec-stale",
      revisions: [revision],
      status: "review",
    });
    const store = createStore({
      currentConversation: createConversation("project-1", {
        activeSpecId: staleSpec.id,
        conversationId: "conversation-1",
        mode: "spec",
        specIds: [staleSpec.id],
        title: "Spec iteration",
      }),
      currentSpec: staleSpec,
    });
    const actions = createSpecActions(store as never);

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
    expect(fake.saveSpec).not.toHaveBeenCalled();
    expect(fake.requestSpecRevision).not.toHaveBeenCalled();
    expect(store.get().currentSpec).toBe(staleSpec);
    expect(store.get().projectError).toBe(
      "Active Spec does not belong to the current conversation.",
    );
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

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
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

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
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

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
    expect(fake.saveSpec).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec).toBe(replacementSpec);
    expect(store.get().currentSpec?.revisions).toHaveLength(1);
  });

  it("discards stale revision responses after the Spec leaves revising", async () => {
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
    fake.requestSpecRevision.mockImplementation(async () => {
      const currentSpec = store.get().currentSpec;

      store.set({
        currentSpec: currentSpec
          ? {
              ...currentSpec,
              status: "review",
            }
          : currentSpec,
      });

      return createGeneratedPayload();
    });
    const actions = createSpecActions(store as never);

    const result = await actions.reviseCurrentSpec("Tighten the requirements");

    expect(result).toBe(false);
    expect(fake.saveSpec).toHaveBeenCalledTimes(1);
    expect(store.get().currentSpec?.status).toBe("review");
    expect(store.get().currentSpec?.currentRevisionId).toBe(revision.id);
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
          runId: "run-stale-2",
          status: "blocked",
        }),
        createTask("task-3", {
          blockedByTaskId: "task-2",
          dependencyIds: ["task-2"],
          error: "blocked",
          runId: "run-stale-3",
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
        createTask("task-7", {
          blockedByTaskId: "task-2",
          dependencyIds: ["task-2", "task-5"],
          error: "blocked by two failed chains",
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
    expect(taskById.get("task-2")?.runId).toBeUndefined();
    expect(taskById.get("task-3")).toMatchObject({ status: "pending" });
    expect(taskById.get("task-3")?.blockedByTaskId).toBeUndefined();
    expect(taskById.get("task-3")?.runId).toBeUndefined();
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
    expect(taskById.get("task-7")).toMatchObject({
      blockedByTaskId: "task-2",
      status: "blocked",
    });
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  const inferredConversation =
    !Object.prototype.hasOwnProperty.call(patch, "currentConversation") &&
    patch.currentSpec
      ? createConversation(patch.currentSpec.projectId, {
          activeSpecId: patch.currentSpec.id,
          conversationId: patch.currentSpec.conversationId,
          mode: "spec",
          specIds: [patch.currentSpec.id],
          title: "Spec iteration",
        })
      : null;
  let state: StoreState = {
    agentRuns: [],
    cancelCurrentAgentRunAndWait: vi.fn(async () => null),
    changeHistory: [],
    chatMessages: [],
    conversationSummaries: [],
    currentAgentApproval: null,
    currentAgentRun: null,
    currentVerificationReport: null,
    currentConversation: inferredConversation,
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

function createExecutionLease(
  spec: DevelopmentSpec,
  updatedAt = new Date().toISOString(),
) {
  return {
    conversationId: spec.conversationId,
    revisionId: spec.currentRevisionId,
    sessionId: "spec-session-test",
    specId: spec.id,
    startedAt: updatedAt,
    updatedAt,
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createProject(patch: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    framework: "next-app-router",
    id: "project-1",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    name: "Project",
    path: "D:/projects/project-1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
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

function createVerifyingSpec(
  patch: Partial<DevelopmentSpec> & { tasks?: SpecRevision["tasks"] } = {},
): DevelopmentSpec {
  const tasks = patch.tasks ?? [
    createExecutableTask("task-1", {
      runId: "run-verified",
      status: "passed",
    }),
  ];
  const revision = createExecutableRevision({ tasks });
  const spec = createSpec({
    currentRevisionId: revision.id,
    revisions: [revision],
    status: "verifying",
    ...patch,
  });

  for (const task of tasks) {
    if (!task.runId) {
      continue;
    }

    fake.agentRuns.set(task.runId, createRun(task.runId, {
      completedAt: "2026-01-01T00:01:00.000Z",
      phase: "completed",
      status: "completed",
    }));
    fake.verificationReports.set(
      task.runId,
      createVerificationReport(task.runId, "passed"),
    );
  }

  fake.specs.set(spec.id, spec);
  return spec;
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

function createCheckpoint(
  runId: string,
  patch: Partial<AgentRunCheckpoint> = {},
): AgentRunCheckpoint {
  return {
    changedFiles: [],
    createdAt: "2026-01-01T00:02:00.000Z",
    deletedFiles: [],
    id: `checkpoint-${runId}`,
    observations: [],
    packageChanged: false,
    plan: null,
    readSnapshots: [],
    repairFeedback: [],
    runId,
    steeringWatermark: 0,
    workspaceFingerprint: "workspace:fingerprint",
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

function createApproval(id: string, runId: string): AgentApproval {
  return {
    createdAt: "2026-01-01T00:01:00.000Z",
    exactSideEffect: "Write app/page.tsx",
    expiresAt: "2026-01-01T01:01:00.000Z",
    id,
    normalizedArgsHash: "hash-1",
    runId,
    targetResources: ["app/page.tsx"],
    toolCallId: "tool-call-1",
    toolName: "write_files",
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
  resumeObservation?: {
    content?: string;
    ok: boolean;
    summary: string;
    tool: string;
  };
  runId: string;
};

type StoreState = {
  agentRuns: AgentRun[];
  cancelCurrentAgentRunAndWait: () => Promise<AgentRun | null>;
  changeHistory: unknown[];
  chatMessages: ProjectConversation["messages"];
  conversationSummaries: ProjectConversationSummary[];
  currentAgentApproval: AgentApproval | null;
  currentAgentRun: AgentRun | null;
  currentVerificationReport: VerificationReport | null;
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
