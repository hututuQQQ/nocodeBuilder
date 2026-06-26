import type { TaskContract } from "../agent-core/types";
import {
  compileTaskContract,
  validateTaskContract,
} from "../agent-core/contract/taskContract";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";

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

  const allowedPaths =
    spec.kind === "initial_build" && executionMode === "generate"
      ? uniquePaths([...task.allowedPaths, ...base.scope.allowedPaths])
      : task.allowedPaths;
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
