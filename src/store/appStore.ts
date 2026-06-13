import { create } from "zustand";
import {
  buildModificationContext,
  getContextFilePaths,
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
} from "../services/projects";

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

type DevServerStatus = "stopped" | "starting" | "running" | "failed";

type AppState = {
  activeCommand: string | null;
  currentProject: ProjectInfo | null;
  devServerStatus: DevServerStatus;
  projects: ProjectInfo[];
  fileTree: FileTree | null;
  selectedFilePath: string | null;
  selectedFileContent: string;
  chatMessages: ChatMessage[];
  terminalLogs: string[];
  previewRefreshKey: number;
  previewUrl: string | null;
  isInstallingDependencies: boolean;
  isLoadingProjects: boolean;
  isCreatingProject: boolean;
  isLoadingFiles: boolean;
  isReadingFile: boolean;
  isRunningCommand: boolean;
  isStartingDevServer: boolean;
  isModifyingProject: boolean;
  projectError: string | null;
  bootstrapProject: (projectId: string) => Promise<void>;
  createProject: (projectName: string) => Promise<ProjectInfo | null>;
  handleCommandOutput: (event: CommandOutputEvent) => void;
  handleCommandStatus: (event: CommandStatusEvent) => void;
  loadProjects: () => Promise<void>;
  openProjectFolder: (projectId: string) => Promise<void>;
  openPreviewInBrowser: () => Promise<void>;
  readProjectFile: (path: string) => Promise<void>;
  refreshPreview: () => void;
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
      content: "Ready when you are. Describe the frontend you want to vibe-code.",
    },
  ],
  terminalLogs: [],
  previewRefreshKey: 0,
  previewUrl: null,
  isInstallingDependencies: false,
  isLoadingProjects: false,
  isCreatingProject: false,
  isLoadingFiles: false,
  isReadingFile: false,
  isRunningCommand: false,
  isStartingDevServer: false,
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

    await get().startDevServer(project.id);
  },
  createProject: async (projectName) => {
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
      void get().bootstrapProject(project.id);
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
  handleCommandOutput: (event) => {
    set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [formatCommandOutput(event)]),
    }));
  },
  handleCommandStatus: (event) => {
    const isCurrentProject = get().currentProject?.id === event.projectId;
    const isInstall = isInstallCommand(event.command);
    const isDev = isDevCommand(event.command);

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
      }

      if (event.status === "succeeded") {
        nextState.activeCommand = null;
        nextState.isRunningCommand = false;

        if (isInstall) {
          nextState.isInstallingDependencies = false;
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
  openPreviewInBrowser: async () => {
    const previewUrl = get().previewUrl;

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
      void get().startDevServer(project.id);
    }
  },
  sendMessage: (content) => {
    const message = content.trim();

    if (!message) {
      return Promise.resolve();
    }

    if (get().isModifyingProject) {
      set((state) => ({
        chatMessages: [
          ...state.chatMessages,
          createChatMessage(
            "assistant",
            localizeMessage(
              message,
              "I am still applying the previous change. Please wait for it to finish before sending another request.",
              "我还在处理上一条修改请求，请等当前修改完成后再发送新的要求。",
            ),
          ),
        ],
      }));

      return Promise.resolve();
    }

    const userMessage = createChatMessage("user", message);

    set((state) => ({
      chatMessages: [
        ...state.chatMessages,
        userMessage,
      ],
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

async function modifyCurrentProject(userRequest: string) {
  const project = useAppStore.getState().currentProject;

  if (!project) {
    appendAssistantMessage(
      localizeMessage(
        userRequest,
        "Create or select a project first, then describe how you want to change the page.",
        "请先创建或选择一个项目，然后再描述你想怎样修改页面。",
      ),
    );
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
      throw new Error(
        localizeMessage(
          userRequest,
          "Configure your DeepSeek API key first.",
          "请先配置 DeepSeek API Key。",
        ),
      );
    }

    appendTerminalLog(`[agent] Using model ${config.model}`);

    let fileTree = useAppStore.getState().fileTree;

    if (!fileTree) {
      fileTree = await projectApi.listFiles(project.id);
    }

    const contextFilePaths = getContextFilePaths(fileTree);

    if (contextFilePaths.length === 0) {
      throw new Error(
        localizeMessage(
          userRequest,
          "No editable frontend files were found in the current project.",
          "当前项目没有找到可编辑的前端文件。",
        ),
      );
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

    const response = await requestProjectModification({
      config,
      context,
      userRequest,
    });

    if (useAppStore.getState().currentProject?.id !== project.id) {
      throw new Error(
        localizeMessage(
          userRequest,
          "The active project changed, so this write was cancelled.",
          "当前项目已经切换，本次修改已取消写入。",
        ),
      );
    }

    appendTerminalLog(`[agent] Writing ${response.files.length} modified files`);
    await projectApi.writeFiles(project.id, response.files);

    const refreshedFileTree = await projectApi.listFiles(project.id);
    const selectedFilePath = useAppStore.getState().selectedFilePath;
    const selectedFileWasModified = response.files.some(
      (file) => file.path === selectedFilePath,
    );
    const selectedFileContent =
      selectedFilePath && selectedFileWasModified
        ? await projectApi.readFile(project.id, selectedFilePath)
        : useAppStore.getState().selectedFileContent;

    if (useAppStore.getState().currentProject?.id !== project.id) {
      return;
    }

    useAppStore.setState((state) => ({
      chatMessages: [
        ...state.chatMessages,
        createChatMessage("assistant", response.summary),
      ],
      fileTree: refreshedFileTree,
      previewRefreshKey: state.previewRefreshKey + 1,
      selectedFileContent,
      terminalLogs: appendLogs(state.terminalLogs, [
        `[agent] ${response.summary}`,
      ]),
    }));
  } catch (error) {
    const message = getProjectErrorMessage(error);

    useAppStore.setState((state) => ({
      chatMessages: [
        ...state.chatMessages,
        createChatMessage(
          "assistant",
          localizeMessage(
            userRequest,
            `Change failed: ${message}`,
            `修改失败：${message}`,
          ),
        ),
      ],
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
    }));
  } finally {
    useAppStore.setState({ isModifyingProject: false });
  }
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

function createChatMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
  };
}

function localizeMessage(
  userRequest: string,
  englishMessage: string,
  chineseMessage: string,
) {
  return containsChinese(userRequest) ? chineseMessage : englishMessage;
}

function containsChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
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
