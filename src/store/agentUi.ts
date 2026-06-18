import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  replaceConversationMessage,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";

export type AgentStreamController = {
  messageId: string;
  onDelta: (delta: string) => void;
  setStatus: (status: string) => void;
};

export function startStreamingAgentMessage(
  store: StoreAccess,
  title: string,
): AgentStreamController {
  const message = createChatMessage("assistant", `${title}\n\nWaiting for model stream...`, {
    isStreaming: true,
  });
  let receivedChars = 0;
  let lastUpdateAt = 0;

  appendConversationMessage(store, message);

  function update(status: string) {
    replaceConversationMessage(
      store,
      message.id,
      `${title}\n\n${status}\n\nReceived ${receivedChars.toLocaleString()} characters.`,
      true,
    );
  }

  return {
    messageId: message.id,
    onDelta: (delta) => {
      receivedChars += delta.length;
      const now = Date.now();

      if (now - lastUpdateAt > 180) {
        lastUpdateAt = now;
        update("Streaming model output...");
      }
    },
    setStatus: (status) => update(status),
  };
}

export function updateAgentStatus(
  stream: AgentStreamController,
  statusLines: string[],
  nextLine: string,
) {
  statusLines.push(nextLine);
  stream.setStatus(statusLines.slice(-10).join("\n"));
}

export function appendAssistantMessage(store: StoreAccess, content: string) {
  appendConversationMessage(store, createChatMessage("assistant", content));
}

export function appendTerminalLog(store: StoreAccess, content: string) {
  store.set((state) => ({
    terminalLogs: appendLogs(state.terminalLogs, [content]),
  }));
}
