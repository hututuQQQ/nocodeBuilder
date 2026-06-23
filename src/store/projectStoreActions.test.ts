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

  it("cleans up and returns null when Initial Spec creation fails", async () => {
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
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    chatMessages: [],
    conversationSummaries: [],
    createInitialSpec: vi.fn(async () => null),
    currentConversation: null,
    currentProject: null,
    currentSpec: null,
    historicalSpecs: [],
    isCreatingProject: false,
    projectError: null,
    projects: [],
    selectProject: vi.fn(async () => undefined),
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
  chatMessages: unknown[];
  conversationSummaries: unknown[];
  createInitialSpec: ReturnType<typeof vi.fn>;
  currentConversation: unknown | null;
  currentProject: ProjectInfo | null;
  currentSpec: unknown | null;
  historicalSpecs: unknown[];
  isCreatingProject: boolean;
  projectError: string | null;
  projects: ProjectInfo[];
  selectProject: ReturnType<typeof vi.fn>;
  terminalLogs: string[];
};
