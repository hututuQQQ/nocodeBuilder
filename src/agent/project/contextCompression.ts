import type {
  AgentBudgetState,
  AgentRun,
} from "../../agent-core/types";
import { AGENT_CONTEXT_BUDGET } from "../../agent-core/budget/agentBudget";
import type {
  AgentObservation,
  AgentStepContext,
  CompactSpecContext,
  ContextCompressionReport,
} from "./types";

export const CONTEXT_ENVELOPE_CHAR_BUDGET =
  AGENT_CONTEXT_BUDGET.normalContextChars;
export const CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET =
  AGENT_CONTEXT_BUDGET.criticalContextChars;

const FILE_TREE_CHAR_BUDGET = 8_000;
const DIAGNOSTICS_CHAR_BUDGET = 6_000;
const OBSERVATION_CONTENT_CHAR_BUDGET = 4_000;
const FAILURE_OBSERVATION_CONTENT_CHAR_BUDGET = 6_000;
const COMPACT_OBSERVATION_CONTENT_CHAR_BUDGET = 1_200;
const CONTEXT_REPORT_CHAR_BUFFER = 800;

export function buildAgentBudgetState(run: AgentRun): AgentBudgetState {
  const modelTurns = buildBudgetMetric(run.modelTurns, run.contract.budget.maxModelTurns);
  const toolCalls = buildBudgetMetric(run.toolCalls, run.contract.budget.maxToolCalls);
  const mutations = buildBudgetMetric(run.mutationCount, run.contract.budget.maxMutations);
  const repairCycles = buildBudgetMetric(run.repairCycles, run.contract.budget.maxRepairCycles);
  const remainingValues = [
    modelTurns.remaining,
    toolCalls.remaining,
    mutations.remaining,
    repairCycles.remaining,
  ];
  const pressure = remainingValues.some((remaining) => remaining <= 1)
    ? "critical"
    : remainingValues.some((remaining) => remaining <= 2)
      ? "low"
      : "normal";

  return {
    modelTurns,
    mutations,
    pressure,
    repairCycles,
    toolCalls,
  };
}

export function compressAgentStepContext(context: AgentStepContext): AgentStepContext {
  const rawChars = estimateContextChars(context);
  let next: AgentStepContext = {
    ...context,
    backend: compactBackendContext(context.backend),
    contextReport: createContextReport(rawChars, 0, context),
    diagnostics: compactNullableText(context.diagnostics, DIAGNOSTICS_CHAR_BUDGET),
    fileTree: compactNullableText(context.fileTree, FILE_TREE_CHAR_BUDGET),
    manifest: context.manifest,
    memory: context.memory
      ? {
          ...context.memory,
          designConventions: compactTextArray(context.memory.designConventions, 8, 260),
          fileSummaries: context.memory.fileSummaries.slice(-24).map((summary) => ({
            ...summary,
            summary: compactText(summary.summary, 360),
          })),
          recentChanges: compactTextArray(context.memory.recentChanges, 8, 260),
          structureSummary: compactText(context.memory.structureSummary, 700),
        }
      : null,
    observations: selectPromptObservations(context.observations),
    recentMessages: context.recentMessages.slice(-6).map((message) => ({
      ...message,
      content: compactText(message.content, 1_400),
    })),
    runContextSummary: {
      ...context.runContextSummary,
      completed: compactTextArray(context.runContextSummary.completed, 10, 300),
      decisions: compactTextArray(context.runContextSummary.decisions, 10, 320),
      importantFiles: context.runContextSummary.importantFiles.slice(-32),
      latestFailures: compactTextArray(context.runContextSummary.latestFailures, 8, 420),
      nextStep: compactText(context.runContextSummary.nextStep, 420),
      objective: compactText(context.runContextSummary.objective, 600),
    },
    specContext: context.specContext ? compactSpecContext(context.specContext) : undefined,
    taskLedger: context.taskLedger
      ? {
          ...context.taskLedger,
          completed: compactTextArray(context.taskLedger.completed, 8, 260),
          nextStep: compactText(context.taskLedger.nextStep, 360),
          objective: compactText(context.taskLedger.objective, 420),
          pending: compactTextArray(context.taskLedger.pending, 8, 260),
          risks: compactTextArray(context.taskLedger.risks, 8, 320),
        }
      : null,
    workingSummary: context.workingSummary
      ? {
          ...context.workingSummary,
          errors: compactTextArray(context.workingSummary.errors, 6, 320),
          importantFindings: compactTextArray(
            context.workingSummary.importantFindings,
            8,
            260,
          ),
          summary: compactText(context.workingSummary.summary, 700),
        }
      : null,
  };

  const envelopeBudget = getContextEnvelopeBudget(context);
  next = fitContextWithinBudget(
    next,
    Math.max(1_000, envelopeBudget - CONTEXT_REPORT_CHAR_BUFFER),
  );
  next = finalizeContextReport(next, rawChars);

  if (estimateContextChars(next) > envelopeBudget) {
    next = fitContextWithinBudget(
      next,
      Math.max(1_000, envelopeBudget - CONTEXT_REPORT_CHAR_BUFFER * 2),
    );
    next = finalizeContextReport(next, rawChars);
  }

  return next;
}

function buildBudgetMetric(used: number, max: number) {
  return {
    max,
    remaining: Math.max(0, max - used),
    used,
  };
}

function fitContextWithinBudget(context: AgentStepContext, maxChars: number) {
  let next = context;

  if (estimateContextChars(next) <= maxChars) {
    return next;
  }

  next = {
    ...next,
    observations: next.observations.map((observation) => ({
      ...observation,
      content: observation.content
        ? compactText(observation.content, COMPACT_OBSERVATION_CONTENT_CHAR_BUDGET)
        : undefined,
    })),
  };

  while (
    estimateContextChars(next) > maxChars &&
    next.observations.length > 3
  ) {
    const removableIndex = next.observations.findIndex(
      (observation, index) =>
        index < next.observations.length - 1 && observation.ok,
    );

    if (removableIndex < 0) {
      break;
    }

    next = {
      ...next,
      observations: [
        ...next.observations.slice(0, removableIndex),
        ...next.observations.slice(removableIndex + 1),
      ],
    };
  }

  const reducers: Array<(value: AgentStepContext) => AgentStepContext> = [
    (value) => ({ ...value, diagnostics: null }),
    (value) => ({ ...value, fileTree: null }),
    compactMemoryForHardCap,
    compactBackendForHardCap,
    compactRelatedTasksForHardCap,
    compactSpecDesignForHardCap,
    compactObservationsForHardCap,
    createMinimalContextForHardCap,
  ];

  for (const reducer of reducers) {
    if (estimateContextChars(next) <= maxChars) {
      return next;
    }

    next = reducer(next);
  }

  return next;
}

function compactMemoryForHardCap(context: AgentStepContext): AgentStepContext {
  if (!context.memory) {
    return context;
  }

  return {
    ...context,
    memory: {
      ...context.memory,
      designConventions: compactTextArray(context.memory.designConventions, 4, 160),
      fileSummaries: context.memory.fileSummaries.slice(-8).map((summary) => ({
        ...summary,
        summary: compactText(summary.summary, 180),
      })),
      projectIndex: {
        ...context.memory.projectIndex,
        components: context.memory.projectIndex.components.slice(-12),
        dataFiles: context.memory.projectIndex.dataFiles.slice(-12),
        dependencies: context.memory.projectIndex.dependencies.slice(-12),
        libFiles: context.memory.projectIndex.libFiles.slice(-12),
        routes: context.memory.projectIndex.routes.slice(-12),
      },
      recentChanges: compactTextArray(context.memory.recentChanges, 4, 160),
      structureSummary: compactText(context.memory.structureSummary, 260),
      techStack: context.memory.techStack.slice(0, 12),
    },
  };
}

function compactBackendForHardCap(context: AgentStepContext): AgentStepContext {
  if (!context.backend) {
    return context;
  }

  return {
    ...context,
    backend: {
      ...context.backend,
      recommendedPatterns: compactTextArray(context.backend.recommendedPatterns, 4, 160),
      supabase: {
        ...context.backend.supabase,
        notes: compactTextArray(context.backend.supabase.notes, 4, 160),
        schemaLoadError: context.backend.supabase.schemaLoadError
          ? compactText(context.backend.supabase.schemaLoadError, 220)
          : undefined,
        tables: context.backend.supabase.tables.slice(0, 6).map((table) => ({
          ...table,
          columns: table.columns.slice(0, 8),
        })),
      },
    },
  };
}

function compactRelatedTasksForHardCap(context: AgentStepContext): AgentStepContext {
  if (!context.specContext) {
    return context;
  }

  return {
    ...context,
    specContext: {
      ...context.specContext,
      relatedTasks: context.specContext.relatedTasks.slice(-4).map((task) => ({
        ...task,
        title: compactText(task.title, 120),
      })),
    },
  };
}

function compactSpecDesignForHardCap(context: AgentStepContext): AgentStepContext {
  if (!context.specContext) {
    return context;
  }

  return {
    ...context,
    specContext: {
      ...context.specContext,
      design: {
        dataModel: compactTextArray(context.specContext.design.dataModel, 4, 160),
        integrations: compactTextArray(context.specContext.design.integrations, 4, 160),
        summary: compactText(context.specContext.design.summary, 260),
        technicalDecisions: compactTextArray(
          context.specContext.design.technicalDecisions,
          4,
          160,
        ),
        verificationStrategy: compactTextArray(
          context.specContext.design.verificationStrategy,
          4,
          160,
        ),
      },
    },
  };
}

function compactObservationsForHardCap(context: AgentStepContext): AgentStepContext {
  const selected = new Map<number, AgentObservation>();
  const important = context.observations.filter(
    (observation) =>
      !observation.ok ||
      observation.tool === "loop_rescue" ||
      observation.tool === "model_validation",
  );

  for (const observation of [...important.slice(-4), ...context.observations.slice(-3)]) {
    selected.set(observation.step, {
      ...observation,
      content: observation.content ? compactText(observation.content, 500) : undefined,
      summary: compactText(observation.summary, 180),
    });
  }

  return {
    ...context,
    observations: Array.from(selected.values()).sort((left, right) => left.step - right.step),
  };
}

function createMinimalContextForHardCap(context: AgentStepContext): AgentStepContext {
  return {
    ...context,
    backend: context.backend
      ? {
          ...context.backend,
          recommendedPatterns: [],
          supabase: {
            ...context.backend.supabase,
            notes: [],
            schemaLoadError: context.backend.supabase.schemaLoadError
              ? compactText(context.backend.supabase.schemaLoadError, 120)
              : undefined,
            tables: [],
          },
        }
      : null,
    diagnostics: null,
    fileTree: null,
    memory: null,
    observations: compactObservationsForHardCap(context).observations.slice(-2),
    recentMessages: context.recentMessages.slice(-2).map((message) => ({
      ...message,
      content: compactText(message.content, 500),
    })),
    runContextSummary: {
      ...context.runContextSummary,
      changedFiles: context.runContextSummary.changedFiles.slice(-12),
      completed: compactTextArray(context.runContextSummary.completed, 3, 140),
      decisions: compactTextArray(context.runContextSummary.decisions, 3, 140),
      deletedFiles: context.runContextSummary.deletedFiles.slice(-12),
      importantFiles: context.runContextSummary.importantFiles.slice(-12),
      latestFailures: compactTextArray(context.runContextSummary.latestFailures, 3, 180),
      nextStep: compactText(context.runContextSummary.nextStep, 260),
      objective: compactText(context.runContextSummary.objective, 260),
    },
    specContext: context.specContext
      ? {
          ...context.specContext,
          acceptanceCriteria: selectRelevantSpecRequirements(context.specContext)
            .primaryAcceptanceCriteria
            .concat(selectRelevantSpecRequirements(context.specContext).secondaryAcceptanceCriteria.slice(0, 6))
            .map((criterion) => ({
              ...criterion,
              description: compactText(criterion.description, 180),
            })),
          brief: compactText(context.specContext.brief, 220),
          currentTask: {
            ...context.specContext.currentTask,
            allowedPaths: context.specContext.currentTask.allowedPaths.slice(0, 8),
            expectedFiles: context.specContext.currentTask.expectedFiles.slice(0, 8),
            objective: compactText(context.specContext.currentTask.objective, 260),
            title: compactText(context.specContext.currentTask.title, 120),
          },
          design: {
            dataModel: [],
            integrations: [],
            summary: compactText(context.specContext.design.summary, 160),
            technicalDecisions: [],
            verificationStrategy: [],
          },
          goal: compactText(context.specContext.goal, 220),
          relatedTasks: [],
          requirements: selectRelevantSpecRequirements(context.specContext)
            .primaryRequirements
            .concat(selectRelevantSpecRequirements(context.specContext).secondaryRequirements.slice(0, 6))
            .map((requirement) => ({
              ...requirement,
              description: compactText(requirement.description, 160),
            })),
        }
      : undefined,
    steering: context.steering.slice(-3).map((item) => compactText(item, 220)),
    taskLedger: null,
    workingSummary: null,
  };
}

function getContextEnvelopeBudget(context: AgentStepContext) {
  return context.budgetState.pressure === "critical" ||
    context.observations.some((observation) => observation.tool === "loop_rescue")
    ? CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET
    : CONTEXT_ENVELOPE_CHAR_BUDGET;
}

function selectPromptObservations(observations: AgentObservation[]) {
  const selected = new Map<number, AgentObservation>();
  const modelValidationFailures = observations
    .filter((observation) => observation.tool === "model_validation" && !observation.ok)
    .slice(-2);
  const failures = observations.filter((observation) => !observation.ok).slice(-5);
  const recent = observations.slice(-8);

  for (const observation of [...modelValidationFailures, ...failures, ...recent]) {
    const isFailure = !observation.ok;
    selected.set(observation.step, {
      ...observation,
      content: observation.content
        ? compactText(
            observation.content,
            isFailure
              ? FAILURE_OBSERVATION_CONTENT_CHAR_BUDGET
              : OBSERVATION_CONTENT_CHAR_BUDGET,
          )
        : undefined,
      summary: compactText(observation.summary, 420),
    });
  }

  return Array.from(selected.values()).sort((left, right) => left.step - right.step);
}

function compactBackendContext(context: AgentStepContext["backend"]) {
  if (!context) {
    return null;
  }

  return {
    ...context,
    recommendedPatterns: compactTextArray(context.recommendedPatterns, 8, 260),
    supabase: {
      ...context.supabase,
      notes: compactTextArray(context.supabase.notes, 8, 260),
      schemaLoadError: context.supabase.schemaLoadError
        ? compactText(context.supabase.schemaLoadError, 600)
        : undefined,
      tables: context.supabase.tables.slice(0, 14).map((table) => ({
        ...table,
        columns: table.columns.slice(0, 18),
      })),
    },
  };
}

function compactSpecContext(context: CompactSpecContext): CompactSpecContext {
  const selectedRequirements = selectRelevantSpecRequirements(context);
  const requirementBudget = Math.max(
    12,
    selectedRequirements.primaryRequirements.length,
  );
  const criterionBudget = Math.max(
    12,
    selectedRequirements.primaryAcceptanceCriteria.length,
  );

  return {
    ...context,
    acceptanceCriteria: [
      ...selectedRequirements.primaryAcceptanceCriteria,
      ...selectedRequirements.secondaryAcceptanceCriteria.slice(
        0,
        Math.max(0, criterionBudget - selectedRequirements.primaryAcceptanceCriteria.length),
      ),
    ].map((criterion) => ({
      ...criterion,
      description: compactText(criterion.description, 420),
    })),
    brief: compactText(context.brief, 700),
    currentTask: {
      ...context.currentTask,
      allowedPaths: context.currentTask.allowedPaths.slice(0, 24),
      expectedFiles: context.currentTask.expectedFiles.slice(0, 24),
      objective: compactText(context.currentTask.objective, 700),
      title: compactText(context.currentTask.title, 240),
    },
    design: {
      dataModel: compactTextArray(context.design.dataModel, 12, 320),
      integrations: compactTextArray(context.design.integrations, 12, 320),
      summary: compactText(context.design.summary, 900),
      technicalDecisions: compactTextArray(context.design.technicalDecisions, 12, 320),
      verificationStrategy: compactTextArray(context.design.verificationStrategy, 10, 320),
    },
    goal: compactText(context.goal, 700),
    relatedTasks: context.relatedTasks.slice(0, 16).map((task) => ({
      ...task,
      title: compactText(task.title, 220),
    })),
    requirements: [
      ...selectedRequirements.primaryRequirements,
      ...selectedRequirements.secondaryRequirements.slice(
        0,
        Math.max(0, requirementBudget - selectedRequirements.primaryRequirements.length),
      ),
    ].map((requirement) => ({
      ...requirement,
      description: compactText(requirement.description, 420),
    })),
  };
}

function selectRelevantSpecRequirements(context: CompactSpecContext): {
  primaryRequirements: CompactSpecContext["requirements"];
  primaryAcceptanceCriteria: CompactSpecContext["acceptanceCriteria"];
  secondaryRequirements: CompactSpecContext["requirements"];
  secondaryAcceptanceCriteria: CompactSpecContext["acceptanceCriteria"];
} {
  const requirementIds = new Set(context.currentTask.requirementIds);
  const acceptanceCriteriaIds = new Set(context.currentTask.acceptanceCriteriaIds);
  const primaryRequirements = context.requirements.filter((requirement) =>
    requirementIds.has(requirement.id),
  );
  const secondaryRequirements = context.requirements.filter((requirement) =>
    !requirementIds.has(requirement.id),
  );
  const primaryAcceptanceCriteria = context.acceptanceCriteria.filter((criterion) =>
    acceptanceCriteriaIds.has(criterion.id),
  );
  const secondaryAcceptanceCriteria = context.acceptanceCriteria.filter((criterion) =>
    !acceptanceCriteriaIds.has(criterion.id),
  );

  return {
    primaryRequirements,
    primaryAcceptanceCriteria,
    secondaryRequirements,
    secondaryAcceptanceCriteria,
  };
}

function createContextReport(
  rawChars: number,
  finalChars: number,
  context: AgentStepContext,
): ContextCompressionReport {
  return {
    finalChars,
    rawChars,
    retainedObservations: context.observations.length,
    summarizedObservations: Math.max(
      0,
      context.runContextSummary.summarizedObservationCount - context.observations.length,
    ),
  };
}

function finalizeContextReport(
  context: AgentStepContext,
  rawChars: number,
): AgentStepContext {
  let next = {
    ...context,
    contextReport: createContextReport(rawChars, 0, context),
  };

  for (let index = 0; index < 5; index += 1) {
    const measured = estimateContextChars(next);

    if (next.contextReport.finalChars === measured) {
      return next;
    }

    next = {
      ...next,
      contextReport: createContextReport(rawChars, measured, next),
    };
  }

  return {
    ...next,
    contextReport: {
      ...next.contextReport,
      finalChars: estimateContextChars(next),
    },
  };
}

function estimateContextChars(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function compactNullableText(value: string | null, maxLength: number) {
  return value === null ? null : compactText(value, maxLength);
}

function compactTextArray(values: string[], maxItems: number, maxLength: number) {
  return values.slice(-maxItems).map((value) => compactText(value, maxLength));
}

function compactText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength)}\n[truncated for context budget]`;
}
