import { describe, expect, it, vi } from "vitest";
import { createChatActions } from "./chatStoreActions";

vi.mock("./agentWorkflow", () => ({
  modifyCurrentProject: vi.fn(),
}));

describe("chat store actions", () => {
  it("does not auto-create a Chat conversation when none is active", async () => {
    let createConversationCalls = 0;
    const store = createStore({
      createConversation: async () => {
        createConversationCalls += 1;
        return null;
      },
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Please edit the hero");

    expect(createConversationCalls).toBe(0);
    expect(store.get().projectError).toBe(
      "Create a new iteration before sending chat messages.",
    );
    expect(store.get().chatMessages).toEqual([]);
  });

  it("blocks Spec messages while a revision is in progress", async () => {
    const conversation = createConversation({
      activeSpecId: "spec-1",
      mode: "spec",
      specIds: ["spec-1"],
    });
    const store = createStore({
      currentConversation: conversation,
      isRevisingSpec: true,
    });
    const actions = createChatActions(store as never);

    await actions.sendMessage("Please change the requirements");

    expect(store.get().chatMessages).toEqual([]);
    expect(store.get().currentConversation?.messages).toEqual([]);
    expect(store.get().projectError).toBe(
      "Wait for the Spec revision to finish before sending messages.",
    );
  });
});

function createStore(patch: Partial<StoreState> = {}) {
  let state: StoreState = {
    changeHistory: [],
    chatMessages: [],
    createConversation: async () => null,
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
    isGeneratingProject: false,
    isModifyingProject: false,
    isRevisingSpec: false,
    projectError: null,
    sendAgentSteering: vi.fn(async () => undefined),
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

function createConversation(patch: Partial<StoreState["currentConversation"]> = {}) {
  return {
    activeSpecId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "conversation-1",
    kind: "iteration",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    mode: "chat",
    modeChangedAt: "2026-01-01T00:00:00.000Z",
    projectId: "project-1",
    specIds: [],
    title: "Iteration",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as StoreState["currentConversation"];
}

type StoreState = {
  changeHistory: unknown[];
  chatMessages: unknown[];
  createConversation: () => Promise<null>;
  currentAgentRun: null;
  currentConversation: {
    activeSpecId: string | null;
    archivedAt: string | null;
    createdAt: string;
    id: string;
    kind: "initial_build" | "iteration";
    lastMessageAt: string;
    messages: unknown[];
    mode: "chat" | "spec";
    modeChangedAt: string;
    projectId: string;
    specIds: string[];
    title: string;
    updatedAt: string;
  } | null;
  currentProject: {
    createdAt: string;
    framework: "next-app-router";
    id: string;
    lastOpenedAt: string;
    name: string;
    path: string;
    updatedAt: string;
  } | null;
  isGeneratingProject: boolean;
  isModifyingProject: boolean;
  isRevisingSpec: boolean;
  projectError: string | null;
  sendAgentSteering: ReturnType<typeof vi.fn>;
  terminalLogs: string[];
};
