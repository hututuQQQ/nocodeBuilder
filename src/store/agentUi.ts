import {
  createChatMessage,
  type ChatActivity,
  type ChatActivityKind,
  type ChatActivityStatus,
} from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  replaceConversationMessage,
  updateConversationMessage,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";

const MAX_ACTIVITY_OUTPUT_PREVIEW_LINES = 6;
const MAX_STREAMING_MODEL_CONTENT_CHARS = 20_000;

export type AgentStreamController = {
  addActivity: (activity: AgentActivityInput) => string;
  completeWithTypewriter: (content: string) => void;
  failWithTypewriter: (content: string) => void;
  messageId: string;
  onDelta: (delta: string) => void;
  onModelDelta: (delta: string) => void;
  setStatus: (status: string) => void;
  updateActivity: (activityId: string, patch: AgentActivityPatch) => void;
};

export type AgentActivityInput = {
  command?: string;
  detail?: string;
  error?: string;
  kind: ChatActivityKind;
  outputLineCount?: number;
  outputPreview?: string[];
  status?: ChatActivityStatus;
  title: string;
};

export type AgentActivityPatch = Partial<
  Omit<ChatActivity, "elapsedMs" | "finishedAt" | "id" | "startedAt">
> & {
  finishActivity?: boolean;
  finishedAt?: string;
};

export function startStreamingAgentMessage(
  store: StoreAccess,
  title: string,
): AgentStreamController {
  const thinkingActivityId = createActivityId("thinking");
  const message = createChatMessage("assistant", "", {
    activities: [
      {
        detail: "Waiting for model stream.",
        id: thinkingActivityId,
        kind: "thinking",
        startedAt: new Date().toISOString(),
        status: "running",
        title,
      },
    ],
    isStreaming: true,
  });
  let receivedChars = 0;
  let lastUpdateAt = 0;
  let streamedContent = "";

  appendConversationMessage(store, message);

  function update(status: string) {
    updateActivity(thinkingActivityId, {
      detail: formatStreamingStatus(status, receivedChars),
      status: "running",
    });
  }

  function addActivity(activity: AgentActivityInput) {
    const id = createActivityId(activity.kind);
    const nextActivity: ChatActivity = {
      ...activity,
      id,
      outputPreview: trimOutputPreview(activity.outputPreview),
      startedAt: new Date().toISOString(),
      status: activity.status ?? "running",
    };

    updateConversationMessage(store, message.id, (currentMessage) => ({
      ...currentMessage,
      activities: [...(currentMessage.activities ?? []), nextActivity],
    }));

    return id;
  }

  function updateActivity(activityId: string, patch: AgentActivityPatch) {
    updateConversationMessage(store, message.id, (currentMessage) => ({
      ...currentMessage,
      activities: (currentMessage.activities ?? []).map((activity) => {
        if (activity.id !== activityId) {
          return activity;
        }

        const finishedAt =
          patch.finishedAt ??
          (patch.finishActivity ? new Date().toISOString() : activity.finishedAt);
        const elapsedMs =
          finishedAt && activity.startedAt
            ? Math.max(
                0,
                new Date(finishedAt).getTime() -
                  new Date(activity.startedAt).getTime(),
              )
            : activity.elapsedMs;
        const { finishActivity, outputPreview, ...restPatch } = patch;
        void finishActivity;

        return {
          ...activity,
          ...restPatch,
          elapsedMs,
          finishedAt,
          outputPreview: outputPreview
            ? trimOutputPreview(outputPreview)
            : activity.outputPreview,
        };
      }),
    }));
  }

  function appendModelDelta(delta: string) {
    if (!delta) {
      return;
    }

    receivedChars += delta.length;
    streamedContent += delta;
    const now = Date.now();

    if (now - lastUpdateAt <= 120) {
      return;
    }

    lastUpdateAt = now;
    updateConversationMessage(store, message.id, (currentMessage) => ({
      ...currentMessage,
      content: formatStreamingModelContent(streamedContent),
      isStreaming: true,
    }));
    update("Model is planning the next step.");
  }

  function flushModelContent() {
    if (!streamedContent) {
      return;
    }

    updateConversationMessage(store, message.id, (currentMessage) => ({
      ...currentMessage,
      content: formatStreamingModelContent(streamedContent),
      isStreaming: true,
    }));
  }

  function finish(status: ChatActivityStatus, content: string) {
    flushModelContent();

    const finalContent =
      content.trim() ||
      formatStreamingModelContent(streamedContent).trim() ||
      "The agent finished, but the model did not return a visible message.";

    updateActivity(thinkingActivityId, {
      detail: status === "failed" ? "Workflow failed." : "Workflow complete.",
      finishActivity: true,
      status,
    });
    const activities = store
      .get()
      .chatMessages.find((chatMessage) => chatMessage.id === message.id)
      ?.activities;
    replaceConversationMessage(store, message.id, finalContent, false, {
      activities,
      activitiesCollapsed: true,
      activitySummary: summarizeActivities(activities ?? []),
      animateContent: true,
    });
  }

  return {
    addActivity,
    completeWithTypewriter: (content) => finish("succeeded", content),
    failWithTypewriter: (content) => finish("failed", content),
    messageId: message.id,
    onDelta: appendModelDelta,
    onModelDelta: appendModelDelta,
    setStatus: (status) => update(status),
    updateActivity,
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

function formatStreamingStatus(status: string, receivedChars: number) {
  if (receivedChars <= 0) {
    return status;
  }

  return `${status}\nReceived ${receivedChars.toLocaleString()} internal characters.`;
}

function formatStreamingModelContent(content: string) {
  if (content.length <= MAX_STREAMING_MODEL_CONTENT_CHARS) {
    return content;
  }

  return [
    "[Model stream truncated. Showing latest output.]",
    content.slice(-MAX_STREAMING_MODEL_CONTENT_CHARS),
  ].join("\n");
}

function createActivityId(kind: ChatActivityKind) {
  return `activity-${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function trimOutputPreview(outputPreview?: string[]) {
  return outputPreview?.slice(-MAX_ACTIVITY_OUTPUT_PREVIEW_LINES);
}

function summarizeActivities(activities: ChatActivity[]) {
  const visibleActivities = activities.filter(
    (activity) => activity.kind !== "thinking",
  );
  const changedFileActivities = visibleActivities.filter(
    (activity) => activity.kind === "file",
  );
  const failedActivities = visibleActivities.filter(
    (activity) => activity.status === "failed",
  );
  const verificationPassed = visibleActivities.some(
    (activity) =>
      activity.kind === "verification" && activity.status === "succeeded",
  );
  const parts = [`${visibleActivities.length} step(s)`];

  if (changedFileActivities.length > 0) {
    parts.push(`${changedFileActivities.length} file step(s)`);
  }

  if (verificationPassed) {
    parts.push("build passed");
  }

  if (failedActivities.length > 0) {
    parts.push(`${failedActivities.length} failed`);
  }

  return parts.join(", ");
}
