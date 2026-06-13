import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export type ProjectInfo = {
  id: string;
  name: string;
  path: string;
  framework: "vite-react";
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

  openProjectFolder(projectId: string) {
    return invoke<void>("open_project_folder", { projectId });
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
