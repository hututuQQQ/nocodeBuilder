import { modifyCurrentProject } from "./agentWorkflow";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  persistConversation,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";

type ChatActions = Pick<AppState, "sendMessage">;

export function createChatActions({ get, set }: StoreAccess): ChatActions {
  const store = { get, set };

  return {
    sendMessage: async (content) => {
      const message = content.trim();

      if (!message) {
        return;
      }

      if (!get().currentProject) {
        return;
      }

      if (get().currentConversation?.archivedAt) {
        return;
      }

      if (!get().currentConversation) {
        const conversation = await get().createConversation();

        if (!conversation) {
          return;
        }

        return get().sendMessage(message);
      }

      const activeRun = get().currentAgentRun;

      if (activeRun && !isTerminalRun(activeRun)) {
        const userMessage = createChatMessage("user", message);
        const conversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, conversation);
        await get().sendAgentSteering(message);

        set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [
            `[chat] Added message as steering for run ${activeRun.id}.`,
          ]),
        }));

        return;
      }

      if (
        get().isModifyingProject ||
        get().isGeneratingProject
      ) {
        const userMessage = createChatMessage("user", message);
        const conversation = appendConversationMessage(store, userMessage);
        void persistConversation(store, conversation);
        await get().sendAgentSteering(message);

        return;
      }

      if (get().changeHistory.length > 0) {
        set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [
            "[chat] Continuing from the current draft; pending changes were not auto-accepted.",
          ]),
        }));
      }

      const userMessage = createChatMessage("user", message);
      const conversation = appendConversationMessage(store, userMessage);
      void persistConversation(store, conversation);

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [`[chat] ${message}`]),
      }));

      await modifyCurrentProject(store, message);
    },
  };
}

function isTerminalRun(run: AppState["currentAgentRun"]) {
  return (
    !run ||
    ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)
  );
}
