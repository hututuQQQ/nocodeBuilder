import { create } from "zustand";
import type {
  CommandOutputEvent,
  CommandResult,
  CommandStatusEvent,
  FileTree,
  ProjectInfo,
  VercelDeploymentInfo,
  VercelDeployOptions,
} from "../services/projects";
import {
  getProjectErrorMessage,
  projectApi,
} from "../services/projects";
import type { ChatMessage } from "./chatMessages";
import type { ChangeRecord } from "./changeHistory";
import { createChatActions } from "./chatStoreActions";
import { appendLogs } from "./commandLogs";
import { createCommandActions } from "./commandStoreActions";
import { createDeploymentActions } from "./deploymentStoreActions";
import { createPreviewActions } from "./previewStoreActions";
import { createProjectActions } from "./projectStoreActions";

export type { ChatMessage } from "./chatMessages";
export type { ChangeRecord, FileChangeSummary } from "./changeHistory";

type DevServerStatus = "stopped" | "starting" | "running" | "failed";

export type AppState = {
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

const initialState = {
  activeCommand: null,
  currentProject: null,
  devServerStatus: "stopped" as DevServerStatus,
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
  isRunningCommand: false,
  isStartingDevServer: false,
  isDeploying: false,
  isModifyingProject: false,
  projectError: null,
} satisfies Omit<
  AppState,
  | "bootstrapProject"
  | "createProject"
  | "deployCurrentProject"
  | "handleCommandOutput"
  | "handleCommandStatus"
  | "loadProjects"
  | "openProjectFolder"
  | "openPreviewInBrowser"
  | "readProjectFile"
  | "refreshPreview"
  | "runProjectCommand"
  | "selectProject"
  | "sendMessage"
  | "startDevServer"
  | "stopDevServer"
>;

export const useAppStore = create<AppState>((set, get) => {
  const store = { get, set };

  return {
    ...initialState,
    ...createCommandActions(store),
    ...createDeploymentActions(store),
    ...createPreviewActions(store),
    ...createProjectActions(store),
    ...createChatActions(store),
  };
});

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
