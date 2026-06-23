import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConversation, ProjectConversationSummary, ProjectInfo } from "../services/projects";
import type { DevelopmentSpec, GeneratedSpecRevisionPayload, SpecRevision } from "../spec-core/types";
import {
  __specStoreActionsTestUtils,
  createSpecActions,
} from "./specStoreActions";

const fake = vi.hoisted(() => ({
  createProjectConversation: vi.fn(),
  createSpec: vi.fn(),
  deleteUnattachedSpec: vi.fn(),
  requestFeatureSpec: vi.fn(),
  saveProjectConversation: vi.fn(),
}));

vi.mock("../agent/projectModifier", () => ({
  formatProjectFileTree: vi.fn(() => "app/page.tsx"),
  getContextFilePaths: vi.fn(() => []),
}));

vi.mock("../agent-runtime/runController", () => ({
  runSpecTaskRuntime: vi.fn(),
}));

vi.mock("../services/agentRuntime", () => ({
  agentRuntimeApi: {
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
    listFiles: vi.fn(async () => ({
      children: [],
      kind: "directory",
      name: "app",
      path: "",
    })),
    readFile: vi.fn(async () => ""),
    saveProjectConversation: (...args: unknown[]) =>
      fake.saveProjectConversation(...args),
  },
}));

vi.mock("../services/specs", () => ({
  specApi: {
    createSpec: (...args: unknown[]) => fake.createSpec(...args),
    deleteUnattachedSpec: (...args: unknown[]) =>
      fake.deleteUnattachedSpec(...args),
  },
}));

vi.mock("../spec-runtime/requests", () => ({
  requestFeatureSpec: (...args: unknown[]) => fake.requestFeatureSpec(...args),
  requestInitialSpec: vi.fn(),
  requestSpecRevision: vi.fn(),
}));

describe("spec store actions", () => {
  beforeEach(() => {
    fake.createProjectConversation.mockReset();
    fake.createSpec.mockReset();
    fake.deleteUnattachedSpec.mockReset();
    fake.requestFeatureSpec.mockReset();
    fake.saveProjectConversation.mockReset();
    fake.createSpec.mockImplementation(async (_projectId: string, spec: DevelopmentSpec) => spec);
    fake.deleteUnattachedSpec.mockResolvedValue(undefined);
    fake.requestFeatureSpec.mockResolvedValue(createGeneratedPayload());
    fake.saveProjectConversation.mockImplementation(
      async (_projectId: string, conversation: ProjectConversation) => conversation,
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
    changeHistory: [],
    chatMessages: [],
    conversationSummaries: [],
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
    activeSpecId: input.activeSpecId as string,
    archivedAt: null,
    createdAt: now,
    id: input.conversationId as string,
    kind: "iteration",
    lastMessageAt: now,
    messages: [],
    mode: "spec",
    modeChangedAt: now,
    projectId,
    specIds: input.specIds as string[],
    title: input.title as string,
    updatedAt: now,
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

type StoreState = {
  changeHistory: unknown[];
  chatMessages: ProjectConversation["messages"];
  conversationSummaries: ProjectConversationSummary[];
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
  showArchivedConversations: boolean;
  terminalLogs: string[];
};
