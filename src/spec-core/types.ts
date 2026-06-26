import type { VerificationReport } from "../agent-core/types";
import type { IterationKind } from "../services/projects";

export type SpecStatus =
  | "drafting"
  | "review"
  | "revising"
  | "approved"
  | "building"
  | "verifying"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type DevelopmentSpecKind = "initial_build" | "feature";

export type DevelopmentSpec = {
  id: string;
  projectId: string;
  conversationId: string;
  kind: DevelopmentSpecKind;
  status: SpecStatus;
  currentRevisionId: string;
  revisions: SpecRevision[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  failureMessage?: string;
  blockDiagnosis?: import("./blockTriage").SpecBlockDiagnosis;
  finalVerification?: SpecFinalVerification;
};

export type SpecRevision = {
  id: string;
  version: number;
  brief: string;
  requirements: SpecRequirements;
  design: SpecDesign;
  tasks: SpecTask[];
  createdAt: string;
  approvedAt?: string;
};

export type SpecRequirements = {
  goal: string;
  userStories: Array<{
    id: string;
    description: string;
  }>;
  acceptanceCriteria: Array<{
    id: string;
    description: string;
    required: boolean;
  }>;
  outOfScope: string[];
  constraints: string[];
  unresolvedQuestions: string[];
};

export type SpecDesign = {
  summary: string;
  pages: Array<{
    route: string;
    purpose: string;
  }>;
  components: Array<{
    name: string;
    responsibility: string;
  }>;
  dataModel: string[];
  integrations: string[];
  technicalDecisions: string[];
  verificationStrategy: string[];
};

export type SpecTaskStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled";

export type SpecTask = {
  id: string;
  title: string;
  objective: string;
  requirementIds: string[];
  acceptanceCriteriaIds: string[];
  dependencyIds: string[];
  allowedPaths: string[];
  expectedFiles: string[];
  status: SpecTaskStatus;
  runId?: string;
  error?: string;
  blockedByTaskId?: string;
  autoRetryCount?: number;
  retryContext?: string;
};

export type SpecAcceptanceResult = {
  criterionId: string;
  status: "passed" | "failed" | "pending";
  taskIds: string[];
  runIds: string[];
  summary?: string;
};

export type SpecFinalVerification = {
  command: string;
  output: string;
  success: boolean;
  checkedAt: string;
};

export type GeneratedSpecRevisionPayload = {
  brief: string;
  requirements: SpecRequirements;
  design: SpecDesign;
  tasks: Array<
    Omit<
      SpecTask,
      | "status"
      | "runId"
      | "error"
      | "blockedByTaskId"
      | "autoRetryCount"
      | "retryContext"
    >
  >;
};

export type SpecBuildContext = {
  conversationKind: IterationKind;
  verificationReports: VerificationReport[];
};
