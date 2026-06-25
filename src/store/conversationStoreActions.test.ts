import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectConversation,
  ProjectConversationSummary,
} from "../services/projects";
import { createConversationActions } from "./conversationStoreActions";

const fake = vi.hoisted(() => ({
  archiveProjectConversation: vi.fn(),
  createProjectConversation: vi.fn(),
  listProjectConversations: vi.fn(),
  readSpec: vi.fn(),
  readProjectConversation: vi.fn(),
  unarchiveProjectConversation: vi.fn(),
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    archiveProjectConversation: (...args: unknown[]) =>
      fake.archiveProjectConversation(...args),
    createProjectConversation: (...args: unknown[]) =>
      fake.createProjectConversation(...args),
    listProjectConversations: (...args: unknown[]) =>
      fake.listProjectConversations(...args),
    readProjectConversation: (...args: unknown[]) =>
      fake.readProjectConversation(...args),
    unarchiveProjectConversation: (...args: unknown[]) =>
      fake.unarchiveProjectConversation(...args),
  },
}));

vi.mock("../services/specs", () => ({
  specApi: {
    readSpec: (...args: unknown[]) => fake.readSpec(...args),
  },
}));

describe("conversation store actions", () => {
  beforeEach(() => {
    fake.archiveProjectConversation.mockReset();
    fake.createProjectConversation.mockReset();
    fake.listProjectConversations.mockReset();
    fake.readSpec.mockReset();
    fake.readProjectConversation.mockReset();
    fake.unarchiveProjectConversation.mockReset();
    fake.listProjectConversations.mockResolvedValue([]);
    fake.readSpec.mockRejectedValue(new Error("spec not loaded"));
  });

  it("does not auto-create a Chat conversation when a project has no conversations", async () => {
    fake.listProjectConversations.mockResolvedValue([]);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.listProjectConversations).toHaveBeenCalledWith("project-1", true);
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().conversationSummaries).toEqual([]);
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
  });

  it("opens the active Initial Build without creating a fallback Chat", async () => {
    const summary = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const conversation = createConversation({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      specIds: ["spec-initial"],
      title: "Initial build",
    });
    fake.listProjectConversations.mockResolvedValue([summary]);
    fake.readProjectConversation.mockResolvedValue(conversation);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-initial",
    );
    expect(store.get().currentConversation).toEqual(conversation);
    expect(store.get().chatMessages).toEqual(conversation.messages);
    expect(store.get().loadCurrentSpec).toHaveBeenCalledTimes(1);
    expect(store.get().loadAgentRuns).toHaveBeenCalledWith("project-1");
  });

  it("blocks selecting another conversation while navigation is locked", async () => {
    const current = createConversation({ id: "conversation-current" });
    const store = createStore({
      currentAgentRun: { status: "waiting_approval" },
      currentConversation: current,
    });
    const actions = createConversationActions(store as never);

    await actions.selectConversation("conversation-other");

    expect(fake.readProjectConversation).not.toHaveBeenCalled();
    expect(store.get().currentConversation).toEqual(current);
    expect(store.get().projectError).toContain(
      "Finish, pause and cancel, or explicitly cancel",
    );
  });

  it("treats selecting the current conversation as a no-op while locked", async () => {
    const current = createConversation({ id: "conversation-current" });
    const store = createStore({
      currentAgentRun: { status: "paused" },
      currentConversation: current,
    });
    const actions = createConversationActions(store as never);

    await actions.selectConversation("conversation-current");

    expect(fake.readProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBeNull();
  });

  it("loads completed Initial Build evidence while opening a later iteration", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const iteration = createSummary({
      id: "conversation-iteration",
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });
    const completedSpec = createSpec({
      conversationId: "conversation-initial",
      id: "spec-initial",
      status: "completed",
    });
    const conversation = createConversation({
      id: "conversation-iteration",
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });
    fake.listProjectConversations.mockResolvedValue([iteration, initialBuild]);
    fake.readProjectConversation.mockResolvedValue(conversation);
    fake.readSpec.mockResolvedValue(completedSpec);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(store.get().initialBuildSpec).toEqual(completedSpec);
    expect(store.get().currentConversation).toEqual(conversation);
    expect(store.get().loadAgentRuns).toHaveBeenCalledWith("project-1");
  });

  it("keeps archived completed Initial Spec evidence when no active iterations exist", async () => {
    const archivedInitialBuild = createSummary({
      activeSpecId: "spec-initial",
      archivedAt: "2026-01-01T00:01:00.000Z",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const completedSpec = createSpec({
      conversationId: "conversation-initial",
      id: "spec-initial",
      status: "completed",
    });
    fake.listProjectConversations.mockResolvedValue([archivedInitialBuild]);
    fake.readSpec.mockResolvedValue(completedSpec);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.listProjectConversations).toHaveBeenCalledWith("project-1", true);
    expect(fake.readProjectConversation).not.toHaveBeenCalled();
    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(store.get().conversationSummaries).toEqual([archivedInitialBuild]);
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([completedSpec]);
  });

  it("blocks incomplete Initial Build archive before calling Host", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "review",
      }),
    );
    const store = createStore({
      conversationSummaries: [initialBuild],
    });
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.archiveConversation("conversation-initial");

    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(fake.archiveProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before archiving",
    );
  });

  it("blocks archiving the current conversation while navigation is locked", async () => {
    const current = createConversation({ id: "conversation-current" });
    const store = createStore({
      conversationSummaries: [createSummary({ id: "conversation-current" })],
      currentAgentRun: { status: "paused" },
      currentConversation: current,
    });
    const actions = createConversationActions(store as never);

    await actions.archiveConversation("conversation-current");

    expect(fake.archiveProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toContain(
      "Finish, pause and cancel, or explicitly cancel",
    );
  });

  it("blocks creating a new iteration while a chat run is active", async () => {
    const store = createStore({
      currentAgentRun: { status: "planning" },
      currentConversation: createConversation(),
    });
    const actions = createConversationActions(store as never);

    await expect(actions.createConversation("project-1", "Follow-up")).resolves.toBeNull();

    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toContain(
      "Finish, pause and cancel, or explicitly cancel",
    );
  });

  it("allows completed Initial Build archive through the action gate", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const archivedConversation = createConversation({
      activeSpecId: "spec-initial",
      archivedAt: "2026-01-01T00:02:00.000Z",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      specIds: ["spec-initial"],
      title: "Initial build",
    });
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "completed",
      }),
    );
    fake.archiveProjectConversation.mockResolvedValue(archivedConversation);
    const store = createStore({
      conversationSummaries: [initialBuild],
    });
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.archiveConversation("conversation-initial");

    expect(fake.archiveProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-initial",
    );
    expect(store.get().conversationSummaries[0]).toMatchObject({
      archivedAt: "2026-01-01T00:02:00.000Z",
      id: "conversation-initial",
    });
  });

  it("opens Initial Build instead of an existing iteration while Initial Spec is incomplete", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const iteration = createSummary({
      id: "conversation-iteration",
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });
    const reviewSpec = createSpec({
      conversationId: "conversation-initial",
      id: "spec-initial",
      status: "review",
    });
    const initialConversation = createConversation({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      specIds: ["spec-initial"],
      title: "Initial build",
    });
    fake.listProjectConversations.mockResolvedValue([iteration, initialBuild]);
    fake.readSpec.mockResolvedValue(reviewSpec);
    fake.readProjectConversation.mockResolvedValue(initialConversation);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-initial",
    );
    expect(fake.readProjectConversation).not.toHaveBeenCalledWith(
      "project-1",
      "conversation-iteration",
    );
    expect(store.get().initialBuildSpec).toEqual(reviewSpec);
    expect(store.get().currentConversation).toEqual(initialConversation);
  });

  it("does not keep a current iteration while Initial Spec is incomplete", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const iteration = createSummary({
      id: "conversation-iteration",
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });
    const reviewSpec = createSpec({
      conversationId: "conversation-initial",
      id: "spec-initial",
      status: "review",
    });
    const initialConversation = createConversation({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      specIds: ["spec-initial"],
      title: "Initial build",
    });
    fake.listProjectConversations.mockResolvedValue([iteration, initialBuild]);
    fake.readSpec.mockResolvedValue(reviewSpec);
    fake.readProjectConversation.mockResolvedValue(initialConversation);
    const store = createStore({
      currentConversation: createConversation({
        id: "conversation-iteration",
        kind: "iteration",
        mode: "chat",
        title: "Follow-up",
      }),
    });
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-initial",
    );
    expect(store.get().currentConversation).toEqual(initialConversation);
  });

  it("does not select an existing iteration before Initial Spec completes", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const iteration = createSummary({
      id: "conversation-iteration",
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });
    fake.readProjectConversation.mockResolvedValue(
      createConversation({
        id: "conversation-iteration",
        kind: "iteration",
        mode: "chat",
        title: "Follow-up",
      }),
    );
    fake.listProjectConversations.mockResolvedValue([initialBuild, iteration]);
    fake.readSpec.mockResolvedValue(
      createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "review",
      }),
    );
    const store = createStore({
      conversationSummaries: [initialBuild, iteration],
    });
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.selectConversation("conversation-iteration");

    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-iteration",
    );
    expect(fake.listProjectConversations).toHaveBeenCalledWith(
      "project-1",
      true,
    );
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before creating iterations",
    );
  });

  it("reloads read-only Spec history when reselecting a Chat iteration", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const historicalSpec = createSpec({
      conversationId: "conversation-iteration",
      id: "spec-history",
      status: "completed",
    });
    const iteration = createConversation({
      id: "conversation-iteration",
      mode: "chat",
      specIds: ["spec-history"],
      title: "Follow-up",
    });
    fake.readProjectConversation.mockResolvedValue(iteration);
    const store = createStore({
      conversationSummaries: [initialBuild],
      initialBuildSpec: createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "completed",
      }),
      loadCurrentSpec: vi.fn(async () => {
        store.set({
          currentSpec: null,
          historicalSpecs: [historicalSpec],
        });
      }),
    });
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.selectConversation("conversation-iteration");

    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-iteration",
    );
    expect(store.get().loadCurrentSpec).toHaveBeenCalledTimes(1);
    expect(store.get().currentConversation).toEqual(iteration);
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([historicalSpec]);
  });

  it("does not create a new iteration while a Spec operation is busy", async () => {
    const store = createStore({
      isRevisingSpec: true,
    });
    const actions = createConversationActions(store as never);

    const conversation = await actions.createConversation("project-1", {
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });

    expect(conversation).toBeNull();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "Wait for the current Spec operation to finish before creating a new iteration.",
    );
    expect(store.get().terminalLogs).toEqual(
      expect.arrayContaining([
        "[conversation] New iteration blocked while Spec operation is in progress.",
      ]),
    );
  });

  it("does not create an iteration before the Initial Spec completes", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const store = createStore({
      conversationSummaries: [initialBuild],
      currentConversation: createConversation({
        activeSpecId: "spec-initial",
        id: "conversation-initial",
        kind: "initial_build",
        mode: "spec",
        specIds: ["spec-initial"],
        title: "Initial build",
      }),
      currentSpec: {
        id: "spec-initial",
        status: "review",
      },
    });
    const actions = createConversationActions(store as never);

    const conversation = await actions.createConversation("project-1", {
      kind: "iteration",
      mode: "chat",
      title: "Follow-up",
    });

    expect(conversation).toBeNull();
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before creating iterations",
    );
    expect(store.get().terminalLogs).toEqual(
      expect.arrayContaining([
        "[conversation] New iteration blocked until Initial Spec completes.",
      ]),
    );
  });

  it("creates the first iteration after the Initial Spec completes", async () => {
    const initialBuild = createSummary({
      activeSpecId: "spec-initial",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const iteration = createConversation({
      id: "conversation-iteration",
      title: "Follow-up",
    });
    fake.createProjectConversation.mockResolvedValue(iteration);
    const store = createStore({
      conversationSummaries: [initialBuild],
      currentConversation: createConversation({
        activeSpecId: "spec-initial",
        id: "conversation-initial",
        kind: "initial_build",
        mode: "spec",
        specIds: ["spec-initial"],
        title: "Initial build",
      }),
      currentSpec: createSpec({
        conversationId: "conversation-initial",
        id: "spec-initial",
        status: "completed",
      }),
    });
    const actions = createConversationActions(store as never);

    await expect(
      actions.createConversation("project-1", {
        kind: "iteration",
        mode: "chat",
        title: "Follow-up",
      }),
    ).resolves.toEqual(iteration);

    expect(fake.createProjectConversation).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        kind: "iteration",
        mode: "chat",
        title: "Follow-up",
      }),
    );
  });

  it("creates the first iteration after a completed Initial Build was archived", async () => {
    const archivedInitialBuild = createSummary({
      activeSpecId: "spec-initial",
      archivedAt: "2026-01-01T00:01:00.000Z",
      id: "conversation-initial",
      kind: "initial_build",
      mode: "spec",
      title: "Initial build",
    });
    const completedSpec = createSpec({
      conversationId: "conversation-initial",
      id: "spec-initial",
      status: "completed",
    });
    const iteration = createConversation({
      id: "conversation-iteration",
      title: "Follow-up",
    });
    fake.createProjectConversation.mockResolvedValue(iteration);
    const store = createStore({
      conversationSummaries: [archivedInitialBuild],
      historicalSpecs: [completedSpec],
    });
    const actions = createConversationActions(store as never);

    await expect(
      actions.createConversation("project-1", {
        kind: "iteration",
        mode: "chat",
        title: "Follow-up",
      }),
    ).resolves.toEqual(iteration);

    expect(fake.createProjectConversation).toHaveBeenCalledTimes(1);
    expect(store.get().loadAgentRuns).toHaveBeenCalledWith("project-1");
  });

  it("does not let an existing iteration summary bypass the Initial Build gate", async () => {
    const initialBuild = createSummary({
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
        createSummary({
          id: "conversation-existing",
          kind: "iteration",
          mode: "chat",
          title: "Existing iteration",
        }),
      ],
    });
    const actions = createConversationActions(store as never);

    const conversation = await actions.createConversation("project-1", {
      kind: "iteration",
      mode: "chat",
      title: "Next",
    });

    expect(conversation).toBeNull();
    expect(fake.listProjectConversations).toHaveBeenCalledWith(
      "project-1",
      true,
    );
    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().projectError).toBe(
      "conversation: initial build must complete before creating iterations",
    );
  });

  it("allows later iterations once Host confirms the Initial Build completed", async () => {
    const initialBuild = createSummary({
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
        status: "completed",
      }),
    );
    const iteration = createConversation({
      id: "conversation-next",
      title: "Next",
    });
    fake.createProjectConversation.mockResolvedValue(iteration);
    const store = createStore({
      conversationSummaries: [
        createSummary({
          activeSpecId: "spec-initial",
          id: "conversation-initial",
          kind: "initial_build",
          mode: "spec",
          title: "Initial build",
        }),
        createSummary({
          id: "conversation-existing",
          kind: "iteration",
          mode: "chat",
          title: "Existing iteration",
        }),
      ],
    });
    const actions = createConversationActions(store as never);

    await expect(
      actions.createConversation("project-1", {
        kind: "iteration",
        mode: "chat",
        title: "Next",
      }),
    ).resolves.toEqual(iteration);

    expect(fake.listProjectConversations).toHaveBeenCalledWith(
      "project-1",
      true,
    );
    expect(fake.readSpec).toHaveBeenCalledWith("project-1", "spec-initial");
    expect(fake.createProjectConversation).toHaveBeenCalledTimes(1);
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    chatMessages: [],
    activeCommandRunId: null,
    commandRuns: [],
    conversationSummaries: [],
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
    initialBuildSpec: null,
    currentSpec: null,
    historicalSpecs: [],
    isExecutingSpec: false,
    isGeneratingProject: false,
    isGeneratingSpec: false,
    isModifyingProject: false,
    isRevisingSpec: false,
    isRunningCommand: false,
    isSwitchingIterationMode: false,
    isVerifyingSpec: false,
    isLoadingConversations: false,
    loadAgentRuns: vi.fn(async () => undefined),
    loadCurrentSpec: vi.fn(async () => undefined),
    projectError: null,
    showArchivedConversations: false,
    terminalLogs: [],
    ...patch,
  };

  return {
    get: () => state,
    set: (
      patchOrUpdater:
        | Partial<StoreState>
        | ((state: StoreState) => Partial<StoreState>),
    ) => {
      const nextPatch =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(state)
          : patchOrUpdater;
      state = {
        ...state,
        ...nextPatch,
      };
    },
  };
}

function createSummary(
  patch: Partial<ProjectConversationSummary> = {},
): ProjectConversationSummary {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    mode: "chat",
    projectId: "project-1",
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function createConversation(
  patch: Partial<ProjectConversation> = {},
): ProjectConversation {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [
      {
        content: "Hello",
        id: "message-1",
        role: "user",
      },
    ],
    mode: "chat",
    modeChangedAt: "2026-01-01T00:00:00.000Z",
    projectId: "project-1",
    specIds: [],
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function createSpec(patch: Record<string, unknown> = {}) {
  return {
    conversationId: "conversation-1",
    id: "spec-1",
    projectId: "project-1",
    status: "review",
    ...patch,
  };
}

type StoreState = {
  chatMessages: ProjectConversation["messages"];
  activeCommandRunId: string | null;
  commandRuns: Array<{ id: string; projectId: string; status: string }>;
  conversationSummaries: ProjectConversationSummary[];
  currentAgentRun: { status: string } | null;
  currentConversation: ProjectConversation | null;
  currentProject: {
    createdAt: string;
    framework: "next-app-router";
    id: string;
    lastOpenedAt: string;
    name: string;
    path: string;
    updatedAt: string;
  } | null;
  initialBuildSpec: unknown | null;
  currentSpec: unknown | null;
  historicalSpecs: unknown[];
  isExecutingSpec: boolean;
  isGeneratingProject: boolean;
  isGeneratingSpec: boolean;
  isModifyingProject: boolean;
  isRevisingSpec: boolean;
  isRunningCommand: boolean;
  isSwitchingIterationMode: boolean;
  isVerifyingSpec: boolean;
  isLoadingConversations: boolean;
  loadAgentRuns: ReturnType<typeof vi.fn>;
  loadCurrentSpec: ReturnType<typeof vi.fn>;
  projectError: string | null;
  showArchivedConversations: boolean;
  terminalLogs: string[];
};
