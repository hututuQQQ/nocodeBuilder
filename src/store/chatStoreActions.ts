import { modifyCurrentProject } from "./agentWorkflow";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

type ChatActions = Pick<AppState, "sendMessage">;

export function createChatActions({ get, set }: StoreAccess): ChatActions {
  return {
    sendMessage: (content) => {
      const message = content.trim();

      if (!message) {
        return Promise.resolve();
      }

      if (
        get().isModifyingProject ||
        get().isGeneratingProject ||
        get().isRollingBack
      ) {
        set((state) => ({
          chatMessages: [
            ...state.chatMessages,
            createChatMessage(
              "assistant",
              "I am still applying the previous change. Please wait for it to finish before sending another request.",
            ),
          ],
        }));

        return Promise.resolve();
      }

      const userMessage = createChatMessage("user", message);

      set((state) => ({
        chatMessages: [...state.chatMessages, userMessage],
        terminalLogs: appendLogs(state.terminalLogs, [`[chat] ${message}`]),
      }));

      return modifyCurrentProject({ get, set }, message);
    },
  };
}
