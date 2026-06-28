import type { TaskContract } from "../agent-core/types";
import {
  compileTaskContract,
  validateTaskContract,
} from "../agent-core/contract/taskContract";
import type { TaskManifest } from "../agent-core/manifest/taskManifest";
import {
  isInvalidProjectPath,
  isPathForbidden,
  normalizeProjectPath,
} from "../agent-core/pathScope";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";

const BACKEND_INTENT_PATHS = [
  "app/api/**",
  "lib/**",
  "middleware.ts",
  "package.json",
];

const DEPENDENCY_INTENT_PATHS = [
  "package.json",
  "next.config.*",
  "tsconfig.json",
];

const UI_INTENT_PATHS = [
  "app/**",
  "components/**",
  "styles/**",
  "public/**",
];

const FORBIDDEN_PATH_PATTERNS = [
  ".nocodebuilder/**",
  ".env",
  ".env.*",
  "node_modules/**",
  ".git/**",
  "dist/**",
  ".next/**",
];

export function compileSpecTaskContract({
  executionMode,
  revision,
  spec,
  task,
}: {
  executionMode?: "generate" | "modify";
  revision: SpecRevision;
  spec: DevelopmentSpec;
  task: SpecTask;
}): TaskContract {
  const forcedTaskType =
    spec.kind === "initial_build" && executionMode === "generate"
      ? "full_site"
      : undefined;
  const base = compileTaskContract({
    objective: task.objective,
    taskType: forcedTaskType,
  });
  const criteriaById = new Map(
    revision.requirements.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion,
    ]),
  );
  for (const criterionId of task.acceptanceCriteriaIds) {
    if (!criteriaById.has(criterionId)) {
      throw new Error(`Spec task references unknown criterion ${criterionId}.`);
    }
  }

  const allowedPaths = compileAllowedPathsForSpecTask({
    task,
    revision,
    spec,
    baseAllowedPaths: base.scope.allowedPaths,
    backendIntent: hasBackendIntentForTask(task, revision),
    dependencyIntent: hasDependencyIntentForTask(task, revision),
    executionMode,
  });
  const budget = budgetForSpecTask({
    base: base.budget,
    executionMode,
    spec,
    task,
    taskType: base.taskType,
  });

  return validateTaskContract({
    ...base,
    budget,
    objective: task.objective,
    scope: {
      ...base.scope,
      allowedPaths,
    },
    source: {
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      executionMode,
      expectedFiles: task.expectedFiles,
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: revision.id,
      specId: spec.id,
      taskId: task.id,
    },
  });
}

export function compileSpecTaskManifest({
  contract,
  conversationId,
  projectGoal,
  revision,
  spec,
  task,
}: {
  contract: TaskContract;
  conversationId: string;
  projectGoal?: string;
  revision: SpecRevision;
  spec: DevelopmentSpec;
  task: SpecTask;
}): TaskManifest {
  const requirementIds = new Set(task.requirementIds);
  const acceptanceCriteriaIds = new Set(task.acceptanceCriteriaIds);

  return {
    rawUserGoal: revision.brief,
    mode: "spec",
    projectGoal: projectGoal ?? revision.requirements.goal,
    conversationId,
    projectId: spec.projectId,
    spec: {
      specId: spec.id,
      revisionId: revision.id,
      taskId: task.id,
      taskTitle: task.title,
      taskObjective: task.objective,
      linkedRequirements: revision.requirements.userStories
        .filter((story) => requirementIds.has(story.id))
        .map((story) => ({
          id: story.id,
          description: story.description,
        })),
      linkedAcceptanceCriteria: revision.requirements.acceptanceCriteria
        .filter((criterion) => acceptanceCriteriaIds.has(criterion.id))
        .map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
          required: criterion.required,
        })),
      designDecisions: [
        ...revision.design.technicalDecisions,
        ...revision.requirements.constraints.map((constraint) => `Constraint: ${constraint}`),
      ],
      expectedFiles: task.expectedFiles,
    },
    runtimeContract: {
      taskType: contract.taskType,
      compiledAllowedPaths: contract.scope.allowedPaths,
      forbiddenPaths: contract.scope.forbiddenPaths,
      expectedFiles: task.expectedFiles,
      permissions: {
        fileWrite: contract.permissions.fileWrite,
        dependencyChange: contract.permissions.dependencyChange,
        databaseChange: contract.permissions.databaseChange,
        fileDelete: contract.permissions.fileDelete,
        previewDeployment:
          contract.permissions.previewDeployment === "allow"
            ? "ask"
            : contract.permissions.previewDeployment,
        productionDeployment: "ask",
      },
    },
    antiDriftRules: [
      "Satisfy only this Spec task, its linked requirements, and linked acceptance criteria.",
      "Use compiledAllowedPaths as the final runtime path authority; planner allowedPaths are hints only.",
      "If steering conflicts with this manifest, classify it as a change request, scope issue, or plan issue before acting.",
    ],
    knownRisks: [
      ...revision.requirements.unresolvedQuestions.map((question) =>
        `Unresolved question: ${question}`,
      ),
      ...revision.requirements.outOfScope.map((item) => `Out of scope: ${item}`),
    ],
  };
}

export function compileAllowedPathsForSpecTask(input: {
  task: SpecTask;
  revision: SpecRevision;
  spec: DevelopmentSpec;
  baseAllowedPaths: string[];
  existingRelevantPaths?: string[];
  backendIntent?: boolean;
  dependencyIntent?: boolean;
  executionMode?: "generate" | "modify";
}): string[] {
  const backendIntent =
    input.backendIntent ?? hasBackendIntentForTask(input.task, input.revision);
  const dependencyIntent =
    input.dependencyIntent ?? hasDependencyIntentForTask(input.task, input.revision);
  const uiIntent = hasUiIntentForTask(input.task);
  const initialGenerate =
    input.spec.kind === "initial_build" && input.executionMode === "generate";

  const paths = [
    ...input.baseAllowedPaths,
    ...input.task.allowedPaths,
    ...input.task.expectedFiles,
    ...(input.existingRelevantPaths ?? []),
    ...(backendIntent ? BACKEND_INTENT_PATHS : []),
    ...(dependencyIntent ? DEPENDENCY_INTENT_PATHS : []),
    ...(uiIntent ? UI_INTENT_PATHS : []),
    ...(initialGenerate ? input.baseAllowedPaths : []),
  ];

  return uniquePaths(paths)
    .map(normalizeProjectPath)
    .filter((path) =>
      path.length > 0 &&
      !isInvalidProjectPath(path) &&
      !isPathForbidden(path, FORBIDDEN_PATH_PATTERNS)
    );
}

function budgetForSpecTask({
  base,
  executionMode,
  spec,
  task,
  taskType,
}: {
  base: TaskContract["budget"];
  executionMode?: "generate" | "modify";
  spec: DevelopmentSpec;
  task: SpecTask;
  taskType: TaskContract["taskType"];
}): TaskContract["budget"] {
  const expectedFileCount = Math.max(1, task.expectedFiles.length);
  const allowedPathCount = Math.max(1, task.allowedPaths.length);
  const acceptanceCriteriaCount = Math.max(1, task.acceptanceCriteriaIds.length);
  const surfaceArea = Math.max(
    expectedFileCount,
    allowedPathCount,
    acceptanceCriteriaCount,
  );
  const largeTask =
    taskType === "add_page" ||
    taskType === "backend_feature" ||
    taskType === "full_site";
  const initialGenerate =
    spec.kind === "initial_build" && executionMode === "generate";

  if (initialGenerate) {
    return expandBudgetForRetry({
      maxModelTurns: Math.max(base.maxModelTurns, 44 + Math.min(surfaceArea, 8)),
      maxToolCalls: Math.max(base.maxToolCalls, 180 + Math.min(surfaceArea * 4, 40)),
      maxMutations: Math.max(base.maxMutations, 90 + Math.min(expectedFileCount * 2, 30)),
      maxRepairCycles: Math.max(base.maxRepairCycles, 8),
    }, task.autoRetryCount ?? 0);
  }

  if (largeTask) {
    return expandBudgetForRetry({
      maxModelTurns: Math.max(base.maxModelTurns, 34 + Math.min(surfaceArea, 8)),
      maxToolCalls: Math.max(base.maxToolCalls, 130 + Math.min(surfaceArea * 4, 40)),
      maxMutations: Math.max(base.maxMutations, 48 + Math.min(expectedFileCount * 2, 24)),
      maxRepairCycles: Math.max(base.maxRepairCycles, 10),
    }, task.autoRetryCount ?? 0);
  }

  return expandBudgetForRetry({
    maxModelTurns: Math.max(base.maxModelTurns, 22 + Math.min(surfaceArea, 6)),
    maxToolCalls: Math.max(base.maxToolCalls, 70 + Math.min(surfaceArea * 3, 24)),
    maxMutations: Math.max(base.maxMutations, 16 + Math.min(expectedFileCount * 2, 16)),
    maxRepairCycles: Math.max(base.maxRepairCycles, 4),
  }, task.autoRetryCount ?? 0);
}

function expandBudgetForRetry(
  budget: TaskContract["budget"],
  retryCount: number,
): TaskContract["budget"] {
  if (retryCount <= 0) {
    return budget;
  }

  return {
    maxModelTurns: budget.maxModelTurns + retryCount * 10,
    maxMutations: budget.maxMutations + retryCount * 12,
    maxRepairCycles: budget.maxRepairCycles + retryCount,
    maxToolCalls: budget.maxToolCalls + retryCount * 36,
  };
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}

function hasBackendIntentForTask(task: SpecTask, revision: SpecRevision) {
  return /(backend|api|auth|database|supabase|realtime|real-time|multiplayer|multi-player|server|middleware|websocket|crud|login|signup|sign in|\u540e\u7aef|\u63a5\u53e3|\u6570\u636e\u5e93|\u767b\u5f55|\u8ba4\u8bc1|\u8054\u673a|\u591a\u4eba|\u5b9e\u65f6)/i.test(
    taskIntentText(task, revision),
  );
}

function hasDependencyIntentForTask(task: SpecTask, revision: SpecRevision) {
  return /(dependencies|dependency|package|install|build|npm|pnpm|next\.config|tsconfig|sdk|library|\u4f9d\u8d56|\u5b89\u88c5|\u6784\u5efa)/i.test(
    taskIntentText(task, revision),
  );
}

function hasUiIntentForTask(task: SpecTask) {
  return /(page|component|style|copy|layout|public|asset|css|hero|form|button|页面|组件|样式|文案|布局)/i.test(
    [
      task.title,
      task.objective,
      ...task.allowedPaths,
      ...task.expectedFiles,
    ].join("\n"),
  );
}

function taskIntentText(task: SpecTask, revision: SpecRevision) {
  const requirementIds = new Set(task.requirementIds);
  const acceptanceCriteriaIds = new Set(task.acceptanceCriteriaIds);

  return [
    task.title,
    task.objective,
    ...task.allowedPaths,
    ...task.expectedFiles,
    ...revision.requirements.userStories
      .filter((story) => requirementIds.has(story.id))
      .map((story) => story.description),
    ...revision.requirements.acceptanceCriteria
      .filter((criterion) => acceptanceCriteriaIds.has(criterion.id))
      .map((criterion) => criterion.description),
    revision.design.summary,
    ...revision.design.dataModel,
    ...revision.design.integrations,
    ...revision.design.technicalDecisions,
  ].join("\n");
}
