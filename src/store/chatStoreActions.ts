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
    sendMessage: (content) => {
      const message = content.trim();

      if (!message) {
        return Promise.resolve();
      }

      if (!get().currentProject) {
        return Promise.resolve();
      }

      if (get().currentConversation?.archivedAt) {
        return Promise.resolve();
      }

      if (!get().currentConversation) {
        return get().createConversation().then((conversation) => {
          if (!conversation) {
            return;
          }

          return get().sendMessage(message);
        });
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

        return Promise.resolve();
      }

      const userMessage = createChatMessage("user", message);
      const conversation = appendConversationMessage(store, userMessage);
      void persistConversation(store, conversation);

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [`[chat] ${message}`]),
      }));

      return modifyCurrentProject(store, message);
    },
  };
}
