import type {
  ProjectConversation,
  ProjectConversationSummary,
} from "../services/projects";
import { getProjectErrorMessage, projectApi } from "../services/projects";
import type { ChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";

const DEFAULT_CONVERSATION_TITLE = "New chat";
const saveQueues = new Map<string, Promise<void>>();

export function conversationToSummary(
  conversation: ProjectConversation,
): ProjectConversationSummary {
  return {
    archivedAt: conversation.archivedAt,
    createdAt: conversation.createdAt,
    id: conversation.id,
    lastMessageAt: conversation.lastMessageAt,
    messageCount: conversation.messages.length,
    projectId: conversation.projectId,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
  };
}

export function upsertConversationSummary(
  summaries: ProjectConversationSummary[],
  summary: ProjectConversationSummary,
) {
  return [
    summary,
    ...summaries.filter((conversation) => conversation.id !== summary.id),
  ].sort((left, right) =>
    right.lastMessageAt.localeCompare(left.lastMessageAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.title.localeCompare(right.title),
  );
}

export function appendConversationMessage(
  store: StoreAccess,
  message: ChatMessage,
) {
  return updateCurrentConversationMessages(store, (messages) => [
    ...messages,
    message,
  ]);
}

export function replaceConversationMessage(
  store: StoreAccess,
  messageId: string,
  content: string,
  isStreaming: boolean,
) {
  return updateCurrentConversationMessages(store, (messages) => {
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
      {
        id: messageId,
        content,
        isStreaming,
        role: "assistant",
      },
    ];
  });
}

export function updateCurrentConversationMessages(
  store: StoreAccess,
  updater: (messages: ChatMessage[]) => ChatMessage[],
) {
  let nextConversation: ProjectConversation | null = null;
  const now = new Date().toISOString();

  store.set((state) => {
    const currentConversation = state.currentConversation;

    if (!currentConversation) {
      return {};
    }

    const messages = updater(currentConversation.messages as ChatMessage[]);
    const nextTitle =
      currentConversation.title === DEFAULT_CONVERSATION_TITLE
        ? deriveTitleFromMessages(messages) ?? currentConversation.title
        : currentConversation.title;

    nextConversation = {
      ...currentConversation,
      lastMessageAt: messages.length > 0 ? now : currentConversation.lastMessageAt,
      messages,
      title: nextTitle,
      updatedAt: now,
    };

    return {
      chatMessages: messages,
      conversationSummaries: upsertConversationSummary(
        state.conversationSummaries,
        conversationToSummary(nextConversation),
      ),
      currentConversation: nextConversation,
    };
  });

  return nextConversation;
}

export async function persistConversation(
  store: StoreAccess,
  conversation: ProjectConversation | null,
) {
  if (!conversation) {
    return;
  }

  const queueKey = `${conversation.projectId}:${conversation.id}`;
  const previousSave = saveQueues.get(queueKey) ?? Promise.resolve();
  const queuedSave = previousSave
    .catch(() => undefined)
    .then(() => persistConversationNow(store, conversation));

  saveQueues.set(queueKey, queuedSave);
  queuedSave.finally(() => {
    if (saveQueues.get(queueKey) === queuedSave) {
      saveQueues.delete(queueKey);
    }
  });

  return queuedSave;
}

async function persistConversationNow(
  store: StoreAccess,
  conversation: ProjectConversation,
) {

  try {
    const savedConversation = await projectApi.saveProjectConversation(
      conversation.projectId,
      stripStreamingState(conversation),
    );

    store.set((state) => {
      const currentConversation = state.currentConversation;
      const isCurrent =
        currentConversation?.id === savedConversation.id &&
        currentConversation.projectId === savedConversation.projectId;
      const canApplySavedConversation =
        isCurrent && currentConversation.updatedAt === conversation.updatedAt;
      const summaryConversation =
        isCurrent && !canApplySavedConversation
          ? currentConversation
          : savedConversation;

      return {
        chatMessages: canApplySavedConversation
          ? (savedConversation.messages as ChatMessage[])
          : state.chatMessages,
        conversationSummaries: upsertConversationSummary(
          state.conversationSummaries,
          conversationToSummary(summaryConversation),
        ),
        currentConversation: canApplySavedConversation
          ? savedConversation
          : state.currentConversation,
      };
    });
  } catch (error) {
    const message = getProjectErrorMessage(error);

    store.set((state) => ({
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[conversation:error] ${message}`,
      ]),
    }));
  }
}

export function persistCurrentConversation(store: StoreAccess) {
  return persistConversation(store, store.get().currentConversation);
}

export function stripStreamingState(
  conversation: ProjectConversation,
): ProjectConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      content: message.content,
      id: message.id,
      role: message.role,
    })),
  };
}

function deriveTitleFromMessages(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");

  if (!firstUserMessage) {
    return null;
  }

  const title = firstUserMessage.content.replace(/\s+/g, " ").trim();

  if (!title) {
    return null;
  }

  return title.length > 48 ? `${title.slice(0, 45)}...` : title;
}
