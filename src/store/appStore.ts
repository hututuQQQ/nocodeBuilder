import { create } from "zustand";
import type {
  CommandOutputEvent,
  CommandResult,
  CommandStatusEvent,
  FileTree,
  ProjectConversation,
  ProjectConversationSummary,
  ProjectInfo,
  CreateProjectConversationInput,
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
import { createSpecActions } from "./specStoreActions";
import type { DevelopmentSpec } from "../spec-core/types";
import type {
  AgentApproval,
  AgentEvent,
  AgentRun,
  PreviewDiagnostic,
  PreviewVerificationSession,
  VerificationReport,
} from "../agent-core/types";

export type { ChatMessage } from "./chatMessages";
export type { ChangeRecord, FileChangeSummary } from "./changeHistory";

type DevServerStatus = "stopped" | "starting" | "running" | "failed";

export type AppState = {
  activeCommand: string | null;
  activeCommandRunId: string | null;
  agentEvents: AgentEvent[];
  agentRuns: AgentRun[];
  commandRuns: CommandRun[];
  currentAgentApproval: AgentApproval | null;
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
  initialBuildSpec: DevelopmentSpec | null;
  currentSpec: DevelopmentSpec | null;
  historicalSpecs: DevelopmentSpec[];
  chatMessages: ChatMessage[];
  changeHistory: ChangeRecord[];
  terminalLogs: string[];
  previewRefreshKey: number;
  previewUrl: string | null;
  previewDiagnostics: PreviewDiagnostic[];
  previewVerificationSession: PreviewVerificationSession | null;
  previewVerificationSessions: PreviewVerificationSession[];
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
  isLoadingSpec: boolean;
  isGeneratingSpec: boolean;
  isRevisingSpec: boolean;
  isExecutingSpec: boolean;
  isVerifyingSpec: boolean;
  isSwitchingIterationMode: boolean;
  projectError: string | null;
  showArchivedConversations: boolean;
  archiveConversation: (conversationId: string) => Promise<void>;
  archiveCurrentConversation: () => Promise<void>;
  approveCurrentAgentApproval: () => Promise<void>;
  bootstrapProject: (projectId: string) => Promise<void>;
  cancelCurrentAgentRun: () => Promise<void>;
  cancelCurrentAgentRunAndWait: () => Promise<AgentRun | null>;
  clearSelectedSiteNode: () => void;
  createConversation: (
    projectId?: string,
    input?: string | CreateProjectConversationInput,
  ) => Promise<ProjectConversation | null>;
  createProject: (
    projectName: string,
    projectPrompt: string,
  ) => Promise<ProjectInfo | null>;
  deployCurrentProject: (
    options: VercelDeployOptions,
  ) => Promise<VercelDeploymentInfo | null>;
  denyCurrentAgentApproval: () => Promise<void>;
  handleCommandOutput: (event: CommandOutputEvent) => void;
  handleCommandStatus: (event: CommandStatusEvent) => void;
  loadProjectConversations: (
    projectId: string,
  ) => Promise<void>;
  loadProjectChangeHistory: (projectId: string) => Promise<void>;
  loadAgentRuns: (projectId: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  loadCurrentSpec: () => Promise<void>;
  loadConversationSpecHistory: () => Promise<void>;
  openProjectFolder: (projectId: string) => Promise<void>;
  openPreviewInBrowser: (url?: string) => Promise<void>;
  readProjectFile: (path: string) => Promise<void>;
  refreshPreview: () => void;
  recordPreviewDiagnostic: (
    diagnostic: Omit<PreviewDiagnostic, "id" | "runId" | "timestamp">,
  ) => void;
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
  recoverCurrentAgentRun: () => Promise<void>;
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
      startDevServer?: boolean;
    },
  ) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  sendAgentSteering: (content: string) => Promise<void>;
  createInitialSpec: (
    projectId: string,
    projectBrief: string,
    conversationTitle?: string,
  ) => Promise<ProjectConversation | null>;
  createFeatureSpecIteration: (
    projectId: string,
    title: string,
    brief: string,
  ) => Promise<ProjectConversation | null>;
  continueCurrentSpecExecution: () => Promise<void>;
  reviseCurrentSpec: (feedback: string) => Promise<void>;
  approveAndExecuteCurrentSpec: () => Promise<void>;
  retrySpecTask: (taskId: string) => Promise<void>;
  retrySpecVerification: () => Promise<void>;
  switchCurrentIterationToSpec: (brief: string) => Promise<void>;
  switchCurrentIterationToChat: (options?: {
    cancelActiveSpec?: boolean;
  }) => Promise<void>;
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
  currentAgentApproval: null,
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
  initialBuildSpec: null,
  currentSpec: null,
  historicalSpecs: [],
  chatMessages: [],
  changeHistory: [],
  terminalLogs: [],
  previewRefreshKey: 0,
  previewUrl: null,
  previewDiagnostics: [],
  previewVerificationSession: null,
  previewVerificationSessions: [],
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
  isLoadingSpec: false,
  isGeneratingSpec: false,
  isRevisingSpec: false,
  isExecutingSpec: false,
  isVerifyingSpec: false,
  isSwitchingIterationMode: false,
  projectError: null,
  showArchivedConversations: false,
} satisfies Omit<
  AppState,
  | "archiveConversation"
  | "archiveCurrentConversation"
  | "approveCurrentAgentApproval"
  | "bootstrapProject"
  | "cancelCurrentAgentRun"
  | "cancelCurrentAgentRunAndWait"
  | "clearSelectedSiteNode"
  | "createConversation"
  | "createFeatureSpecIteration"
  | "createInitialSpec"
  | "continueCurrentSpecExecution"
  | "createProject"
  | "deployCurrentProject"
  | "denyCurrentAgentApproval"
  | "handleCommandOutput"
  | "handleCommandStatus"
  | "loadProjectConversations"
  | "loadProjectChangeHistory"
  | "loadAgentRuns"
  | "loadProjects"
  | "loadCurrentSpec"
  | "loadConversationSpecHistory"
  | "openProjectFolder"
  | "openPreviewInBrowser"
  | "readProjectFile"
  | "refreshPreview"
  | "recordPreviewDiagnostic"
  | "acceptAllChanges"
  | "acceptChangedFile"
  | "persistProjectChangeHistory"
  | "pauseCurrentAgentRun"
  | "recordProjectChange"
  | "revertAllChanges"
  | "revertChangedFile"
  | "recoverCurrentAgentRun"
  | "resumeCurrentAgentRun"
  | "runProjectCommand"
  | "selectReviewFile"
  | "selectConversation"
  | "selectProject"
  | "sendMessage"
  | "sendAgentSteering"
  | "reviseCurrentSpec"
  | "approveAndExecuteCurrentSpec"
  | "retrySpecTask"
  | "retrySpecVerification"
  | "switchCurrentIterationToSpec"
  | "switchCurrentIterationToChat"
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
    ...createSpecActions(store),
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
