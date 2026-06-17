import type { ProjectFileInput } from "../../services/projects";
import type {
  ProjectMemoryContext,
  TaskLedger,
  WorkingSummary,
} from "./memory";

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
      args: { limit?: number; offset?: number; paths: string[] };
    }
  | {
      type: "tool_call";
      tool: "grep_files";
      rationale: string;
      args: {
        caseSensitive?: boolean;
        contextLines?: number;
        maxResults?: number;
        paths?: string[];
        query: string;
      };
    }
  | {
      type: "tool_call";
      tool: "glob_files";
      rationale: string;
      args: { maxResults?: number; pattern: string };
    }
  | {
      type: "tool_call";
      tool: "edit_file";
      rationale: string;
      args: {
        new_string: string;
        old_string: string;
        path: string;
        replace_all?: boolean;
        summary: string;
      };
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
    };

export type AgentToolBatchStep = {
  type: "tool_calls";
  rationale?: string;
  calls: AgentToolCallStep[];
};

export type AgentStepResponse =
  | {
      type: "answer";
      message: string;
    }
  | AgentToolCallStep
  | AgentToolBatchStep
  | {
      type: "finish";
      summary: string;
      verification?: string;
    };

export type AgentCommand =
  | "npm install"
  | "npm run lint"
  | "npm run build"
  | "npm run test"
  | "npm test"
  | "pnpm install"
  | "pnpm build"
  | "pnpm lint"
  | "pnpm test";

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
  memory: ProjectMemoryContext | null;
  observations: AgentObservation[];
  previewUrl: string | null;
  projectName: string;
  recentMessages: ProjectChatMessage[];
  taskLedger: TaskLedger | null;
  workingSummary: WorkingSummary | null;
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
