import type { ProjectFileInput } from "../../services/projects";

export type GenerateProjectResponse = {
  type: "write_files";
  summary: string;
  files: ProjectFileInput[];
};

export type ModifyProjectResponse = {
  type: "modify_files";
  summary: string;
  files: ProjectFileInput[];
};

export type AgentToolCallStep =
  | {
      type: "tool_call";
      tool: "list_files";
      rationale: string;
      args: Record<string, never>;
    }
  | {
      type: "tool_call";
      tool: "read_files";
      rationale: string;
      args: { paths: string[] };
    }
  | {
      type: "tool_call";
      tool: "write_files";
      rationale: string;
      args: { files: ProjectFileInput[]; summary: string };
    }
  | {
      type: "tool_call";
      tool: "delete_files";
      rationale: string;
      args: { paths: string[]; summary: string };
    }
  | {
      type: "tool_call";
      tool: "run_command";
      rationale: string;
      args: { command: AgentCommand };
    }
  | {
      type: "tool_call";
      tool: "start_dev_server";
      rationale: string;
      args: Record<string, never>;
    }
  | {
      type: "tool_call";
      tool: "stop_dev_server";
      rationale: string;
      args: Record<string, never>;
    }
  | {
      type: "tool_call";
      tool: "refresh_preview";
      rationale: string;
      args: Record<string, never>;
    }
  | {
      type: "tool_call";
      tool: "rollback_last_change";
      rationale: string;
      args: Record<string, never>;
    };

export type AgentStepResponse =
  | {
      type: "answer";
      message: string;
    }
  | AgentToolCallStep
  | {
      type: "finish";
      summary: string;
      verification?: string;
    };

export type AgentCommand =
  | "npm install"
  | "npm run build"
  | "pnpm install"
  | "pnpm build";

export type AgentObservation = {
  content?: string;
  ok: boolean;
  step: number;
  summary: string;
  tool: string;
};

export type ProjectChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
};

export type AgentStepContext = {
  devServerStatus: string;
  fileTree: string | null;
  observations: AgentObservation[];
  previewUrl: string | null;
  projectName: string;
  recentMessages: ProjectChatMessage[];
};

export type ProjectContextFile = {
  path: string;
  content: string;
};

export type ModificationContext = {
  fileTree: string;
  files: ProjectContextFile[];
  recentMessages: ProjectChatMessage[];
};
