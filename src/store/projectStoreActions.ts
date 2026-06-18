import { getContextFilePaths } from "../agent/projectModifier";
import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import { generateInitialProject } from "./agentWorkflow";
import type { AppState } from "./appStore";
import { createChatMessage } from "./chatMessages";
import { appendLogs } from "./commandLogs";
import {
  appendConversationMessage,
  persistConversation,
} from "./conversationState";
import type { StoreAccess } from "./storeAccess";

type ProjectActions = Pick<
  AppState,
  | "bootstrapProject"
  | "createProject"
  | "loadProjects"
  | "openProjectFolder"
  | "readProjectFile"
  | "selectProject"
>;

export function createProjectActions({ get, set }: StoreAccess): ProjectActions {
  return {
    bootstrapProject: async (projectId) => {
      const project = get().projects.find((item) => item.id === projectId);

      if (!project) {
        return;
      }

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[project] Installing dependencies for ${project.name}`,
        ]),
      }));

      const installResult = await get().runProjectCommand(project.id, "npm install");

      if (!installResult?.success || get().currentProject?.id !== project.id) {
        return;
      }

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[project] Verifying production build for ${project.name}`,
        ]),
      }));

      const buildResult = await get().runProjectCommand(project.id, "npm run build");

      if (!buildResult?.success || get().currentProject?.id !== project.id) {
        return;
      }

      await get().startDevServer(project.id);
    },

    createProject: async (projectName, projectPrompt) => {
      set({ isCreatingProject: true, projectError: null });

      try {
        const project = await projectApi.createProject(projectName);

        set((state) => ({
          projects: [
            project,
            ...state.projects.filter((item) => item.id !== project.id),
          ],
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project] Created ${project.name} at ${project.path}`,
          ]),
        }));

        await get().selectProject(project.id, {
          conversationTitle: "Initial build",
          startDevServer: false,
        });

        const userMessage = createChatMessage("user", projectPrompt);
        const conversation = appendConversationMessage({ get, set }, userMessage);
        void persistConversation({ get, set }, conversation);

        const didGenerateProject = await generateInitialProject(
          { get, set },
          project,
          projectPrompt,
        );

        if (didGenerateProject) {
          void get().bootstrapProject(project.id);
        }

        return project;
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project:error] ${message}`,
          ]),
        }));

        return null;
      } finally {
        set({ isCreatingProject: false });
      }
    },

    loadProjects: async () => {
      set({ isLoadingProjects: true, projectError: null });

      try {
        const projects = await projectApi.listProjects();
        const currentProjectId = get().currentProject?.id;
        const nextCurrentProject =
          projects.find((project) => project.id === currentProjectId) ??
          projects[0] ??
          null;

        set({
          projects,
        });

        if (nextCurrentProject) {
          await get().selectProject(nextCurrentProject.id);
        } else {
          set({
            currentProject: null,
            chatMessages: [],
            conversationSummaries: [],
            currentConversation: null,
            devServerStatus: "stopped",
            fileTree: null,
            lastDeploymentUrl: null,
            previewUrl: null,
            selectedFileContent: "",
            selectedFilePath: null,
            showArchivedConversations: false,
          });
        }
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isLoadingProjects: false });
      }
    },

    openProjectFolder: async (projectId) => {
      try {
        await projectApi.openProjectFolder(projectId);
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project:error] ${message}`,
          ]),
        }));
      }
    },

    readProjectFile: async (path) => {
      const project = get().currentProject;

      if (!project || !path) {
        return;
      }

      set({ isReadingFile: true, projectError: null, selectedFilePath: path });

      try {
        const content = await projectApi.readFile(project.id, path);

        set({ selectedFileContent: content });
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          selectedFileContent: "",
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isReadingFile: false });
      }
    },

    selectProject: async (projectId, options = {}) => {
      const project = get().projects.find((item) => item.id === projectId);
      const previousProject = get().currentProject;
      const shouldStartDevServer = options.startDevServer ?? true;
      const shouldEnsureConversation = options.ensureConversation ?? true;
      let didLoadFiles = false;

      if (!project) {
        return;
      }

      if (previousProject && previousProject.id !== projectId) {
        await get().stopDevServer(previousProject.id);
      }

      set({
        chatMessages: [],
        conversationSummaries: [],
        currentProject: project,
        currentConversation: null,
        devServerStatus: "stopped",
        fileTree: null,
        isLoadingFiles: true,
        isStartingDevServer: false,
        lastDeploymentUrl: null,
        projectError: null,
        previewUrl: null,
        selectedFileContent: "",
        selectedFilePath: null,
        showArchivedConversations: false,
      });

      try {
        await get().loadProjectConversations(project.id, {
          ensureConversation: shouldEnsureConversation,
          initialTitle: options.conversationTitle,
        });

        const fileTree = await projectApi.listFiles(project.id);

        set({ fileTree });
        didLoadFiles = true;
      } catch (error) {
        const message = getProjectErrorMessage(error);

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[project:error] ${message}`,
          ]),
        }));
      } finally {
        set({ isLoadingFiles: false });
      }

      if (
        didLoadFiles &&
        shouldStartDevServer &&
        get().currentProject?.id === project.id
      ) {
        const currentFileTree = get().fileTree;
        const contextFilePaths = currentFileTree
          ? getContextFilePaths(currentFileTree)
          : [];

        if (contextFilePaths.length > 0) {
          void get().startDevServer(project.id);
        }
      }
    },
  };
}
