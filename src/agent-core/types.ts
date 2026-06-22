export type AgentRunStatus =
  | "created"
  | "planning"
  | "exploring"
  | "mutating"
  | "waiting_approval"
  | "verifying"
  | "repairing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded";

export type AgentRunPhase =
  | "created"
  | "planning"
  | "exploring"
  | "mutating"
  | "waiting_approval"
  | "verifying"
  | "repairing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded";

export type AcceptanceCriterion = {
  id: string;
  description: string;
  required: boolean;
};

export type TaskType =
  | "answer"
  | "copy_edit"
  | "style_edit"
  | "component_edit"
  | "add_page"
  | "full_site"
  | "backend_feature"
  | "deployment";

export type TaskContract = {
  objective: string;
  taskType: TaskType;
  scope: {
    pages?: string[];
    componentIds?: string[];
    allowedPaths: string[];
    forbiddenPaths: string[];
  };
  acceptanceCriteria: AcceptanceCriterion[];
  permissions: {
    fileWrite: boolean;
    dependencyChange: "deny" | "ask" | "allow";
    fileDelete: "deny" | "ask" | "allow";
    databaseChange: "deny" | "ask" | "allow";
    previewDeployment: "deny" | "ask" | "allow";
    productionDeployment: "deny" | "ask";
  };
  budget: {
    maxModelTurns: number;
    maxToolCalls: number;
    maxMutations: number;
    maxRepairCycles: number;
  };
};

export type AgentRun = {
  id: string;
  projectId: string;
  conversationId: string;
  contract: TaskContract;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  stateVersion: number;
  modelTurns: number;
  toolCalls: number;
  mutationCount: number;
  repairCycles: number;
  cancelRequested: boolean;
  pauseRequested: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type AgentEventType =
  | "run.created"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.cancel_requested"
  | "run.cancelled"
  | "plan.updated"
  | "steering.received"
  | "model.started"
  | "model.completed"
  | "model.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "policy.allowed"
  | "policy.denied"
  | "approval.requested"
  | "approval.resolved"
  | "verification.started"
  | "verification.completed"
  | "checkpoint.created"
  | "run.completed"
  | "run.failed";

export type AgentEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: AgentEventType;
  timestamp: string;
  payload: unknown;
  artifactIds?: string[];
};

export type ToolSideEffect =
  | "none"
  | "workspace_write"
  | "database_write"
  | "external_write"
  | "destructive";

export type RuntimeSchema = {
  describe: string;
  validate: (value: unknown) => void;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: RuntimeSchema;
  outputSchema: RuntimeSchema;
  readOnly: boolean;
  concurrencySafe: boolean;
  sideEffect: ToolSideEffect;
  requiresVerification: boolean;
  approvalPolicy: "never" | "conditional" | "always";
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ToolResult = {
  status:
    | "success"
    | "domain_error"
    | "invalid_input"
    | "policy_denied"
    | "transient_error"
    | "timeout"
    | "cancelled"
    | "internal_error";
  summary: string;
  retryable: boolean;
  structuredData?: unknown;
  artifactIds: string[];
  workspaceEffects?: {
    changedFiles: string[];
    packageChanged: boolean;
  };
};

export type VerificationStatus = "passed" | "failed" | "inconclusive";

export type VerificationCheckStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "inconclusive";

export type VerificationCheck = {
  id: string;
  title: string;
  status: VerificationCheckStatus;
  summary: string;
  artifactIds?: string[];
  details?: unknown;
};

export type VerificationReport = {
  id: string;
  runId: string;
  status: VerificationStatus;
  checks: VerificationCheck[];
  newlyIntroducedFailures: string[];
  missingEvidence: string[];
  artifactIds: string[];
  repairFeedback: string[];
  createdAt: string;
};

export type SiteSpec = {
  version: 1;
  projectId: string;
  product: {
    name: string;
    description: string;
    language: string;
  };
  designSystem: {
    colors: Record<string, string>;
    typography: Record<string, string>;
    spacing: Record<string, string>;
    radii: Record<string, string>;
  };
  pages: PageSpec[];
  reusableComponents: ComponentSpec[];
};

export type PageSpec = {
  id: string;
  route: string;
  title: string;
  nodes: SiteNode[];
};

export type ComponentSpec = {
  id: string;
  name: string;
  source?: SiteNode["source"];
  props?: Record<string, unknown>;
};

export type SiteNode = {
  id: string;
  type: string;
  label?: string;
  parentId?: string;
  source?: {
    path: string;
    startLine?: number;
    endLine?: number;
  };
  props?: Record<string, unknown>;
  children?: SiteNode[];
};

export type SourceMapEntry = {
  nodeId: string;
  path: string;
  startLine?: number;
  endLine?: number;
};

export type SiteSourceMap = {
  version: 1;
  projectId: string;
  entries: SourceMapEntry[];
  updatedAt: string;
};
