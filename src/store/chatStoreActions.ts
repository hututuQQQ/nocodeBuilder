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
