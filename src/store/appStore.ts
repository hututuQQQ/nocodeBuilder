import { create } from "zustand";
import type {
  CommandOutputEvent,
  CommandResult,
  CommandStatusEvent,
  FileTree,
  ProjectConversation,
  ProjectConversationSummary,
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
import { createAgentRunActions } from "./agentRunStoreActions";
import { appendLogs, type CommandRun, type CommandRunLink } from "./commandLogs";
import { createCommandActions } from "./commandStoreActions";
import { createConversationActions } from "./conversationStoreActions";
import { createDeploymentActions } from "./deploymentStoreActions";
import { createPreviewActions } from "./previewStoreActions";
import { createProjectActions } from "./projectStoreActions";
import { createReviewActions } from "./reviewStoreActions";
import type { AgentEvent, AgentRun, VerificationReport } from "../agent-core/types";

export type { ChatMessage } from "./chatMessages";
export type { ChangeRecord, FileChangeSummary } from "./changeHistory";

type DevServerStatus = "stopped" | "starting" | "running" | "failed";

export type AppState = {
  activeCommand: string | null;
  activeCommandRunId: string | null;
  agentEvents: AgentEvent[];
  agentRuns: AgentRun[];
  commandRuns: CommandRun[];
  currentAgentRun: AgentRun | null;
  currentProject: ProjectInfo | null;
  currentVerificationReport: VerificationReport | null;
  devServerStatus: DevServerStatus;
  projects: ProjectInfo[];
  fileTree: FileTree | null;
  selectedFilePath: string | null;
  selectedFileContent: string;
  selectedChangeFilePath: string | null;
  selectedSiteNodeId: string | null;
  conversationSummaries: ProjectConversationSummary[];
  currentConversation: ProjectConversation | null;
  chatMessages: ChatMessage[];
  changeHistory: ChangeRecord[];
  terminalLogs: string[];
  previewRefreshKey: number;
  previewUrl: string | null;
  lastDeploymentUrl: string | null;
  isInstallingDependencies: boolean;
  isLoadingProjects: boolean;
  isCreatingProject: boolean;
  isCreatingConversation: boolean;
  isLoadingConversations: boolean;
  isGeneratingProject: boolean;
  isLoadingFiles: boolean;
  isRevertingChange: boolean;
  isReadingFile: boolean;
  isRunningCommand: boolean;
  isStartingDevServer: boolean;
  isDeploying: boolean;
  isModifyingProject: boolean;
  projectError: string | null;
  showArchivedConversations: boolean;
  archiveConversation: (conversationId: string) => Promise<void>;
  archiveCurrentConversation: () => Promise<void>;
  bootstrapProject: (projectId: string) => Promise<void>;
  cancelCurrentAgentRun: () => Promise<void>;
  clearSelectedSiteNode: () => void;
  createConversation: (
    projectId?: string,
    title?: string,
  ) => Promise<ProjectConversation | null>;
  createProject: (
    projectName: string,
    projectPrompt: string,
  ) => Promise<ProjectInfo | null>;
  deployCurrentProject: (
    options: VercelDeployOptions,
  ) => Promise<VercelDeploymentInfo | null>;
  handleCommandOutput: (event: CommandOutputEvent) => void;
  handleCommandStatus: (event: CommandStatusEvent) => void;
  loadProjectConversations: (
    projectId: string,
    options?: { ensureConversation?: boolean; initialTitle?: string },
  ) => Promise<void>;
  loadProjectChangeHistory: (projectId: string) => Promise<void>;
  loadAgentRuns: (projectId: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  openProjectFolder: (projectId: string) => Promise<void>;
  openPreviewInBrowser: (url?: string) => Promise<void>;
  readProjectFile: (path: string) => Promise<void>;
  refreshPreview: () => void;
  acceptAllChanges: () => Promise<void>;
  acceptChangedFile: (path: string) => Promise<void>;
  persistProjectChangeHistory: (
    projectId: string,
    records: ChangeRecord[],
  ) => Promise<void>;
  pauseCurrentAgentRun: () => Promise<void>;
  recordProjectChange: (record: ChangeRecord) => Promise<void>;
  revertAllChanges: () => Promise<void>;
  revertChangedFile: (path: string) => Promise<void>;
  resumeCurrentAgentRun: () => Promise<void>;
  runProjectCommand: (
    projectId: string,
    command: string,
    link?: CommandRunLink,
  ) => Promise<CommandResult | null>;
  selectConversation: (conversationId: string) => Promise<void>;
  selectReviewFile: (path: string | null) => void;
  selectProject: (
    projectId: string,
    options?: {
      ensureConversation?: boolean;
      startDevServer?: boolean;
      conversationTitle?: string;
    },
  ) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  sendAgentSteering: (content: string) => Promise<void>;
  setSelectedSiteNode: (nodeId: string | null) => void;
  setShowArchivedConversations: (showArchived: boolean) => Promise<void>;
  startDevServer: (projectId: string) => Promise<void>;
  stopDevServer: (projectId: string) => Promise<void>;
  unarchiveConversation: (conversationId: string) => Promise<void>;
};

const initialState = {
  activeCommand: null,
  activeCommandRunId: null,
  agentEvents: [],
  agentRuns: [],
  commandRuns: [],
  currentAgentRun: null,
  currentProject: null,
  currentVerificationReport: null,
  devServerStatus: "stopped" as DevServerStatus,
  projects: [],
  fileTree: null,
  selectedFilePath: null,
  selectedFileContent: "",
  selectedChangeFilePath: null,
  selectedSiteNodeId: null,
  conversationSummaries: [],
  currentConversation: null,
  chatMessages: [],
  changeHistory: [],
  terminalLogs: [],
  previewRefreshKey: 0,
  previewUrl: null,
  lastDeploymentUrl: null,
  isInstallingDependencies: false,
  isLoadingProjects: false,
  isCreatingProject: false,
  isCreatingConversation: false,
  isLoadingConversations: false,
  isGeneratingProject: false,
  isLoadingFiles: false,
  isRevertingChange: false,
  isReadingFile: false,
  isRunningCommand: false,
  isStartingDevServer: false,
  isDeploying: false,
  isModifyingProject: false,
  projectError: null,
  showArchivedConversations: false,
} satisfies Omit<
  AppState,
  | "archiveConversation"
  | "archiveCurrentConversation"
  | "bootstrapProject"
  | "cancelCurrentAgentRun"
  | "clearSelectedSiteNode"
  | "createConversation"
  | "createProject"
  | "deployCurrentProject"
  | "handleCommandOutput"
  | "handleCommandStatus"
  | "loadProjectConversations"
  | "loadProjectChangeHistory"
  | "loadAgentRuns"
  | "loadProjects"
  | "openProjectFolder"
  | "openPreviewInBrowser"
  | "readProjectFile"
  | "refreshPreview"
  | "acceptAllChanges"
  | "acceptChangedFile"
  | "persistProjectChangeHistory"
  | "pauseCurrentAgentRun"
  | "recordProjectChange"
  | "revertAllChanges"
  | "revertChangedFile"
  | "resumeCurrentAgentRun"
  | "runProjectCommand"
  | "selectReviewFile"
  | "selectConversation"
  | "selectProject"
  | "sendMessage"
  | "sendAgentSteering"
  | "setSelectedSiteNode"
  | "setShowArchivedConversations"
  | "startDevServer"
  | "stopDevServer"
  | "unarchiveConversation"
>;

export const useAppStore = create<AppState>((set, get) => {
  const store = { get, set };

  return {
    ...initialState,
    ...createAgentRunActions(store),
    ...createCommandActions(store),
    ...createConversationActions(store),
    ...createDeploymentActions(store),
    ...createPreviewActions(store),
    ...createProjectActions(store),
    ...createReviewActions(store),
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
