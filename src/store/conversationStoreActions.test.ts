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

describe("conversation store actions", () => {
  beforeEach(() => {
    fake.archiveProjectConversation.mockReset();
    fake.createProjectConversation.mockReset();
    fake.listProjectConversations.mockReset();
    fake.readProjectConversation.mockReset();
    fake.unarchiveProjectConversation.mockReset();
  });

  it("does not auto-create a Chat conversation when a project has no conversations", async () => {
    fake.listProjectConversations.mockResolvedValue([]);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.listProjectConversations).toHaveBeenCalledWith("project-1", false);
    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(store.get().conversationSummaries).toEqual([]);
    expect(store.get().currentConversation).toBeNull();
    expect(store.get().currentSpec).toBeNull();
    expect(store.get().historicalSpecs).toEqual([]);
  });

  it("opens the first active conversation without creating a fallback Chat", async () => {
    const summary = createSummary();
    const conversation = createConversation();
    fake.listProjectConversations.mockResolvedValue([summary]);
    fake.readProjectConversation.mockResolvedValue(conversation);
    const store = createStore();
    const actions = createConversationActions(store as never);
    store.set(actions as unknown as Partial<StoreState>);

    await actions.loadProjectConversations("project-1");

    expect(fake.createProjectConversation).not.toHaveBeenCalled();
    expect(fake.readProjectConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-1",
    );
    expect(store.get().currentConversation).toEqual(conversation);
    expect(store.get().chatMessages).toEqual(conversation.messages);
    expect(store.get().loadCurrentSpec).toHaveBeenCalledTimes(1);
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
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    chatMessages: [],
    conversationSummaries: [],
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
    currentSpec: null,
    historicalSpecs: [],
    isExecutingSpec: false,
    isGeneratingSpec: false,
    isRevisingSpec: false,
    isSwitchingIterationMode: false,
    isVerifyingSpec: false,
    isLoadingConversations: false,
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

type StoreState = {
  chatMessages: ProjectConversation["messages"];
  conversationSummaries: ProjectConversationSummary[];
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
  currentSpec: unknown | null;
  historicalSpecs: unknown[];
  isExecutingSpec: boolean;
  isGeneratingSpec: boolean;
  isRevisingSpec: boolean;
  isSwitchingIterationMode: boolean;
  isVerifyingSpec: boolean;
  isLoadingConversations: boolean;
  loadCurrentSpec: ReturnType<typeof vi.fn>;
  projectError: string | null;
  showArchivedConversations: boolean;
  terminalLogs: string[];
};
