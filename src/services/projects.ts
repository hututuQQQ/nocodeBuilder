import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  framework: "next-app-router";
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

export type FileTree = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children?: FileTree[];
};

export type ProjectFileInput = {
  path: string;
  content: string;
};

export type ProjectFileChangeSummary = {
  action: "created" | "deleted" | "modified";
  additions: number;
  afterContent: string | null;
  beforeContent: string | null;
  deletions: number;
  path: string;
  revertedAt?: string;
  sampleAddedLines: string[];
  sampleRemovedLines: string[];
  unifiedDiff: string;
};

export type ProjectChangeRecord = {
  createdAt: string;
  files: ProjectFileChangeSummary[];
  id: string;
  kind: "agent" | "revert";
  projectId: string;
  revertedAt?: string;
  revertedByChangeId?: string;
  summary: string;
};

export type ProjectChatMessage = {
  activities?: ProjectChatActivity[];
  activitiesCollapsed?: boolean;
  activitySummary?: string;
  animateContent?: boolean;
  id: string;
  isStreaming?: boolean;
  role: "assistant" | "user";
  content: string;
};

export type ProjectChatActivity = {
  command?: string;
  detail?: string;
  elapsedMs?: number;
  error?: string;
  finishedAt?: string;
  id: string;
  kind:
    | "command"
    | "database"
    | "file"
    | "preview"
    | "thinking"
    | "tool"
    | "verification";
  outputLineCount?: number;
  outputPreview?: string[];
  startedAt?: string;
  status: "failed" | "pending" | "running" | "succeeded";
  title: string;
};

export type ProjectConversationSummary = {
  id: string;
  projectId: string;
  title: string;
  kind: IterationKind;
  mode: IterationMode;
  activeSpecId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  archivedAt: string | null;
  messageCount: number;
};

export type IterationMode = "chat" | "spec";

export type IterationKind = "initial_build" | "iteration";

export type ProjectConversation = Omit<
  ProjectConversationSummary,
  "messageCount"
> & {
  specIds: string[];
  modeChangedAt: string;
  messages: ProjectChatMessage[];
};

export type CreateProjectConversationInput = {
  title?: string;
  kind: IterationKind;
  mode: IterationMode;
  conversationId?: string;
  activeSpecId?: string | null;
  specIds?: string[];
};

export type SwitchProjectConversationModeInput = {
  conversationId: string;
  targetMode: IterationMode;
  activeSpecId: string | null;
  specIds: string[];
};

export type CommandResult = {
  projectId: string;
  command: string;
  success: boolean;
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string;
};

export type DevServerInfo = {
  projectId: string;
  command: string;
  pid: number;
  status: "running";
  startedAt: string;
  url: string;
};

export type PreviewProbeResult = {
  ok: boolean;
  status: number;
  summary: string;
};

export type VercelDeployTarget = "preview" | "production";

export type VercelDeployOptions = {
  token: string;
  scope?: string;
  projectName?: string;
  target: VercelDeployTarget;
};

export type VercelDeploymentInfo = {
  projectId: string;
  target: VercelDeployTarget;
  url: string;
  startedAt: string;
  finishedAt: string;
};

export type VercelUserInfo = {
  username: string;
};

export type CommandOutputEvent = {
  projectId: string;
  command: string;
  stream: "stdout" | "stderr";
  line: string;
  timestamp: string;
};

export type CommandStatusEvent = {
  projectId: string;
  command: string;
  status: "started" | "succeeded" | "failed" | "ready" | "stopped";
  exitCode: number | null;
  message: string | null;
  timestamp: string;
  url: string | null;
};

export type CommandEventHandlers = {
  onOutput: (event: CommandOutputEvent) => void;
  onStatus: (event: CommandStatusEvent) => void;
};

export const projectApi = {
  createProject(projectName: string) {
    return invoke<ProjectInfo>("create_project", { projectName });
  },

  deleteUninitializedProject(projectId: string) {
    return invoke<void>("delete_uninitialized_project", { projectId });
  },

  listProjects() {
    return invoke<ProjectInfo[]>("list_projects");
  },

  listFiles(projectId: string) {
    return invoke<FileTree>("list_files", { projectId });
  },

  readFile(projectId: string, path: string) {
    return invoke<string>("read_file", { projectId, path });
  },

  writeFile(projectId: string, path: string, content: string) {
    return invoke<void>("write_file", { projectId, path, content });
  },

  writeFiles(projectId: string, files: ProjectFileInput[]) {
    return invoke<void>("write_files", { projectId, files });
  },

  deleteFiles(projectId: string, paths: string[]) {
    return invoke<void>("delete_files", { paths, projectId });
  },

  openProjectFolder(projectId: string) {
    return invoke<void>("open_project_folder", { projectId });
  },

  listProjectChangeHistory(projectId: string) {
    return invoke<ProjectChangeRecord[]>("list_project_change_history", {
      projectId,
    });
  },

  saveProjectChangeHistory(
    projectId: string,
    records: ProjectChangeRecord[],
  ) {
    return invoke<void>("save_project_change_history", { projectId, records });
  },

  listProjectConversations(projectId: string, includeArchived = false) {
    return invoke<ProjectConversationSummary[]>("list_project_conversations", {
      includeArchived,
      projectId,
    });
  },

  createProjectConversation(
    projectId: string,
    input: CreateProjectConversationInput,
  ) {
    return invoke<ProjectConversation>("create_project_conversation", {
      input,
      projectId,
    });
  },

  readProjectConversation(projectId: string, conversationId: string) {
    return invoke<ProjectConversation>("read_project_conversation", {
      conversationId,
      projectId,
    });
  },

  saveProjectConversation(
    projectId: string,
    conversation: ProjectConversation,
  ) {
    return invoke<ProjectConversation>("save_project_conversation", {
      conversation,
      projectId,
    });
  },

  switchProjectConversationMode(
    projectId: string,
    input: SwitchProjectConversationModeInput,
  ) {
    return invoke<ProjectConversation>("switch_project_conversation_mode", {
      input,
      projectId,
    });
  },

  archiveProjectConversation(projectId: string, conversationId: string) {
    return invoke<ProjectConversation>("archive_project_conversation", {
      conversationId,
      projectId,
    });
  },

  unarchiveProjectConversation(projectId: string, conversationId: string) {
    return invoke<ProjectConversation>("unarchive_project_conversation", {
      conversationId,
      projectId,
    });
  },

  runCommand(projectId: string, command: string) {
    return invoke<CommandResult>("run_command", { projectId, command });
  },

  startDevServer(projectId: string) {
    return invoke<DevServerInfo>("start_dev_server", { projectId });
  },

  stopDevServer(projectId: string) {
    return invoke<void>("stop_dev_server", { projectId });
  },

  deployToVercel(projectId: string, options: VercelDeployOptions) {
    return invoke<VercelDeploymentInfo>("deploy_to_vercel", {
      options,
      projectId,
    });
  },

  testVercelToken(token: string) {
    return invoke<VercelUserInfo>("test_vercel_token", { token });
  },

  openPreviewInBrowser(url: string) {
    return invoke<void>("open_preview_in_browser", { url });
  },

  probePreviewUrl(url: string) {
    return invoke<PreviewProbeResult>("probe_preview_url", { url });
  },

  async subscribeCommandEvents({
    onOutput,
    onStatus,
  }: CommandEventHandlers): Promise<UnlistenFn> {
    const [unlistenOutput, unlistenStatus] = await Promise.all([
      listen<CommandOutputEvent>("command-output", (event) => {
        onOutput(event.payload);
      }),
      listen<CommandStatusEvent>("command-status", (event) => {
        onStatus(event.payload);
      }),
    ]);

    return () => {
      unlistenOutput();
      unlistenStatus();
    };
  },
};

export function getProjectErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected project error";
}
