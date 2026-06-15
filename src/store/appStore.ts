import { create } from "zustand";
import {
  buildModificationContext,
  getContextFilePaths,
  requestProjectGeneration,
  requestProjectModification,
} from "../agent/projectModifier";
import { keyStore } from "../services/keyStore";
import {
  CommandOutputEvent,
  CommandResult,
  CommandStatusEvent,
  FileTree,
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
  VercelDeploymentInfo,
  VercelDeployOptions,
} from "../services/projects";

export type ChatMessage = {
  id: string;
  isStreaming?: boolean;
  role: "assistant" | "user";
  content: string;
};

export type FileChangeSummary = {
  action: "created" | "modified";
  additions: number;
  afterContent: string;
  beforeContent: string | null;
  deletions: number;
  path: string;
  sampleAddedLines: string[];
  sampleRemovedLines: string[];
};

export type ChangeRecord = {
  id: string;
  createdAt: string;
  files: FileChangeSummary[];
  projectId: string;
  summary: string;
};

type DevServerStatus = "stopped" | "starting" | "running" | "failed";

type AgentStreamController = {
  messageId: string;
  onDelta: (delta: string) => void;
  setStatus: (status: string) => void;
};

type AppState = {
  activeCommand: string | null;
  currentProject: ProjectInfo | null;
  devServerStatus: DevServerStatus;
  projects: ProjectInfo[];
  fileTree: FileTree | null;
  selectedFilePath: string | null;
  selectedFileContent: string;
  chatMessages: ChatMessage[];
  changeHistory: ChangeRecord[];
  terminalLogs: string[];
  previewRefreshKey: number;
  previewUrl: string | null;
  lastDeploymentUrl: string | null;
  isInstallingDependencies: boolean;
  isLoadingProjects: boolean;
  isCreatingProject: boolean;
  isGeneratingProject: boolean;
  isLoadingFiles: boolean;
  isReadingFile: boolean;
  isRollingBack: boolean;
  isRunningCommand: boolean;
  isStartingDevServer: boolean;
  isDeploying: boolean;
  isModifyingProject: boolean;
  projectError: string | null;
  bootstrapProject: (projectId: string) => Promise<void>;
  createProject: (
    projectName: string,
    projectPrompt: string,
  ) => Promise<ProjectInfo | null>;
  deployCurrentProject: (
    options: VercelDeployOptions,
  ) => Promise<VercelDeploymentInfo | null>;
  handleCommandOutput: (event: CommandOutputEvent) => void;
  handleCommandStatus: (event: CommandStatusEvent) => void;
  loadProjects: () => Promise<void>;
  openProjectFolder: (projectId: string) => Promise<void>;
  openPreviewInBrowser: (url?: string) => Promise<void>;
  readProjectFile: (path: string) => Promise<void>;
  refreshPreview: () => void;
  rollbackLastChange: () => Promise<void>;
  runProjectCommand: (
    projectId: string,
    command: string,
  ) => Promise<CommandResult | null>;
  selectProject: (
    projectId: string,
    options?: { startDevServer?: boolean },
  ) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  startDevServer: (projectId: string) => Promise<void>;
  stopDevServer: (projectId: string) => Promise<void>;
};

const MAX_TERMINAL_LOGS = 1000;

export const useAppStore = create<AppState>((set, get) => ({
  activeCommand: null,
  currentProject: null,
  devServerStatus: "stopped",
  projects: [],
  fileTree: null,
  selectedFilePath: null,
  selectedFileContent: "",
  chatMessages: [
    {
      id: "welcome",
      role: "assistant",
      content:
        "Ready. Create a project with a website brief, then I will generate a Next.js App Router app.",
    },
  ],
  changeHistory: [],
  terminalLogs: [],
  previewRefreshKey: 0,
  previewUrl: null,
  lastDeploymentUrl: null,
  isInstallingDependencies: false,
  isLoadingProjects: false,
  isCreatingProject: false,
  isGeneratingProject: false,
  isLoadingFiles: false,
  isReadingFile: false,
  isRollingBack: false,
  isRunningCommand: false,
  isStartingDevServer: false,
  isDeploying: false,
  isModifyingProject: false,
  projectError: null,
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

    if (!installResult?.success) {
      return;
    }

    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        `[project] Verifying production build for ${project.name}`,
      ]),
    }));

    const buildResult = await get().runProjectCommand(project.id, "npm run build");

    if (!buildResult?.success) {
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

      await get().selectProject(project.id, { startDevServer: false });

      const didGenerateProject = await generateInitialProject(
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
  deployCurrentProject: async (options) => {
    const project = get().currentProject;

    if (!project) {
      set({ projectError: "Select a project before deploying to Vercel." });
      return null;
    }

    set((state) => ({
      isDeploying: true,
      projectError: null,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[vercel] Deploying ${project.name} to ${options.target}`,
      ]),
    }));

    try {
      const deployment = await projectApi.deployToVercel(project.id, options);

      if (get().currentProject?.id === project.id) {
        set((state) => ({
          lastDeploymentUrl: deployment.url,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[vercel] Deployment ready: ${deployment.url}`,
          ]),
        }));
      }

      return deployment;
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[vercel:error] ${message}`,
        ]),
      }));

      return null;
    } finally {
      set({ isDeploying: false });
    }
  },
  handleCommandOutput: (event) => {
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [formatCommandOutput(event)]),
    }));
  },
  handleCommandStatus: (event) => {
    const isCurrentProject = get().currentProject?.id === event.projectId;
    const isInstall = isInstallCommand(event.command);
    const isDev = isDevCommand(event.command);
    const isDeploy = isDeployCommand(event.command);

    set((state) => {
      const nextState: Partial<AppState> = {
        terminalLogs: appendLogs(state.terminalLogs, [
          formatCommandStatus(event),
        ]),
      };

      if (event.status === "started") {
        nextState.activeCommand = event.command;
        nextState.isRunningCommand = true;
        nextState.projectError = null;

        if (isInstall) {
          nextState.isInstallingDependencies = true;
        }

        if (isDev && isCurrentProject) {
          nextState.devServerStatus = "starting";
          nextState.isStartingDevServer = true;
          nextState.previewUrl = null;
        }

        if (isDeploy && isCurrentProject) {
          nextState.isDeploying = true;
        }
      }

      if (event.status === "succeeded") {
        nextState.activeCommand = null;
        nextState.isRunningCommand = false;

        if (isInstall) {
          nextState.isInstallingDependencies = false;
        }

        if (isDeploy && isCurrentProject) {
          nextState.isDeploying = false;
          nextState.lastDeploymentUrl = event.url ?? state.lastDeploymentUrl;
        }
      }

      if (event.status === "ready" && isDev && isCurrentProject && event.url) {
        nextState.devServerStatus = "running";
        nextState.isStartingDevServer = false;
        nextState.previewUrl = event.url;
      }

      if (event.status === "stopped" && isDev && isCurrentProject) {
        nextState.devServerStatus = "stopped";
        nextState.isStartingDevServer = false;
        nextState.previewUrl = null;
      }

      if (event.status === "failed") {
        nextState.activeCommand = null;
        nextState.isRunningCommand = false;
        nextState.projectError = formatCommandFailure(event);

        if (isInstall) {
          nextState.isInstallingDependencies = false;
        }

        if (isDev && isCurrentProject) {
          nextState.devServerStatus = "failed";
          nextState.isStartingDevServer = false;
          nextState.previewUrl = null;
        }

        if (isDeploy && isCurrentProject) {
          nextState.isDeploying = false;
        }
      }

      return nextState;
    });
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
          devServerStatus: "stopped",
          fileTree: null,
          lastDeploymentUrl: null,
          previewUrl: null,
          selectedFileContent: "",
          selectedFilePath: null,
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
  openPreviewInBrowser: async (url) => {
    const previewUrl = url ?? get().previewUrl;

    if (!previewUrl) {
      return;
    }

    try {
      await projectApi.openPreviewInBrowser(previewUrl);
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[preview:error] ${message}`,
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
  refreshPreview: () => {
    set((state) => ({ previewRefreshKey: state.previewRefreshKey + 1 }));
  },
  rollbackLastChange: async () => {
    const project = get().currentProject;

    if (!project || get().isRollingBack) {
      return;
    }

    const record = get().changeHistory.find(
      (change) => change.projectId === project.id,
    );

    if (!record) {
      set({ projectError: "No agent change is available to roll back." });
      return;
    }

    set((state) => ({
      isRollingBack: true,
      projectError: null,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[rollback] Restoring ${record.files.length} files from ${record.id}`,
      ]),
    }));

    try {
      const filesToRestore = record.files
        .filter((file) => file.beforeContent !== null)
        .map((file) => ({
          path: file.path,
          content: file.beforeContent ?? "",
        }));
      const filesToDelete = record.files
        .filter((file) => file.beforeContent === null)
        .map((file) => file.path);

      if (filesToRestore.length > 0) {
        await projectApi.writeFiles(project.id, filesToRestore);
      }

      if (filesToDelete.length > 0) {
        await projectApi.deleteFiles(project.id, filesToDelete);
      }

      const refreshedFileTree = await projectApi.listFiles(project.id);
      const selectedFilePath = get().selectedFilePath;
      let selectedFileContent = get().selectedFileContent;
      let selectedFilePathAfterRollback = selectedFilePath;

      if (selectedFilePath) {
        if (filesToDelete.includes(selectedFilePath)) {
          selectedFileContent = "";
          selectedFilePathAfterRollback = null;
        } else if (
          filesToRestore.some((file) => file.path === selectedFilePath)
        ) {
          selectedFileContent = await projectApi.readFile(
            project.id,
            selectedFilePath,
          );
        }
      }

      set((state) => ({
        changeHistory: state.changeHistory.filter(
          (change) => change.id !== record.id,
        ),
        chatMessages: [
          ...state.chatMessages,
          createChatMessage(
            "assistant",
            `Rolled back ${record.files.length} file change(s): ${record.files
              .map((file) => file.path)
              .join(", ")}`,
          ),
        ],
        fileTree: refreshedFileTree,
        previewRefreshKey: state.previewRefreshKey + 1,
        selectedFileContent,
        selectedFilePath: selectedFilePathAfterRollback,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[rollback] Restored ${record.files.length} files`,
        ]),
      }));
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[rollback:error] ${message}`,
        ]),
      }));
    } finally {
      set({ isRollingBack: false });
    }
  },
  runProjectCommand: async (projectId, command) => {
    set({
      activeCommand: command,
      isInstallingDependencies: isInstallCommand(command),
      isRunningCommand: true,
      projectError: null,
    });

    try {
      const result = await projectApi.runCommand(projectId, command);

      if (!result.success) {
        const exitCode = result.exitCode ?? "unknown";
        const message = `command: '${command}' exited with code ${exitCode}`;

        set((state) => ({
          projectError: message,
          terminalLogs: appendLogs(state.terminalLogs, [
            `[command:error] ${message}`,
          ]),
        }));
      }

      return result;
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[command:error] ${message}`,
        ]),
      }));

      return null;
    } finally {
      set((state) => ({
        activeCommand: state.activeCommand === command ? null : state.activeCommand,
        isInstallingDependencies: isInstallCommand(command)
          ? false
          : state.isInstallingDependencies,
        isRunningCommand:
          state.activeCommand === command ? false : state.isRunningCommand,
      }));
    }
  },
  selectProject: async (projectId, options = {}) => {
    const project = get().projects.find((item) => item.id === projectId);
    const previousProject = get().currentProject;
    const shouldStartDevServer = options.startDevServer ?? true;
    let didLoadFiles = false;

    if (!project) {
      return;
    }

    if (
      previousProject &&
      previousProject.id !== projectId &&
      get().devServerStatus !== "stopped"
    ) {
      await get().stopDevServer(previousProject.id);
    }

    set({
      currentProject: project,
      devServerStatus: "stopped",
      fileTree: null,
      isLoadingFiles: true,
      isStartingDevServer: false,
      lastDeploymentUrl: null,
      projectError: null,
      previewUrl: null,
      selectedFileContent: "",
      selectedFilePath: null,
    });

    try {
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
  sendMessage: (content) => {
    const message = content.trim();

    if (!message) {
      return Promise.resolve();
    }

    if (get().isModifyingProject || get().isGeneratingProject || get().isRollingBack) {
      set((state) => ({
        chatMessages: [
          ...state.chatMessages,
          createChatMessage(
            "assistant",
            "I am still applying the previous change. Please wait for it to finish before sending another request.",
          ),
        ],
      }));

      return Promise.resolve();
    }

    const userMessage = createChatMessage("user", message);

    set((state) => ({
      chatMessages: [...state.chatMessages, userMessage],
      terminalLogs: appendLogs(state.terminalLogs, [`[chat] ${message}`]),
    }));

    return modifyCurrentProject(message);
  },
  startDevServer: async (projectId) => {
    set({
      devServerStatus: "starting",
      isStartingDevServer: true,
      projectError: null,
      previewUrl: null,
    });

    try {
      const server = await projectApi.startDevServer(projectId);

      if (get().currentProject?.id === projectId) {
        set({
          devServerStatus: "running",
          isStartingDevServer: false,
          previewUrl: server.url,
        });
      }
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        devServerStatus: "failed",
        isStartingDevServer: false,
        projectError: message,
        previewUrl: null,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[dev-server:error] ${message}`,
        ]),
      }));
    }
  },
  stopDevServer: async (projectId) => {
    try {
      await projectApi.stopDevServer(projectId);

      if (get().currentProject?.id === projectId) {
        set({
          devServerStatus: "stopped",
          isStartingDevServer: false,
          previewUrl: null,
        });
      }
    } catch (error) {
      const message = getProjectErrorMessage(error);

      set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[dev-server:error] ${message}`,
        ]),
      }));
    }
  },
}));

let commandEventsInitialized = false;

export function initializeCommandEvents() {
  if (commandEventsInitialized) {
    return;
  }

  commandEventsInitialized = true;

  void projectApi
    .subscribeCommandEvents({
      onOutput: (event) => useAppStore.getState().handleCommandOutput(event),
      onStatus: (event) => useAppStore.getState().handleCommandStatus(event),
    })
    .catch((error) => {
      commandEventsInitialized = false;
      const message = getProjectErrorMessage(error);

      useAppStore.setState((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[command-events:error] ${message}`,
        ]),
      }));
    });
}

async function generateInitialProject(
  project: ProjectInfo,
  projectPrompt: string,
) {
  const stream = startStreamingAgentMessage(
    `Generating ${project.name} with DeepSeek`,
  );

  useAppStore.setState((state) => ({
    isGeneratingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Generating Next.js project files for ${project.name}`,
    ]),
  }));

  try {
    const config = await keyStore.getDeepSeekConfig();

    if (!config) {
      throw new Error("Configure your DeepSeek API key first.");
    }

    const response = await requestProjectGeneration({
      config,
      onDelta: stream.onDelta,
      projectName: project.name,
      userPrompt: projectPrompt,
    });
    stream.setStatus("Model output received. Applying files...");

    const changeRecord = await writeAgentFiles(
      project,
      response.files,
      response.summary,
    );

    if (useAppStore.getState().currentProject?.id === project.id) {
      useAppStore.setState((state) => ({
        chatMessages: replaceChatMessage(
          state.chatMessages,
          stream.messageId,
          formatChangeRecordMessage(response.summary, changeRecord),
          false,
        ),
        previewRefreshKey: state.previewRefreshKey + 1,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] ${response.summary}`,
        ]),
      }));
    }

    return true;
  } catch (error) {
    const message = getProjectErrorMessage(error);

    useAppStore.setState((state) => ({
      chatMessages: replaceChatMessage(
        state.chatMessages,
        stream.messageId,
        `Project generation failed: ${message}`,
        false,
      ),
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
    }));

    return false;
  } finally {
    useAppStore.setState({ isGeneratingProject: false });
  }
}

async function modifyCurrentProject(userRequest: string) {
  const project = useAppStore.getState().currentProject;
  let activeStream: AgentStreamController | null = null;

  if (!project) {
    appendAssistantMessage("Create or select a project first, then describe what to build.");
    return;
  }

  useAppStore.setState((state) => ({
    isModifyingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Collecting project context for ${project.name}`,
    ]),
  }));

  try {
    const config = await keyStore.getDeepSeekConfig();

    if (!config) {
      throw new Error("Configure your DeepSeek API key first.");
    }

    appendTerminalLog(`[agent] Using model ${config.model}`);

    let fileTree = useAppStore.getState().fileTree;

    if (!fileTree) {
      fileTree = await projectApi.listFiles(project.id);
    }

    const contextFilePaths = getContextFilePaths(fileTree);

    if (contextFilePaths.length === 0) {
      appendTerminalLog(
        "[agent] No editable files found, generating a full Next.js project",
      );
      activeStream = startStreamingAgentMessage(
        `Generating ${project.name} with DeepSeek`,
      );

      const response = await requestProjectGeneration({
        config,
        onDelta: activeStream.onDelta,
        projectName: project.name,
        userPrompt: userRequest,
      });
      activeStream.setStatus("Model output received. Applying files...");

      const changeRecord = await writeAgentFiles(
        project,
        response.files,
        response.summary,
      );

      if (useAppStore.getState().currentProject?.id !== project.id) {
        return;
      }

      useAppStore.setState((state) => ({
        chatMessages: replaceChatMessage(
          state.chatMessages,
          activeStream?.messageId ?? "",
          formatChangeRecordMessage(response.summary, changeRecord),
          false,
        ),
        previewRefreshKey: state.previewRefreshKey + 1,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] ${response.summary}`,
        ]),
      }));

      void useAppStore.getState().bootstrapProject(project.id);
      return;
    }

    appendTerminalLog(`[agent] Reading ${contextFilePaths.length} frontend files`);

    const fileContents = await Promise.all(
      contextFilePaths.map(async (path) => ({
        path,
        content: await projectApi.readFile(project.id, path),
      })),
    );
    const context = buildModificationContext({
      chatMessages: useAppStore.getState().chatMessages,
      fileContents,
      fileTree,
    });

    appendTerminalLog("[agent] Asking DeepSeek for modify_files JSON");
    activeStream = startStreamingAgentMessage("Modifying project with DeepSeek");

    const response = await requestProjectModification({
      config,
      context,
      onDelta: activeStream.onDelta,
      userRequest,
    });
    activeStream.setStatus("Model output received. Applying files...");

    if (useAppStore.getState().currentProject?.id !== project.id) {
      throw new Error("The active project changed, so this write was cancelled.");
    }

    const changeRecord = await writeAgentFiles(
      project,
      response.files,
      response.summary,
    );

    if (useAppStore.getState().currentProject?.id !== project.id) {
      return;
    }

    useAppStore.setState((state) => ({
      chatMessages: replaceChatMessage(
        state.chatMessages,
        activeStream?.messageId ?? "",
        formatChangeRecordMessage(response.summary, changeRecord),
        false,
      ),
      previewRefreshKey: state.previewRefreshKey + 1,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[agent] ${response.summary}`,
      ]),
    }));
  } catch (error) {
    const message = getProjectErrorMessage(error);

    useAppStore.setState((state) => ({
      chatMessages: activeStream
        ? replaceChatMessage(
            state.chatMessages,
            activeStream.messageId,
            `Change failed: ${message}`,
            false,
          )
        : [
            ...state.chatMessages,
            createChatMessage("assistant", `Change failed: ${message}`),
          ],
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
    }));
  } finally {
    useAppStore.setState({ isModifyingProject: false });
  }
}

async function writeAgentFiles(
  project: ProjectInfo,
  files: Array<{ path: string; content: string }>,
  summary: string,
) {
  appendTerminalLog(`[agent] Writing ${files.length} project files`);
  const beforeContents = new Map<string, string | null>();

  for (const file of files) {
    try {
      beforeContents.set(file.path, await projectApi.readFile(project.id, file.path));
    } catch {
      beforeContents.set(file.path, null);
    }
  }

  await projectApi.writeFiles(project.id, files);

  const refreshedFileTree = await projectApi.listFiles(project.id);
  const selectedFilePath = useAppStore.getState().selectedFilePath;
  const selectedFileWasModified = files.some(
    (file) => file.path === selectedFilePath,
  );
  const selectedFileContent =
    selectedFilePath && selectedFileWasModified
      ? await projectApi.readFile(project.id, selectedFilePath)
      : useAppStore.getState().selectedFileContent;

  if (useAppStore.getState().currentProject?.id !== project.id) {
    return createChangeRecord(project.id, summary, files, beforeContents);
  }

  const changeRecord = createChangeRecord(
    project.id,
    summary,
    files,
    beforeContents,
  );

  useAppStore.setState((state) => ({
    changeHistory: [changeRecord, ...state.changeHistory].slice(0, 20),
    fileTree: refreshedFileTree,
    selectedFileContent,
  }));

  return changeRecord;
}

function startStreamingAgentMessage(title: string): AgentStreamController {
  const message = createChatMessage("assistant", `${title}\n\nWaiting for model stream...`, {
    isStreaming: true,
  });
  let receivedChars = 0;
  let lastUpdateAt = 0;

  useAppStore.setState((state) => ({
    chatMessages: [...state.chatMessages, message],
  }));

  function update(status: string) {
    useAppStore.setState((state) => ({
      chatMessages: replaceChatMessage(
        state.chatMessages,
        message.id,
        `${title}\n\n${status}\n\nReceived ${receivedChars.toLocaleString()} characters.`,
        true,
      ),
    }));
  }

  return {
    messageId: message.id,
    onDelta: (delta) => {
      receivedChars += delta.length;
      const now = Date.now();

      if (now - lastUpdateAt > 180) {
        lastUpdateAt = now;
        update("Streaming model output...");
      }
    },
    setStatus: (status) => update(status),
  };
}

function replaceChatMessage(
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

function createChangeRecord(
  projectId: string,
  summary: string,
  files: Array<{ path: string; content: string }>,
  beforeContents: Map<string, string | null>,
): ChangeRecord {
  return {
    id: `change-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    files: files.map((file) =>
      summarizeFileChange(
        file.path,
        beforeContents.get(file.path) ?? null,
        file.content,
      ),
    ),
    projectId,
    summary,
  };
}

function summarizeFileChange(
  path: string,
  beforeContent: string | null,
  afterContent: string,
): FileChangeSummary {
  const beforeLines = splitLines(beforeContent ?? "");
  const afterLines = splitLines(afterContent);
  const commonCount = countCommonLines(beforeLines, afterLines);
  const additions = Math.max(0, afterLines.length - commonCount);
  const deletions = beforeContent === null ? 0 : Math.max(0, beforeLines.length - commonCount);

  return {
    action: beforeContent === null ? "created" : "modified",
    additions,
    afterContent,
    beforeContent,
    deletions,
    path,
    sampleAddedLines: sampleChangedLines(afterLines, beforeLines),
    sampleRemovedLines: beforeContent === null ? [] : sampleChangedLines(beforeLines, afterLines),
  };
}

function formatChangeRecordMessage(summary: string, record: ChangeRecord) {
  const lines = [summary, "", "Changed files:"];

  for (const file of record.files) {
    lines.push(
      `- ${file.path} (${file.action}, +${file.additions}/-${file.deletions})`,
    );

    for (const addedLine of file.sampleAddedLines.slice(0, 3)) {
      lines.push(`  + ${addedLine}`);
    }

    for (const removedLine of file.sampleRemovedLines.slice(0, 2)) {
      lines.push(`  - ${removedLine}`);
    }
  }

  lines.push("", "Rollback is available from the chat toolbar.");
  return lines.join("\n");
}

function splitLines(content: string) {
  return content.split(/\r?\n/);
}

function countCommonLines(left: string[], right: string[]) {
  const counts = new Map<string, number>();
  let common = 0;

  for (const line of left) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  for (const line of right) {
    const count = counts.get(line) ?? 0;

    if (count > 0) {
      common += 1;
      counts.set(line, count - 1);
    }
  }

  return common;
}

function sampleChangedLines(source: string[], comparison: string[]) {
  const comparisonCounts = new Map<string, number>();
  const samples: string[] = [];

  for (const line of comparison) {
    comparisonCounts.set(line, (comparisonCounts.get(line) ?? 0) + 1);
  }

  for (const line of source) {
    const count = comparisonCounts.get(line) ?? 0;

    if (count > 0) {
      comparisonCounts.set(line, count - 1);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    samples.push(trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed);

    if (samples.length >= 5) {
      break;
    }
  }

  return samples;
}

function appendAssistantMessage(content: string) {
  useAppStore.setState((state) => ({
    chatMessages: [
      ...state.chatMessages,
      createChatMessage("assistant", content),
    ],
  }));
}

function appendTerminalLog(content: string) {
  useAppStore.setState((state) => ({
    terminalLogs: appendLogs(state.terminalLogs, [content]),
  }));
}

function createChatMessage(
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

function appendLogs(logs: string[], entries: string[]) {
  return [...logs, ...entries].slice(-MAX_TERMINAL_LOGS);
}

function formatCommandOutput(event: CommandOutputEvent) {
  const stream = event.stream === "stderr" ? "err" : "out";
  return `[${event.command}:${stream}] ${event.line}`;
}

function formatCommandStatus(event: CommandStatusEvent) {
  const exitCode =
    event.exitCode === null || event.exitCode === undefined
      ? ""
      : ` exit ${event.exitCode}`;
  const url = event.url ? ` ${event.url}` : "";
  const message = event.message ? ` ${event.message}` : "";

  return `[${event.command}] ${event.status}${exitCode}${url}${message}`;
}

function formatCommandFailure(event: CommandStatusEvent) {
  const exitCode =
    event.exitCode === null || event.exitCode === undefined
      ? "unknown"
      : event.exitCode;

  return event.message ?? `command: '${event.command}' failed with code ${exitCode}`;
}

function isInstallCommand(command: string) {
  return command === "npm install" || command === "pnpm install";
}

function isDevCommand(command: string) {
  return command === "npm run dev" || command === "pnpm dev";
}

function isDeployCommand(command: string) {
  return command === "vercel deploy";
}
