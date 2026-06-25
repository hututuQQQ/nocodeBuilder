import { getContextFilePaths } from "../agent/projectModifier";
import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { AppState } from "./appStore";
import { appendLogs } from "./commandLogs";
import type { StoreAccess } from "./storeAccess";
import {
  isWorkspaceNavigationLocked,
  WORKSPACE_NAVIGATION_LOCK_MESSAGE,
} from "./workspaceNavigationLock";

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

      set((state) => ({
        terminalLogs: appendLogs(state.terminalLogs, [
          `[project] ${project.name} is ready. Start preview manually when needed.`,
        ]),
      }));
    },

    createProject: async (projectName, projectPrompt) => {
      if (isWorkspaceNavigationLocked(get())) {
        recordProjectNavigationBlocked(set);
        return null;
      }

      set({ isCreatingProject: true, projectError: null });

      try {
        const project = await projectApi.createProject(projectName);

        prepareProjectForInitialSpec({ project, set });

        const initialConversation = await get().createInitialSpec(
          project.id,
          projectPrompt,
          "Initial build",
        );

        if (!initialConversation) {
          let cleanupSucceeded = false;

          await projectApi.deleteUninitializedProject(project.id).then(
            () => {
              cleanupSucceeded = true;
            },
            (error) => {
            const cleanupMessage = getProjectErrorMessage(error);

            set((state) => ({
              projectError: state.projectError
                ? `${state.projectError}\nFailed to clean up ${project.name}: ${cleanupMessage}`
                : `Failed to clean up ${project.name}: ${cleanupMessage}`,
              terminalLogs: appendLogs(state.terminalLogs, [
                `[project:error] Failed to clean up ${project.name}: ${cleanupMessage}`,
              ]),
            }));
            },
          );

          if (cleanupSucceeded) {
            set((state) => ({
              chatMessages: [],
              conversationSummaries: [],
              currentAgentApproval: null,
              currentAgentRun: null,
              currentConversation: null,
              currentProject:
                state.currentProject?.id === project.id ? null : state.currentProject,
              currentSpec: null,
              currentVerificationReport: null,
              historicalSpecs: [],
              initialBuildSpec: null,
              projects: state.projects.filter((item) => item.id !== project.id),
            }));
          }

          return null;
        }

        await get().selectProject(project.id, {
          startDevServer: false,
        });

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
            agentEvents: [],
            agentRuns: [],
            chatMessages: [],
            changeHistory: [],
            conversationSummaries: [],
            currentAgentApproval: null,
            currentAgentRun: null,
            currentConversation: null,
            currentProject: null,
            initialBuildSpec: null,
            currentSpec: null,
            currentVerificationReport: null,
            devServerStatus: "stopped",
            fileTree: null,
            historicalSpecs: [],
            lastDeploymentUrl: null,
            previewUrl: null,
            selectedChangeFilePath: null,
            selectedFileContent: "",
            selectedFilePath: null,
            selectedSiteNodeId: null,
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
      const shouldStartDevServer = options.startDevServer ?? false;
      let didLoadFiles = false;

      if (!project) {
        return;
      }

      if (isWorkspaceNavigationLocked(get()) && previousProject?.id !== projectId) {
        recordProjectNavigationBlocked(set);
        return;
      }

      if (isWorkspaceNavigationLocked(get()) && previousProject?.id === projectId) {
        return;
      }

      if (previousProject && previousProject.id !== projectId) {
        await get().stopDevServer(previousProject.id);
      }

      set({
        chatMessages: [],
        changeHistory: [],
        agentEvents: [],
        agentRuns: [],
        conversationSummaries: [],
        currentAgentApproval: null,
        currentAgentRun: null,
        currentProject: project,
        initialBuildSpec: null,
        currentSpec: null,
        currentVerificationReport: null,
        currentConversation: null,
        devServerStatus: "stopped",
        fileTree: null,
        historicalSpecs: [],
        isLoadingFiles: true,
        isStartingDevServer: false,
        lastDeploymentUrl: null,
        projectError: null,
        previewUrl: null,
        selectedChangeFilePath: null,
        selectedSiteNodeId: null,
        selectedFileContent: "",
        selectedFilePath: null,
        showArchivedConversations: false,
      });

      try {
        await get().loadProjectConversations(project.id);

        const fileTree = await projectApi.listFiles(project.id);

        set({ fileTree });
        await get().loadProjectChangeHistory(project.id);
        await get().loadAgentRuns(project.id);
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

function prepareProjectForInitialSpec({
  project,
  set,
}: {
  project: NonNullable<AppState["currentProject"]>;
  set: StoreAccess["set"];
}) {
  set((state) => ({
    agentEvents: [],
    agentRuns: [],
    chatMessages: [],
    changeHistory: [],
    conversationSummaries: [],
    currentAgentApproval: null,
    currentAgentRun: null,
    currentConversation: null,
    currentProject: project,
    currentSpec: null,
    currentVerificationReport: null,
    devServerStatus: "stopped",
    fileTree: null,
    historicalSpecs: [],
    initialBuildSpec: null,
    lastDeploymentUrl: null,
    previewUrl: null,
    projectError: null,
    projects: [
      project,
      ...state.projects.filter((item) => item.id !== project.id),
    ],
    selectedChangeFilePath: null,
    selectedFileContent: "",
    selectedFilePath: null,
    selectedSiteNodeId: null,
    showArchivedConversations: false,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[project] Created ${project.name} at ${project.path}`,
    ]),
  }));
}

function recordProjectNavigationBlocked(set: StoreAccess["set"]) {
  set((state) => ({
    projectError: WORKSPACE_NAVIGATION_LOCK_MESSAGE,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[project:error] ${WORKSPACE_NAVIGATION_LOCK_MESSAGE}`,
    ]),
  }));
}
