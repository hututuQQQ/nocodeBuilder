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

export type ProjectChatMessage = {
  id: string;
  isStreaming?: boolean;
  role: "assistant" | "user";
  content: string;
};

export type ProjectConversationSummary = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  archivedAt: string | null;
  messageCount: number;
};

export type ProjectConversation = Omit<
  ProjectConversationSummary,
  "messageCount"
> & {
  messages: ProjectChatMessage[];
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

  listProjectConversations(projectId: string, includeArchived = false) {
    return invoke<ProjectConversationSummary[]>("list_project_conversations", {
      includeArchived,
      projectId,
    });
  },

  createProjectConversation(projectId: string, title?: string) {
    return invoke<ProjectConversation>("create_project_conversation", {
      projectId,
      title,
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
