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

  return validateTaskContract({
    ...base,
    objective: task.objective,
    scope: {
      ...base.scope,
      allowedPaths,
    },
    source: {
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      executionMode,
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: revision.id,
      specId: spec.id,
      taskId: task.id,
    },
  });
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths));
}
