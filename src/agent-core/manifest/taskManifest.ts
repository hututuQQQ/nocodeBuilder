import type { TaskContract } from "../types";

export type TaskManifest = {
  rawUserGoal: string;
  mode: "chat" | "spec";
  projectGoal: string;
  conversationId: string;
  projectId: string;

  spec?: {
    specId: string;
    revisionId: string;
    taskId: string;
    taskTitle: string;
    taskObjective: string;
    linkedRequirements: Array<{ id: string; description: string }>;
    linkedAcceptanceCriteria: Array<{
      id: string;
      description: string;
      required: boolean;
    }>;
    designDecisions: string[];
    expectedFiles: string[];
  };

  runtimeContract: {
    taskType: string;
    compiledAllowedPaths: string[];
    forbiddenPaths: string[];
    expectedFiles: string[];
    permissions: {
      fileWrite: boolean;
      dependencyChange: "allow" | "ask" | "deny";
      databaseChange: "allow" | "ask" | "deny";
      fileDelete: "allow" | "ask" | "deny";
      previewDeployment: "ask" | "deny";
      productionDeployment: "ask";
    };
  };

  antiDriftRules: string[];
  knownRisks: string[];
};

export function createTaskManifestFromContract(input: {
  contract: TaskContract;
  conversationId: string;
  projectId: string;
  rawUserGoal?: string;
  projectGoal?: string;
}): TaskManifest {
  const source = input.contract.source;
  const expectedFiles = source?.expectedFiles ?? [];

  return {
    rawUserGoal: input.rawUserGoal ?? input.contract.objective,
    mode: source?.mode === "spec" ? "spec" : "chat",
    projectGoal: input.projectGoal ?? input.contract.objective,
    conversationId: input.conversationId,
    projectId: input.projectId,
    spec: source?.mode === "spec"
      ? {
          specId: source.specId,
          revisionId: source.revisionId,
          taskId: source.taskId,
          taskTitle: source.taskId,
          taskObjective: input.contract.objective,
          linkedRequirements: source.requirementIds.map((id) => ({
            id,
            description: id,
          })),
          linkedAcceptanceCriteria: input.contract.acceptanceCriteria.map((criterion) => ({
            id: criterion.id,
            description: criterion.description,
            required: criterion.required,
          })),
          designDecisions: [],
          expectedFiles,
        }
      : undefined,
    runtimeContract: {
      taskType: input.contract.taskType,
      compiledAllowedPaths: input.contract.scope.allowedPaths,
      forbiddenPaths: input.contract.scope.forbiddenPaths,
      expectedFiles,
      permissions: {
        fileWrite: input.contract.permissions.fileWrite,
        dependencyChange: input.contract.permissions.dependencyChange,
        databaseChange: input.contract.permissions.databaseChange,
        fileDelete: input.contract.permissions.fileDelete,
        previewDeployment:
          input.contract.permissions.previewDeployment === "allow"
            ? "ask"
            : input.contract.permissions.previewDeployment,
        productionDeployment: "ask",
      },
    },
    antiDriftRules: [
      "Stay focused on the current user goal, task objective, and linked acceptance criteria.",
      "Do not expand scope beyond compiledAllowedPaths or the runtime contract.",
      "Treat steering that conflicts with this manifest as a change request, scope issue, or plan issue.",
    ],
    knownRisks: [],
  };
}
