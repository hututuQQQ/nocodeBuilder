import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "../services/projects";
import { createProjectActions } from "./projectStoreActions";

const fake = vi.hoisted(() => ({
  createProject: vi.fn(),
  deleteUninitializedProject: vi.fn(),
}));

vi.mock("../agent/projectModifier", () => ({
  getContextFilePaths: vi.fn(() => []),
}));

vi.mock("../services/projects", () => ({
  getProjectErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  projectApi: {
    createProject: (...args: unknown[]) => fake.createProject(...args),
    deleteUninitializedProject: (...args: unknown[]) =>
      fake.deleteUninitializedProject(...args),
  },
}));

describe("project store actions", () => {
  beforeEach(() => {
    fake.createProject.mockReset();
    fake.deleteUninitializedProject.mockReset();
  });

  it("cleans up and returns null when Initial Spec AI generation fails", async () => {
    const project = createProject();
    fake.createProject.mockResolvedValue(project);
    fake.deleteUninitializedProject.mockResolvedValue(undefined);
    const store = createStore({
      createInitialSpec: vi.fn(async () => null),
    });
    const actions = createProjectActions(store as never);

    await expect(actions.createProject("Project", "Brief")).resolves.toBeNull();

    expect(fake.deleteUninitializedProject).toHaveBeenCalledWith(project.id);
    expect(store.get().projects).toEqual([]);
    expect(store.get().currentProject).toBeNull();
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
  });

  it("cleans up and preserves the error when Initial Spec persistence fails", async () => {
    const project = createProject();
    fake.createProject.mockResolvedValue(project);
    fake.deleteUninitializedProject.mockResolvedValue(undefined);
    const store = createStore({
      createInitialSpec: vi.fn(async () => {
        store.set({
          projectError: "spec: failed to move spec into place",
        });
        return null;
      }),
    });
    const actions = createProjectActions(store as never);

    await expect(actions.createProject("Project", "Brief")).resolves.toBeNull();

    expect(fake.deleteUninitializedProject).toHaveBeenCalledWith(project.id);
    expect(store.get().projectError).toBe("spec: failed to move spec into place");
    expect(store.get().projects).toEqual([]);
    expect(store.get().currentProject).toBeNull();
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
  });

  it("surfaces cleanup failure without hiding the disk project", async () => {
    const project = createProject();
    fake.createProject.mockResolvedValue(project);
    fake.deleteUninitializedProject.mockRejectedValue(
      new Error("project: cannot delete initialized project metadata"),
    );
    const store = createStore({
      createInitialSpec: vi.fn(async () => {
        store.set({
          projectError: "spec: failed to create initial build",
        });
        return null;
      }),
    });
    const actions = createProjectActions(store as never);

    await expect(actions.createProject("Project", "Brief")).resolves.toBeNull();

    expect(fake.deleteUninitializedProject).toHaveBeenCalledWith(project.id);
    expect(store.get().projectError).toContain(
      "spec: failed to create initial build",
    );
    expect(store.get().projectError).toContain(
      "Failed to clean up Project: project: cannot delete initialized project metadata",
    );
    expect(store.get().terminalLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Failed to clean up Project: project: cannot delete initialized project metadata",
        ),
      ]),
    );
    expect(store.get().projects).toEqual([project]);
    expect(store.get().currentProject).toEqual(project);
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
  });

  it("returns the project only after Initial Build conversation is created", async () => {
    const project = createProject();
    const calls: string[] = [];
    const initialConversation = {
      id: "conversation-1",
      kind: "initial_build",
      mode: "spec",
      projectId: project.id,
    };
    fake.createProject.mockResolvedValue(project);
    const store = createStore({
      createInitialSpec: vi.fn(async () => {
        calls.push("createInitialSpec");
        expect(store.get().selectProject).not.toHaveBeenCalled();
        return initialConversation;
      }),
      selectProject: vi.fn(async () => {
        calls.push("selectProject");
        store.set({
          currentConversation: initialConversation,
          currentProject: project,
          currentSpec: { id: "spec-1" },
          historicalSpecs: [{ id: "spec-1" }],
        });
      }),
    });
    const actions = createProjectActions(store as never);

    await expect(actions.createProject("Project", "Brief")).resolves.toBe(project);

    expect(fake.deleteUninitializedProject).not.toHaveBeenCalled();
    expect(calls).toEqual(["createInitialSpec", "selectProject"]);
    expect(store.get().selectProject).toHaveBeenCalledWith(project.id, {
      startDevServer: false,
    });
    expect(store.get().createInitialSpec).toHaveBeenCalledWith(
      project.id,
      "Brief",
      "Initial build",
    );
    expect(store.get().currentProject).toBe(project);
    expect(store.get().currentConversation).toBe(initialConversation);
    expect(store.get().currentSpec).toEqual({ id: "spec-1" });
  });

  it("does not run full selection before Initial Spec succeeds", async () => {
    const project = createProject();
    fake.createProject.mockResolvedValue(project);
    fake.deleteUninitializedProject.mockResolvedValue(undefined);
    const store = createStore({
      createInitialSpec: vi.fn(async () => {
        expect(store.get().currentProject).toEqual(project);
        expect(store.get().projects).toEqual([project]);
        expect(store.get().selectProject).not.toHaveBeenCalled();
        return null;
      }),
    });
    const actions = createProjectActions(store as never);

    await actions.createProject("Project", "Brief");

    expect(store.get().selectProject).not.toHaveBeenCalled();
  });

  it("blocks creating a new project while workspace navigation is locked", async () => {
    const store = createStore({
      currentAgentRun: {
        status: "waiting_approval",
      },
      currentProject: createProject(),
    });
    const actions = createProjectActions(store as never);

    await expect(actions.createProject("Project", "Brief")).resolves.toBeNull();

    expect(fake.createProject).not.toHaveBeenCalled();
    expect(store.get().projectError).toContain(
      "Finish, pause and cancel, or explicitly cancel",
    );
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    activeCommandRunId: null,
    agentEvents: [],
    agentRuns: [],
    chatMessages: [],
    changeHistory: [],
    commandRuns: [],
    conversationSummaries: [],
    createInitialSpec: vi.fn(async () => null),
    currentAgentApproval: null,
    currentAgentRun: null,
    currentConversation: null,
    currentProject: null,
    currentSpec: null,
    currentVerificationReport: null,
    devServerStatus: "stopped",
    fileTree: null,
    historicalSpecs: [],
    initialBuildSpec: null,
    isExecutingSpec: false,
    isGeneratingProject: false,
    isGeneratingSpec: false,
    isModifyingProject: false,
    isRevisingSpec: false,
    isRunningCommand: false,
    isSwitchingIterationMode: false,
    isCreatingProject: false,
    isVerifyingSpec: false,
    lastDeploymentUrl: null,
    previewUrl: null,
    projectError: null,
    projects: [],
    selectedChangeFilePath: null,
    selectedFileContent: "",
    selectedFilePath: null,
    selectedSiteNodeId: null,
    selectProject: vi.fn(async () => undefined),
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

type StoreState = {
  activeCommandRunId: string | null;
  agentEvents: unknown[];
  agentRuns: unknown[];
  chatMessages: unknown[];
  changeHistory: unknown[];
  commandRuns: Array<{ id: string; projectId: string; status: string }>;
  conversationSummaries: unknown[];
  createInitialSpec: ReturnType<typeof vi.fn>;
  currentAgentApproval: unknown | null;
  currentAgentRun: { status: string } | null;
  currentConversation: unknown | null;
  currentProject: ProjectInfo | null;
  currentSpec: unknown | null;
  currentVerificationReport: unknown | null;
  devServerStatus: string;
  fileTree: unknown | null;
  historicalSpecs: unknown[];
  initialBuildSpec: unknown | null;
  isExecutingSpec: boolean;
  isGeneratingProject: boolean;
  isGeneratingSpec: boolean;
  isModifyingProject: boolean;
  isRevisingSpec: boolean;
  isRunningCommand: boolean;
  isSwitchingIterationMode: boolean;
  isCreatingProject: boolean;
  isVerifyingSpec: boolean;
  lastDeploymentUrl: string | null;
  previewUrl: string | null;
  projectError: string | null;
  projects: ProjectInfo[];
  selectedChangeFilePath: string | null;
  selectedFileContent: string;
  selectedFilePath: string | null;
  selectedSiteNodeId: string | null;
  selectProject: ReturnType<typeof vi.fn>;
  showArchivedConversations: boolean;
  terminalLogs: string[];
};
