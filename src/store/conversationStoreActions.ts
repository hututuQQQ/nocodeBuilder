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

type LoadConversationOptions = {
  ensureConversation?: boolean;
  initialTitle?: string;
};

export function createConversationActions({
  get,
  set,
}: StoreAccess): ConversationActions {
  return {
    loadProjectConversations: async (projectId, options = {}) => {
      set({ isLoadingConversations: true, projectError: null });

      try {
        const includeArchived = get().showArchivedConversations;
        const summaries = await projectApi.listProjectConversations(
          projectId,
          includeArchived,
        );
        const currentConversation = get().currentConversation;
        const canKeepCurrent =
          currentConversation?.projectId === projectId &&
          summaries.some((summary) => summary.id === currentConversation.id);
        const activeSummaries = summaries.filter(
          (summary) => !summary.archivedAt,
        );

        set({
          conversationSummaries: summaries,
        });

        if (canKeepCurrent) {
          return;
        }

        const summaryToOpen = activeSummaries[0] ?? null;

        if (summaryToOpen) {
          await get().selectConversation(summaryToOpen.id);
          return;
        }

        if (options.ensureConversation) {
          await get().createConversation(projectId, options.initialTitle);
          return;
        }

        set({
          chatMessages: [],
          currentConversation: null,
          currentSpec: null,
          historicalSpecs: [],
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

      set({ isCreatingConversation: true, projectError: null });

      try {
        const conversationInput: CreateProjectConversationInput =
          typeof input === "object" && input
            ? input
            : {
                kind: "iteration",
                mode: "chat",
                title: input,
              };
        const conversation = await projectApi.createProjectConversation(
          targetProjectId,
          conversationInput,
        );

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries.filter(
              (summary) => !summary.archivedAt,
            ),
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
          currentSpec: null,
          historicalSpecs: [],
          showArchivedConversations: false,
        }));

        await get().loadCurrentSpec();

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

        set((state) => ({
          chatMessages: conversation.messages,
          conversationSummaries: upsertConversationSummary(
            state.conversationSummaries,
            conversationToSummary(conversation),
          ),
          currentConversation: conversation,
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
            conversationSummaries: get().showArchivedConversations
              ? nextSummaries
              : nextSummaries.filter((summary) => !summary.archivedAt),
          });
          return;
        }

        set({
          chatMessages: [],
          conversationSummaries: nextSummaries.filter(
            (summary) => !summary.archivedAt,
          ),
          currentConversation: null,
          currentSpec: null,
          historicalSpecs: [],
          showArchivedConversations: false,
        });

        if (nextActiveConversation) {
          await get().selectConversation(nextActiveConversation.id);
        } else {
          await get().createConversation(project.id);
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
        set({ conversationSummaries: [] });
        return;
      }

      await get().loadProjectConversations(project.id, {
        ensureConversation: !showArchived,
      });
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

export type { LoadConversationOptions, ProjectConversation };
