import type { TaskContract } from "../agent-core/types";
import {
  compileTaskContract,
  validateTaskContract,
} from "../agent-core/contract/taskContract";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";

export function compileSpecTaskContract({
  revision,
  spec,
  task,
}: {
  revision: SpecRevision;
  spec: DevelopmentSpec;
  task: SpecTask;
}): TaskContract {
  const base = compileTaskContract({
    objective: task.objective,
    taskType: spec.kind === "initial_build" ? "full_site" : undefined,
  });
  const criteriaById = new Map(
    revision.requirements.acceptanceCriteria.map((criterion) => [
      criterion.id,
      criterion,
    ]),
  );
  const acceptanceCriteria = task.acceptanceCriteriaIds.map((criterionId) => {
    const criterion = criteriaById.get(criterionId);

    if (!criterion) {
      throw new Error(`Spec task references unknown criterion ${criterionId}.`);
    }

    return criterion;
  });

  return validateTaskContract({
    ...base,
    acceptanceCriteria,
    objective: task.objective,
    scope: {
      ...base.scope,
      allowedPaths: task.allowedPaths,
    },
    source: {
      acceptanceCriteriaIds: task.acceptanceCriteriaIds,
      mode: "spec",
      requirementIds: task.requirementIds,
      revisionId: revision.id,
      specId: spec.id,
      taskId: task.id,
    },
  });
}
