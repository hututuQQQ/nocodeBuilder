import type { ProjectFileInput } from "../../services/projects";
import type {
  AgentBudgetState,
  RunContextSummary,
} from "../../agent-core/types";
import type { TaskManifest } from "../../agent-core/manifest/taskManifest";
import type {
  ProjectMemoryContext,
  TaskLedger,
  WorkingSummary,
} from "./memory";
import type { AgentSupabaseSchemaInput } from "./backendSchema";
import type { ProjectBackendContext } from "./backendContext";

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
    }
  | {
      type: "tool_call";
      tool: "apply_supabase_schema";
      rationale: string;
      args: AgentSupabaseSchemaInput;
    }
  | {
      type: "tool_call";
      tool: "get_site_spec";
      rationale: string;
      args: Record<string, never>;
    }
  | {
      type: "tool_call";
      tool: "get_page_spec";
      rationale: string;
      args: { pageId?: string; route?: string };
    }
  | {
      type: "tool_call";
      tool: "find_site_node";
      rationale: string;
      args: {
        label?: string;
        nodeId?: string;
        route?: string;
        textHint?: string;
      };
    }
  | {
      type: "tool_call";
      tool: "update_design_tokens";
      rationale: string;
      args: {
        summary?: string;
        tokens: {
          colors?: Record<string, string>;
          typography?: Record<string, string>;
          spacing?: Record<string, string>;
          radii?: Record<string, string>;
        };
      };
    }
  | {
      type: "tool_call";
      tool: "resolve_node_source";
      rationale: string;
      args: { nodeId: string };
    }
  | {
      type: "tool_call";
      tool: "refresh_site_index";
      rationale: string;
      args: { reason?: string };
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
      type: "finish_candidate";
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

export type CompactSpecContext = {
  acceptanceCriteria: Array<{
    description: string;
    id: string;
    required: boolean;
  }>;
  brief: string;
  currentTask: {
    acceptanceCriteriaIds: string[];
    allowedPaths: string[];
    dependencyIds: string[];
    expectedFiles: string[];
    id: string;
    objective: string;
    requirementIds: string[];
    status: string;
    title: string;
  };
  design: {
    dataModel: string[];
    integrations: string[];
    summary: string;
    technicalDecisions: string[];
    verificationStrategy: string[];
  };
  executionMode?: "generate" | "modify";
  goal: string;
  kind: string;
  relatedTasks: Array<{
    id: string;
    status: string;
    title: string;
  }>;
  requirements: Array<{
    description: string;
    id: string;
  }>;
  revisionId: string;
  specId: string;
  specStatus: string;
  taskProgress: {
    blocked: number;
    failed: number;
    passed: number;
    pending: number;
    running: number;
    total: number;
  };
};

export type ContextCompressionReport = {
  finalChars: number;
  rawChars: number;
  retainedObservations: number;
  summarizedObservations: number;
};

export type AgentStepContext = {
  backend: ProjectBackendContext | null;
  budgetState: AgentBudgetState;
  contextReport: ContextCompressionReport;
  diagnostics: string | null;
  devServerStatus: string;
  fileTree: string | null;
  manifest: TaskManifest;
  memory: (ProjectMemoryContext & {
    selectedSiteNodeId?: string | null;
    siteSpecPages?: Array<{
      id: string;
      route: string;
      title: string;
    }>;
  }) | null;
  observations: AgentObservation[];
  previewUrl: string | null;
  projectName: string;
  recentMessages: ProjectChatMessage[];
  runContextSummary: RunContextSummary;
  specContext?: CompactSpecContext;
  steering: string[];
  taskLedger: TaskLedger | null;
  workingSummary: WorkingSummary | null;
};

export type ProjectContextFile = {
  path: string;
  content: string;
};

export type ModificationContext = {
  backend?: ProjectBackendContext | null;
  fileTree: string;
  files: ProjectContextFile[];
  recentMessages: ProjectChatMessage[];
};
