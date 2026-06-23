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
    projectError: null,
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

type StoreState = {
  changeHistory: unknown[];
  chatMessages: unknown[];
  createConversation: () => Promise<null>;
  currentAgentRun: null;
  currentConversation: null;
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
  projectError: string | null;
  terminalLogs: string[];
};
