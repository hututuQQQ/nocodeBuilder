import type {
  AgentBudgetState,
  AgentRun,
} from "../../agent-core/types";
import type {
  AgentObservation,
  AgentStepContext,
  CompactSpecContext,
  ContextCompressionReport,
} from "./types";

export const CONTEXT_ENVELOPE_CHAR_BUDGET = 55_000;
export const CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET = 42_000;

const FILE_TREE_CHAR_BUDGET = 8_000;
const DIAGNOSTICS_CHAR_BUDGET = 6_000;
const OBSERVATION_CONTENT_CHAR_BUDGET = 4_000;
const FAILURE_OBSERVATION_CONTENT_CHAR_BUDGET = 6_000;
const COMPACT_OBSERVATION_CONTENT_CHAR_BUDGET = 1_200;

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

  next = fitContextWithinBudget(next, getContextEnvelopeBudget(next));
  next.contextReport = createContextReport(rawChars, estimateContextChars(next), next);
  next.contextReport = {
    ...next.contextReport,
    finalChars: estimateContextChars(next),
  };

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

  if (estimateContextChars(next) <= maxChars) {
    return next;
  }

  return {
    ...next,
    diagnostics: compactNullableText(next.diagnostics, 2_000),
    fileTree: compactNullableText(next.fileTree, 3_000),
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
  return {
    ...context,
    acceptanceCriteria: context.acceptanceCriteria.slice(0, 12).map((criterion) => ({
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
    requirements: context.requirements.slice(0, 12).map((requirement) => ({
      ...requirement,
      description: compactText(requirement.description, 420),
    })),
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
