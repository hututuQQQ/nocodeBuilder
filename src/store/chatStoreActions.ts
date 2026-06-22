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

      if (
        get().isModifyingProject ||
        get().isGeneratingProject
      ) {
        const conversation = appendConversationMessage(
          store,
          createChatMessage(
            "assistant",
            "I am still applying the previous change. Please wait for it to finish before sending another request.",
          ),
        );
        void persistConversation(store, conversation);

        return;
      }

      if (get().changeHistory.length > 0) {
        await get().acceptAllChanges();
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
