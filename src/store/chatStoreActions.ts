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
        set((state) => ({
          projectError: "Create a new iteration before sending chat messages.",
          terminalLogs: appendLogs(state.terminalLogs, [
            "[chat] No active iteration is available for this message.",
          ]),
        }));
        return;
      }

      if (get().currentConversation?.mode === "spec") {
        if (get().isRevisingSpec) {
          set((state) => ({
            projectError: "Wait for the Spec revision to finish before sending messages.",
            terminalLogs: appendLogs(state.terminalLogs, [
              "[spec] Message blocked while revision is in progress.",
            ]),
          }));
          return;
        }

        if (isSpecMessageBlockedByWorkflow(get())) {
          set((state) => ({
            projectError:
              "Wait for the active Spec operation to finish before sending messages.",
            terminalLogs: appendLogs(state.terminalLogs, [
              "[spec] Message blocked while a Spec operation is in progress.",
            ]),
          }));
          return;
        }

        await handleSpecConversationMessage(store, message);
        return;
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

async function handleSpecConversationMessage(
  store: StoreAccess,
  message: string,
) {
  const { get, set } = store;
  const userMessage = createChatMessage("user", message);
  const conversation = appendConversationMessage(store, userMessage);
  void persistConversation(store, conversation);

  const spec = get().currentSpec;
  const activeRun = get().currentAgentRun;

  if (
    spec &&
    ["approved", "building"].includes(spec.status) &&
    activeRun &&
    !isTerminalRun(activeRun)
  ) {
    if (!isCurrentSpecTaskRun(get(), activeRun)) {
      const assistantMessage = createChatMessage(
        "assistant",
        "The active AgentRun is not attached to the current Spec task, so this message was not applied as steering. Wait for the Spec state to reconcile or use the Spec controls.",
      );
      const nextConversation = appendConversationMessage(store, assistantMessage);
      void persistConversation(store, nextConversation);
      set((state) => ({
        projectError: "AgentRun does not belong to the current Spec task.",
        terminalLogs: appendLogs(state.terminalLogs, [
          "[spec] Steering blocked because the active AgentRun does not belong to the current Spec task.",
        ]),
      }));
      return;
    }

    await get().sendAgentSteering(message);
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[spec] Added message as steering for run ${activeRun.id}.`,
      ]),
    }));
    return;
  }

  const guidance = spec
    ? guidanceForSpecStatus(spec.status)
    : "Spec mode is active. Use the Spec review controls to continue.";
  const assistantMessage = createChatMessage("assistant", guidance);
  const nextConversation = appendConversationMessage(store, assistantMessage);
  void persistConversation(store, nextConversation);
}

function guidanceForSpecStatus(status: string) {
  switch (status) {
    case "review":
      return "Use Request revision to change this Spec, or Approve and start build when it is ready.";
    case "revising":
    case "drafting":
      return "Spec generation is already in progress.";
    case "approved":
    case "building":
      return "This Spec is executing. Messages are accepted only as task steering.";
    case "verifying":
      return "Final verification is running. Wait for the result before changing modes.";
    case "blocked":
      return "This Spec is blocked. Retry the failed task from the Spec summary, or request a revision if the plan needs to change.";
    case "completed":
      return "This Spec is complete. Switch to Chat or create a new iteration for follow-up work.";
    case "failed":
    case "cancelled":
      return "This Spec cannot be resumed with a normal message. Switch to Chat or retry a failed task when available.";
    default:
      return "Spec mode is active. Use the Spec controls to continue.";
  }
}

function isTerminalRun(run: AppState["currentAgentRun"]) {
  return (
    !run ||
    ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status)
  );
}

function isSpecMessageBlockedByWorkflow(state: AppState) {
  return Boolean(
    state.isGeneratingSpec ||
      state.isVerifyingSpec ||
      state.isSwitchingIterationMode,
  );
}

function isCurrentSpecTaskRun(state: AppState, run: AppState["currentAgentRun"]) {
  const conversation = state.currentConversation;
  const spec = state.currentSpec;
  const source = run?.contract.source;

  if (!run || !conversation || !spec || source?.mode !== "spec") {
    return false;
  }

  const revision = spec.revisions.find(
    (item) => item.id === spec.currentRevisionId,
  );
  const runningTask = revision?.tasks.find((task) => task.status === "running");

  return (
    conversation.mode === "spec" &&
    conversation.activeSpecId === spec.id &&
    run.conversationId === conversation.id &&
    source.specId === spec.id &&
    source.revisionId === revision?.id &&
    Boolean(runningTask) &&
    runningTask?.runId === run.id &&
    source.taskId === runningTask?.id
  );
}
