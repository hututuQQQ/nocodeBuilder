export type ChatMessage = {
  id: string;
  isStreaming?: boolean;
  role: "assistant" | "user";
  content: string;
};

export function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  options: { isStreaming?: boolean } = {},
): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    isStreaming: options.isStreaming,
    role,
    content,
  };
}

export function replaceChatMessage(
  messages: ChatMessage[],
  messageId: string,
  content: string,
  isStreaming: boolean,
) {
  let didReplace = false;
  const nextMessages = messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    didReplace = true;
    return {
      ...message,
      content,
      isStreaming,
    };
  });

  if (didReplace) {
    return nextMessages;
  }

  return [
    ...messages,
    createChatMessage("assistant", content, {
      isStreaming,
    }),
  ];
}
