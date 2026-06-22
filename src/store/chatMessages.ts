export type ChatMessage = {
  activities?: ChatActivity[];
  activitiesCollapsed?: boolean;
  activitySummary?: string;
  animateContent?: boolean;
  id: string;
  isStreaming?: boolean;
  role: "assistant" | "user";
  content: string;
};

export type ChatActivityKind =
  | "command"
  | "database"
  | "file"
  | "preview"
  | "thinking"
  | "tool"
  | "verification";

export type ChatActivityStatus =
  | "failed"
  | "pending"
  | "running"
  | "succeeded";

export type ChatActivity = {
  command?: string;
  detail?: string;
  elapsedMs?: number;
  error?: string;
  finishedAt?: string;
  id: string;
  kind: ChatActivityKind;
  outputLineCount?: number;
  outputPreview?: string[];
  startedAt?: string;
  status: ChatActivityStatus;
  title: string;
};

export function createChatMessage(
  role: ChatMessage["role"],
  content: string,
  options: {
    activities?: ChatActivity[];
    activitiesCollapsed?: boolean;
    activitySummary?: string;
    animateContent?: boolean;
    isStreaming?: boolean;
  } = {},
): ChatMessage {
  return {
    activities: options.activities,
    activitiesCollapsed: options.activitiesCollapsed,
    activitySummary: options.activitySummary,
    animateContent: options.animateContent,
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
