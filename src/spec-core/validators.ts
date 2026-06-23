import { isRecord } from "../agent/project/records";
import type {
  DevelopmentSpec,
  GeneratedSpecRevisionPayload,
  SpecAcceptanceResult,
  SpecDesign,
  SpecRequirements,
  SpecRevision,
  SpecTask,
} from "./types";

const SPEC_STATUSES = new Set([
  "drafting",
  "review",
  "revising",
  "approved",
  "building",
  "verifying",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

const TASK_STATUSES = new Set([
  "pending",
  "running",
  "passed",
  "failed",
  "blocked",
  "cancelled",
]);

export function getCurrentSpecRevision(spec: DevelopmentSpec): SpecRevision {
  const revision = spec.revisions.find(
    (item) => item.id === spec.currentRevisionId,
  );

  if (!revision) {
    throw new Error("Spec currentRevisionId does not match any revision.");
  }

  return revision;
}

export function canRetrySpecVerification(spec: DevelopmentSpec): boolean {
  if (spec.status !== "blocked" || spec.finalVerification?.success !== false) {
    return false;
  }

  if (
    spec.finalVerification.command !== "npm install" &&
    spec.finalVerification.command !== "npm run build" &&
    spec.finalVerification.command !== "npm install && npm run build"
  ) {
    return false;
  }

  return getCurrentSpecRevision(spec).tasks.every(
    (task) => task.status === "passed" && Boolean(task.runId),
  );
}

export function validateGeneratedSpecRevisionPayload(
  value: unknown,
): GeneratedSpecRevisionPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid spec response: root value must be an object.");
  }

  const brief = readRequiredString(value.brief, "brief", 4000);
  const requirements = validateRequirements(value.requirements);
  const design = validateDesign(value.design);
  const rawTasks = value.tasks;

  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("Invalid spec response: at least one task is required.");
  }

  const tasks = rawTasks.map(validateGeneratedTask);
  validateRevisionParts(requirements, tasks);

  return {
    brief,
    design,
    requirements,
    tasks,
  };
}

export function validateDevelopmentSpec(value: unknown): DevelopmentSpec {
  if (!isRecord(value)) {
    throw new Error("Spec must be an object.");
  }

  const spec = value as Partial<DevelopmentSpec>;

  readRequiredString(spec.id, "Spec id", 200);
  readRequiredString(spec.projectId, "Spec projectId", 200);
  readRequiredString(spec.conversationId, "Spec conversationId", 200);
  const kind = spec.kind;
  const status = spec.status;

  if (kind !== "initial_build" && kind !== "feature") {
    throw new Error("Spec kind is invalid.");
  }

  if (typeof status !== "string" || !SPEC_STATUSES.has(status)) {
    throw new Error("Spec status is invalid.");
  }

  const createdAt = readRequiredString(spec.createdAt, "Spec createdAt", 80);
  const updatedAt = readRequiredString(spec.updatedAt, "Spec updatedAt", 80);
  assertIsoTimestamp(createdAt, "Spec createdAt");
  assertIsoTimestamp(updatedAt, "Spec updatedAt");

  if (new Date(updatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error("Spec updatedAt cannot be before createdAt.");
  }

  if (spec.completedAt !== undefined) {
    assertIsoTimestamp(spec.completedAt, "Spec completedAt");
  }

  if (spec.cancelledAt !== undefined) {
    assertIsoTimestamp(spec.cancelledAt, "Spec cancelledAt");
  }

  if (spec.status !== "completed" && spec.completedAt !== undefined) {
    throw new Error("Spec completedAt is only valid for completed Specs.");
  }

  if (spec.status !== "cancelled" && spec.cancelledAt !== undefined) {
    throw new Error("Spec cancelledAt is only valid for cancelled Specs.");
  }

  if (spec.status === "cancelled" && !spec.cancelledAt) {
    throw new Error("Cancelled Spec requires cancelledAt.");
  }

  if (spec.failureMessage !== undefined && typeof spec.failureMessage !== "string") {
    throw new Error("Spec failureMessage must be a string.");
  }

  if (spec.finalVerification !== undefined) {
    validateFinalVerification(spec.finalVerification);
  }

  if (spec.status === "completed" && (!spec.completedAt || !spec.finalVerification?.success)) {
    throw new Error("Completed Spec requires completedAt and successful finalVerification.");
  }

  const revisions = readArray(spec.revisions, "Spec revisions");

  if (revisions.length === 0) {
    throw new Error("Spec must include at least one revision.");
  }

  const validatedRevisions = revisions.map((revision) =>
    validateRevision(revision, kind),
  );
  const revisionIds = assertUnique(
    validatedRevisions.map((revision) => revision.id),
    "revision id",
  );
  const currentRevisionId = readRequiredString(
    spec.currentRevisionId,
    "Spec currentRevisionId",
    200,
  );

  if (!revisionIds.has(currentRevisionId)) {
    throw new Error("Spec currentRevisionId must reference a revision.");
  }

  validatedRevisions.forEach((revision, index) => {
    if (revision.version !== index + 1) {
      throw new Error("Spec revision versions must be consecutive.");
    }
  });

  const currentRevision = validatedRevisions.find(
    (revision) => revision.id === currentRevisionId,
  );

  if (!currentRevision) {
    throw new Error("Spec currentRevisionId must reference a revision.");
  }

  validateSpecTaskStateConsistency(
    status as DevelopmentSpec["status"],
    currentRevision,
  );

  return value as DevelopmentSpec;
}

export function validateSpecForApproval(spec: DevelopmentSpec): SpecRevision {
  if (spec.status !== "review") {
    throw new Error("Spec must be in review before approval.");
  }

  const revision = getCurrentSpecRevision(validateDevelopmentSpec(spec));

  if (revision.requirements.unresolvedQuestions.length > 0) {
    throw new Error("Spec has unresolved questions.");
  }

  validateRevision(revision, spec.kind);
  return revision;
}

export function computeAcceptanceResults(
  revision: SpecRevision,
  verificationReportsByRunId: Map<string, "passed" | "failed" | "pending">,
): SpecAcceptanceResult[] {
  return revision.requirements.acceptanceCriteria.map((criterion) => {
    const linkedTasks = revision.tasks.filter((task) =>
      task.acceptanceCriteriaIds.includes(criterion.id),
    );
    const runIds = linkedTasks
      .map((task) => task.runId)
      .filter((runId): runId is string => typeof runId === "string");

    if (criterion.required && linkedTasks.length === 0) {
      return {
        criterionId: criterion.id,
        runIds,
        status: "failed" as const,
        summary: "No task covers this required criterion.",
        taskIds: [],
      };
    }

    if (
      linkedTasks.some((task) =>
        ["failed", "cancelled", "blocked"].includes(task.status),
      )
    ) {
      return {
        criterionId: criterion.id,
        runIds,
        status: "failed" as const,
        taskIds: linkedTasks.map((task) => task.id),
      };
    }

    const failedRunIds = runIds.filter(
      (runId) => verificationReportsByRunId.get(runId) === "failed",
    );

    if (failedRunIds.length > 0) {
      return {
        criterionId: criterion.id,
        runIds,
        status: "failed" as const,
        summary: `Verification report failed for run(s): ${failedRunIds.join(", ")}.`,
        taskIds: linkedTasks.map((task) => task.id),
      };
    }

    const allPassed = linkedTasks.length > 0 && linkedTasks.every((task) => {
      if (task.status !== "passed" || !task.runId) {
        return false;
      }

      return verificationReportsByRunId.get(task.runId) === "passed";
    });

    return {
      criterionId: criterion.id,
      runIds,
      status: allPassed ? "passed" : "pending",
      taskIds: linkedTasks.map((task) => task.id),
    };
  });
}

export function computePersistedAcceptanceResults(
  spec: DevelopmentSpec,
): SpecAcceptanceResult[] {
  const revision = getCurrentSpecRevision(spec);
  const verificationReports = new Map<string, "passed" | "failed" | "pending">();
  const acceptanceEvidencePassed =
    spec.finalVerification?.success === true ||
    (spec.finalVerification?.success === false &&
      spec.finalVerification.command !== "acceptance criteria");
  const allTaskRunsCompleted = revision.tasks.every(
    (task) => task.status === "passed" && Boolean(task.runId),
  );

  if (acceptanceEvidencePassed && allTaskRunsCompleted) {
    for (const task of revision.tasks) {
      if (task.runId) {
        verificationReports.set(task.runId, "passed");
      }
    }
  }

  return computeAcceptanceResults(revision, verificationReports).map((result) =>
    enrichPersistedAcceptanceResult(spec, revision, result),
  );
}

function enrichPersistedAcceptanceResult(
  spec: DevelopmentSpec,
  revision: SpecRevision,
  result: SpecAcceptanceResult,
): SpecAcceptanceResult {
  const linkedTasks = revision.tasks.filter((task) =>
    result.taskIds.includes(task.id),
  );
  const taskFailures = linkedTasks
    .filter((task) => ["failed", "cancelled", "blocked"].includes(task.status))
    .map((task) => `${task.id}: ${task.error || task.status}`);
  const finalVerificationOutput = spec.finalVerification?.output.trim();
  const criterionFailedFinalVerification =
    spec.finalVerification?.success === false &&
    spec.finalVerification.command === "acceptance criteria" &&
    finalVerificationOutput?.includes(result.criterionId);

  if (taskFailures.length > 0) {
    return {
      ...result,
      summary: taskFailures.join("\n"),
    };
  }

  if (criterionFailedFinalVerification) {
    return {
      ...result,
      status: "failed",
      summary: finalVerificationOutput,
    };
  }

  if (result.summary) {
    return result;
  }

  if (result.status === "pending") {
    return {
      ...result,
      summary: finalVerificationOutput ||
        "Waiting for verification report evidence from linked task runs.",
    };
  }

  return result;
}

function validateRevision(
  value: unknown,
  kind: DevelopmentSpec["kind"],
): SpecRevision {
  if (!isRecord(value)) {
    throw new Error("Spec revision must be an object.");
  }

  const revision = value as Partial<SpecRevision>;
  readRequiredString(revision.id, "Spec revision id", 200);
  readRequiredString(revision.brief, "Spec revision brief", 4000);
  const version = revision.version;

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("Spec revision version must be a positive integer.");
  }

  assertIsoTimestamp(revision.createdAt, "Spec revision createdAt");

  if (revision.approvedAt !== undefined) {
    assertIsoTimestamp(revision.approvedAt, "Spec revision approvedAt");
  }

  const requirements = validatePersistedRequirements(revision.requirements);
  validatePersistedDesign(revision.design);
  const tasks = readArray(revision.tasks, "Spec revision tasks").map(
    validatePersistedTask,
  );

  if (tasks.length === 0) {
    throw new Error("Spec requires at least one task.");
  }

  validateRevisionParts(requirements, tasks);

  if (kind === "initial_build") {
    const hasBootstrapTask = tasks.some((task) =>
      /\b(package\.json|next|bootstrap|initial|scaffold|foundation|base)\b/i.test(
        [task.title, task.objective, ...task.expectedFiles].join(" "),
      ),
    );

    if (!hasBootstrapTask) {
      throw new Error(
        "Initial Build Spec must include a foundation project creation task.",
      );
    }
  }

  return value as SpecRevision;
}

function validatePersistedRequirements(value: unknown): SpecRequirements {
  if (!isRecord(value)) {
    throw new Error("Spec requirements must be an object.");
  }

  const userStories = readArray(
    value.userStories,
    "Spec requirements.userStories",
  ).map((story) => {
    if (!isRecord(story)) {
      throw new Error("Spec user story must be an object.");
    }

    return {
      description: readRequiredString(
        story.description,
        "Spec userStory.description",
        1200,
      ),
      id: readIdentifier(story.id, "Spec userStory.id"),
    };
  });
  const acceptanceCriteria = readArray(
    value.acceptanceCriteria,
    "Spec requirements.acceptanceCriteria",
  ).map((criterion) => {
    if (!isRecord(criterion)) {
      throw new Error("Spec acceptance criterion must be an object.");
    }

    if (typeof criterion.required !== "boolean") {
      throw new Error("Spec acceptanceCriterion.required must be a boolean.");
    }

    return {
      description: readRequiredString(
        criterion.description,
        "Spec acceptanceCriterion.description",
        1600,
      ),
      id: readIdentifier(criterion.id, "Spec acceptanceCriterion.id"),
      required: criterion.required,
    };
  });

  return {
    acceptanceCriteria,
    constraints: readStringArray(value.constraints, "Spec requirements.constraints"),
    goal: readRequiredString(value.goal, "Spec requirements.goal", 2000),
    outOfScope: readStringArray(value.outOfScope, "Spec requirements.outOfScope"),
    unresolvedQuestions: readStringArray(
      value.unresolvedQuestions,
      "Spec requirements.unresolvedQuestions",
    ),
    userStories,
  };
}

function validatePersistedDesign(value: unknown): SpecDesign {
  if (!isRecord(value)) {
    throw new Error("Spec design must be an object.");
  }

  readArray(value.pages, "Spec design.pages").forEach((page) => {
    if (!isRecord(page)) {
      throw new Error("Spec design page must be an object.");
    }

    readRequiredString(page.route, "Spec design.pages.route", 200);
    readRequiredString(page.purpose, "Spec design.pages.purpose", 1000);
  });
  readArray(value.components, "Spec design.components").forEach((component) => {
    if (!isRecord(component)) {
      throw new Error("Spec design component must be an object.");
    }

    readRequiredString(component.name, "Spec design.components.name", 160);
    readRequiredString(
      component.responsibility,
      "Spec design.components.responsibility",
      1000,
    );
  });

  return {
    components: value.components as SpecDesign["components"],
    dataModel: readStringArray(value.dataModel, "Spec design.dataModel"),
    integrations: readStringArray(value.integrations, "Spec design.integrations"),
    pages: value.pages as SpecDesign["pages"],
    summary: readRequiredString(value.summary, "Spec design.summary", 3000),
    technicalDecisions: readStringArray(
      value.technicalDecisions,
      "Spec design.technicalDecisions",
    ),
    verificationStrategy: readStringArray(
      value.verificationStrategy,
      "Spec design.verificationStrategy",
    ),
  };
}

function validatePersistedTask(value: unknown): SpecTask {
  if (!isRecord(value)) {
    throw new Error("Spec task must be an object.");
  }

  const id = readIdentifier(value.id, "Spec task.id");
  const status = value.status;

  if (typeof status !== "string" || !TASK_STATUSES.has(status)) {
    throw new Error(`Task ${id} has invalid status.`);
  }

  if (value.runId !== undefined && (typeof value.runId !== "string" || !value.runId.trim())) {
    throw new Error(`Task ${id} runId must be a non-empty string.`);
  }

  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error(`Task ${id} error must be a string.`);
  }

  if (
    value.blockedByTaskId !== undefined &&
    (typeof value.blockedByTaskId !== "string" || !value.blockedByTaskId.trim())
  ) {
    throw new Error(`Task ${id} blockedByTaskId must be a non-empty string.`);
  }

  return {
    acceptanceCriteriaIds: readIdentifierArray(
      value.acceptanceCriteriaIds,
      "Spec task.acceptanceCriteriaIds",
    ),
    allowedPaths: readPathArray(value.allowedPaths, "Spec task.allowedPaths"),
    blockedByTaskId: value.blockedByTaskId as string | undefined,
    dependencyIds: readIdentifierArray(value.dependencyIds, "Spec task.dependencyIds", {
      allowEmpty: true,
    }),
    error: value.error as string | undefined,
    expectedFiles: readPathArray(value.expectedFiles, "Spec task.expectedFiles", {
      allowEmpty: true,
    }),
    id,
    objective: readRequiredString(value.objective, "Spec task.objective", 3000),
    requirementIds: readIdentifierArray(value.requirementIds, "Spec task.requirementIds"),
    runId: value.runId as string | undefined,
    status: status as SpecTask["status"],
    title: readRequiredString(value.title, "Spec task.title", 240),
  };
}

function validateSpecTaskStateConsistency(
  status: DevelopmentSpec["status"],
  currentRevision: SpecRevision,
) {
  const taskMissingPassedRun = currentRevision.tasks.find(
    (task) => task.status !== "passed" || !task.runId,
  );

  if ((status === "completed" || status === "verifying") && taskMissingPassedRun) {
    throw new Error(
      `${formatSpecStatus(status)} Spec requires all current revision tasks to be passed with runId.`,
    );
  }

  if (
    ["completed", "failed", "cancelled"].includes(status) &&
    currentRevision.tasks.some((task) => task.status === "running")
  ) {
    throw new Error("Terminal Spec cannot include running tasks.");
  }
}

function formatSpecStatus(status: DevelopmentSpec["status"]) {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function validateFinalVerification(finalVerification: unknown) {
  if (!isRecord(finalVerification)) {
    throw new Error("Spec finalVerification must be an object.");
  }

  if (
    typeof finalVerification.command !== "string" ||
    !finalVerification.command.trim()
  ) {
    throw new Error("Spec finalVerification.command is required.");
  }

  if (typeof finalVerification.output !== "string") {
    throw new Error("Spec finalVerification.output must be a string.");
  }

  if (typeof finalVerification.success !== "boolean") {
    throw new Error("Spec finalVerification.success must be a boolean.");
  }

  assertIsoTimestamp(
    finalVerification.checkedAt,
    "Spec finalVerification.checkedAt",
  );
}

function validateRevisionParts(
  requirements: SpecRequirements,
  tasks: Array<
    Pick<
      SpecTask,
      | "id"
      | "requirementIds"
      | "acceptanceCriteriaIds"
      | "dependencyIds"
      | "allowedPaths"
    >
  >,
) {
  if (!requirements.goal.trim()) {
    throw new Error("Spec requirements.goal is required.");
  }

  if (requirements.userStories.length === 0) {
    throw new Error("Spec requires at least one user story.");
  }

  if (requirements.acceptanceCriteria.length === 0) {
    throw new Error("Spec requires at least one acceptance criterion.");
  }

  const requirementIds = assertUnique(
    requirements.userStories.map((story) => story.id),
    "user story id",
  );
  const criterionIds = assertUnique(
    requirements.acceptanceCriteria.map((criterion) => criterion.id),
    "acceptance criterion id",
  );
  const taskIds = assertUnique(tasks.map((task) => task.id), "task id");

  for (const task of tasks) {
    if (task.allowedPaths.length === 0) {
      throw new Error(`Task ${task.id} must include allowedPaths.`);
    }

    for (const requirementId of task.requirementIds) {
      if (!requirementIds.has(requirementId)) {
        throw new Error(`Task ${task.id} references unknown requirement ${requirementId}.`);
      }
    }

    for (const criterionId of task.acceptanceCriteriaIds) {
      if (!criterionIds.has(criterionId)) {
        throw new Error(
          `Task ${task.id} references unknown acceptance criterion ${criterionId}.`,
        );
      }
    }

    for (const dependencyId of task.dependencyIds) {
      if (dependencyId === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself.`);
      }

      if (!taskIds.has(dependencyId)) {
        throw new Error(`Task ${task.id} references unknown dependency ${dependencyId}.`);
      }
    }
  }

  assertAcyclic(tasks);

  for (const criterion of requirements.acceptanceCriteria) {
    if (!criterion.required) {
      continue;
    }

    const covered = tasks.some((task) =>
      task.acceptanceCriteriaIds.includes(criterion.id),
    );

    if (!covered) {
      throw new Error(
        `Required acceptance criterion ${criterion.id} is not covered by any task.`,
      );
    }
  }
}

function validateRequirements(value: unknown): SpecRequirements {
  if (!isRecord(value)) {
    throw new Error("Invalid spec response: requirements must be an object.");
  }

  const userStories = readArray(value.userStories, "requirements.userStories")
    .map((story) => {
      if (!isRecord(story)) {
        throw new Error("Invalid spec response: user story must be an object.");
      }

      return {
        description: readRequiredString(story.description, "userStory.description", 1200),
        id: readIdentifier(story.id, "userStory.id"),
      };
    });
  const acceptanceCriteria = readArray(
    value.acceptanceCriteria,
    "requirements.acceptanceCriteria",
  ).map((criterion) => {
    if (!isRecord(criterion)) {
      throw new Error("Invalid spec response: acceptance criterion must be an object.");
    }

    return {
      description: readRequiredString(
        criterion.description,
        "acceptanceCriterion.description",
        1600,
      ),
      id: readIdentifier(criterion.id, "acceptanceCriterion.id"),
      required:
        typeof criterion.required === "boolean" ? criterion.required : true,
    };
  });

  return {
    acceptanceCriteria,
    constraints: readStringArray(value.constraints, "requirements.constraints"),
    goal: readRequiredString(value.goal, "requirements.goal", 2000),
    outOfScope: readStringArray(value.outOfScope, "requirements.outOfScope"),
    unresolvedQuestions: readStringArray(
      value.unresolvedQuestions,
      "requirements.unresolvedQuestions",
    ),
    userStories,
  };
}

function validateDesign(value: unknown): SpecDesign {
  if (!isRecord(value)) {
    throw new Error("Invalid spec response: design must be an object.");
  }

  const pages = readArray(value.pages, "design.pages").map((page) => {
    if (!isRecord(page)) {
      throw new Error("Invalid spec response: design page must be an object.");
    }

    return {
      purpose: readRequiredString(page.purpose, "design.pages.purpose", 1000),
      route: readRequiredString(page.route, "design.pages.route", 200),
    };
  });
  const components = readArray(value.components, "design.components").map(
    (component) => {
      if (!isRecord(component)) {
        throw new Error("Invalid spec response: design component must be an object.");
      }

      return {
        name: readRequiredString(component.name, "design.components.name", 160),
        responsibility: readRequiredString(
          component.responsibility,
          "design.components.responsibility",
          1000,
        ),
      };
    },
  );

  return {
    components,
    dataModel: readStringArray(value.dataModel, "design.dataModel"),
    integrations: readStringArray(value.integrations, "design.integrations"),
    pages,
    summary: readRequiredString(value.summary, "design.summary", 3000),
    technicalDecisions: readStringArray(
      value.technicalDecisions,
      "design.technicalDecisions",
    ),
    verificationStrategy: readStringArray(
      value.verificationStrategy,
      "design.verificationStrategy",
    ),
  };
}

function validateGeneratedTask(
  value: unknown,
): Omit<SpecTask, "status" | "runId" | "error" | "blockedByTaskId"> {
  if (!isRecord(value)) {
    throw new Error("Invalid spec response: task must be an object.");
  }

  return {
    acceptanceCriteriaIds: readIdentifierArray(
      value.acceptanceCriteriaIds,
      "task.acceptanceCriteriaIds",
    ),
    allowedPaths: readPathArray(value.allowedPaths, "task.allowedPaths"),
    dependencyIds: readIdentifierArray(value.dependencyIds, "task.dependencyIds", {
      allowEmpty: true,
    }),
    expectedFiles: readPathArray(value.expectedFiles, "task.expectedFiles", {
      allowEmpty: true,
    }),
    id: readIdentifier(value.id, "task.id"),
    objective: readRequiredString(value.objective, "task.objective", 3000),
    requirementIds: readIdentifierArray(value.requirementIds, "task.requirementIds"),
    title: readRequiredString(value.title, "task.title", 240),
  };
}

function assertUnique(values: string[], label: string) {
  const seen = new Set<string>();

  for (const value of values) {
    if (!value.trim()) {
      throw new Error(`Spec ${label} is required.`);
    }

    if (seen.has(value)) {
      throw new Error(`Duplicate Spec ${label}: ${value}.`);
    }

    seen.add(value);
  }

  return seen;
}

function assertIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
}

function assertAcyclic(
  tasks: Array<Pick<SpecTask, "id" | "dependencyIds">>,
) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string) {
    if (visited.has(taskId)) {
      return;
    }

    if (visiting.has(taskId)) {
      throw new Error("Spec task dependency graph contains a cycle.");
    }

    visiting.add(taskId);

    for (const dependencyId of byId.get(taskId)?.dependencyIds ?? []) {
      visit(dependencyId);
    }

    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }
}

function readIdentifier(value: unknown, label: string) {
  const text = readRequiredString(value, label, 120);

  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`${label} may include only letters, numbers, dash, or underscore.`);
  }

  return text;
}

function readIdentifierArray(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
) {
  const values = readArray(value, label);

  if (!options.allowEmpty && values.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return values.map((item) => readIdentifier(item, label));
}

function readPathArray(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
) {
  const values = readStringArray(value, label);

  if (!options.allowEmpty && values.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  for (const path of values) {
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`${label} contains a forbidden path: ${path}.`);
    }
  }

  return values;
}

function readStringArray(value: unknown, label: string) {
  return readArray(value, label).map((item) =>
    readRequiredString(item, label, 1600),
  );
}

function readArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }

  const text = value.trim();

  if (text.length > maxLength) {
    throw new Error(`${label} may include at most ${maxLength} characters.`);
  }

  return text;
}
