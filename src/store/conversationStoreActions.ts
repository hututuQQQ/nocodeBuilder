import {
  type CreateProjectConversationInput,
  getProjectErrorMessage,
  projectApi,
  type ProjectConversation,
  type ProjectConversationSummary,
} from "../services/projects";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import {
  conversationToSummary,
  upsertConversationSummary,
} from "./conversationState";
import {
  ensureInitialBuildCompletedForIteration,
  hasCompletedInitialBuildSpecForSummary,
  INITIAL_BUILD_ITERATION_GATE_ERROR,
  readInitialBuildSpecForGate,
} from "./initialBuildGate";
import type { StoreAccess } from "./storeAccess";

type ConversationActions = Pick<
  AppState,
  | "archiveConversation"
  | "archiveCurrentConversation"
  | "createConversation"
  | "loadProjectConversations"
  | "selectConversation"
  | "setShowArchivedConversations"
  | "unarchiveConversation"
>;

export function createConversationActions({
  get,
  set,
}: StoreAccess): ConversationActions {
  return {
    loadProjectConversations: async (projectId) => {
      set({ isLoadingConversations: true, projectError: null });

      try {
        const summaries = await projectApi.listProjectConversations(
          projectId,
          true,
        );
        const currentConversation = get().currentConversation;
        const activeSummaries = summaries.filter(
          (summary) => !summary.archivedAt,
        );
        const initialBuildSummary =
          summaries.find((summary) => summary.kind === "initial_build") ?? null;
        const initialBuildSpec = await readInitialBuildSpecForGate(
          projectId,
          initialBuildSummary,
        );
        const initialBuildCompleted = hasCompletedInitialBuildSpecForSummary(
          projectId,
          initialBuildSummary,
          initialBuildSpec,
        );
        const currentSummary = currentConversation
          ? summaries.find((summary) => summary.id === currentConversation.id) ??
            null
          : null;
        const canKeepCurrent =
          currentConversation?.projectId === projectId &&
          Boolean(currentSummary) &&
          (currentConversation.kind !== "iteration" || initialBuildCompleted) &&
          (currentSummary?.kind !== "iteration" || initialBuildCompleted);

        set({
          conversationSummaries: summaries,
          initialBuildSpec,
        });

        if (canKeepCurrent) {
          return;
        }

        const summaryToOpen = initialBuildCompleted
          ? activeSummaries[0] ?? null
          : activeSummaries.find(
              (summary) => summary.kind === "initial_build",
            ) ?? null;

        if (summaryToOpen) {
          await get().selectConversation(summaryToOpen.id);
          return;
        }

        set({
          chatMessages: [],
          currentConversation: null,
          currentSpec: null,
          historicalSpecs: initialBuildSpec ? [initialBuildSpec] : [],
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[conversation:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isLoadingConversations: false });
      }
    },

    createConversation: async (projectId, input) => {
      const targetProjectId = projectId ?? get().currentProject?.id;

      if (!targetProjectId) {
        return null;
      }

      const conversationInput: CreateProjectConversationInput =
        typeof input === "object" && input
          ? input
          : {
              kind: "iteration",
              mode: "chat",
              title: input,
            };

      if (isSpecWorkflowBusy(get())) {
        const message =
          "Wait for the current Spec operation to finish before creating a new iteration.";

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            "[conversation] New iteration blocked while Spec operation is in progress.",
          ]),
        }));

        return null;
      }

      if (conversationInput.kind === "iteration") {
        try {
          await ensureInitialBuildCompletedForIteration(
            targetProjectId,
            get(),
          );
        } catch {
          set((state) => ({
            projectError: INITIAL_BUILD_ITERATION_GATE_ERROR,
            terminalLogs: appendLogs(state.terminalLogs, [
              "[conversation] New iteration blocked until Initial Spec completes.",
            ]),
          }));

          return null;
        }
      }

      set({ isCreatingConversation: true, projectError: null });

      try {
        const conversation = await projectApi.createProjectConversation(
          targetProjectId,
          conversationInput,
        );

        set((state) => ({
          agentEvents: [],
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentAgentApproval: null,
          currentAgentRun: null,
          currentConversation: conversation,
          currentVerificationReport: null,
          initialBuildSpec: state.initialBuildSpec,
          currentSpec: null,
          historicalSpecs: [],
          showArchivedConversations: false,
        }));

        await get().loadCurrentSpec();
        await get().loadAgentRuns(targetProjectId);

        return conversation;
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[conversation:error] ${message}`,
          ]),
        }));

        return null;
      } finally {
        set({ isCreatingConversation: false });
      }
    },

    selectConversation: async (conversationId) => {
      const project = get().currentProject;

      if (!project) {
        return;
      }

      set({ isLoadingConversations: true, projectError: null });

      try {
        const conversation = await projectApi.readProjectConversation(
          project.id,
          conversationId,
        );

        if (conversation.kind === "iteration") {
          await ensureInitialBuildCompletedForIteration(project.id, get());
        }

        set((state) => ({
          agentEvents: [],
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentAgentApproval: null,
          currentAgentRun: null,
          currentConversation: conversation,
          currentVerificationReport: null,
        }));
        await get().loadCurrentSpec();
        await get().loadAgentRuns(project.id);
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[conversation:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isLoadingConversations: false });
      }
    },

    archiveConversation: async (conversationId) => {
      const project = get().currentProject;
      const currentConversation = get().currentConversation;
      const isCurrentConversation = currentConversation?.id === conversationId;

      if (!project) {
        return;
      }

      set({ projectError: null });

      try {
        const archivedConversation = await projectApi.archiveProjectConversation(
          project.id,
          conversationId,
        );
        const nextSummaries = upsertConversationSummary(
          get().conversationSummaries,
          conversationToSummary(archivedConversation),
        );
        const nextActiveConversation = nextSummaries.find(
          (summary) =>
            summary.id !== archivedConversation.id && !summary.archivedAt,
        );

        if (!isCurrentConversation) {
          set({
            conversationSummaries: nextSummaries,
          });
          return;
        }

        set({
          chatMessages: [],
          conversationSummaries: nextSummaries,
          currentConversation: null,
          currentSpec: null,
          historicalSpecs: [],
          showArchivedConversations: false,
        });

        if (nextActiveConversation) {
          await get().selectConversation(nextActiveConversation.id);
        }
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[conversation:error] ${message}`,
          ]),
        }));
      }
    },

    archiveCurrentConversation: async () => {
      const conversation = get().currentConversation;

      if (!conversation || conversation.archivedAt) {
        return;
      }

      await get().archiveConversation(conversation.id);
    },

    unarchiveConversation: async (conversationId) => {
      const project = get().currentProject;

      if (!project) {
        return;
      }

      set({ projectError: null });

      try {
        const conversation = await projectApi.unarchiveProjectConversation(
          project.id,
          conversationId,
        );

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
          showArchivedConversations: false,
        }));
        await get().loadCurrentSpec();
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[conversation:error] ${message}`,
          ]),
        }));
      }
    },

    setShowArchivedConversations: async (showArchived) => {
      const project = get().currentProject;

      set({ showArchivedConversations: showArchived });

      if (!project) {
        set({ conversationSummaries: [], initialBuildSpec: null });
        return;
      }

      await get().loadProjectConversations(project.id);
    },
  };
}

export function selectConversationList(
  summaries: ProjectConversationSummary[],
  showArchived: boolean,
) {
  return summaries.filter((summary) =>
    showArchived ? Boolean(summary.archivedAt) : !summary.archivedAt,
  );
}

function isSpecWorkflowBusy(state: AppState) {
  return Boolean(
    state.isGeneratingSpec ||
      state.isRevisingSpec ||
      state.isExecutingSpec ||
      state.isVerifyingSpec ||
      state.isSwitchingIterationMode,
  );
}

export type { ProjectConversation };
