import type { TaskContract, TaskType } from "../types";

export const AGENT_CONTEXT_BUDGET = {
  normalContextChars: 180_000,
  criticalContextChars: 120_000,
} as const;

export const AGENT_TASK_BUDGETS: Record<TaskType, TaskContract["budget"]> = {
  answer: {
    maxModelTurns: 8,
    maxToolCalls: 16,
    maxMutations: 0,
    maxRepairCycles: 0,
  },
  copy_edit: {
    maxModelTurns: 24,
    maxToolCalls: 70,
    maxMutations: 18,
    maxRepairCycles: 5,
  },
  style_edit: {
    maxModelTurns: 28,
    maxToolCalls: 90,
    maxMutations: 24,
    maxRepairCycles: 6,
  },
  component_edit: {
    maxModelTurns: 28,
    maxToolCalls: 90,
    maxMutations: 24,
    maxRepairCycles: 6,
  },
  add_page: {
    maxModelTurns: 40,
    maxToolCalls: 150,
    maxMutations: 48,
    maxRepairCycles: 8,
  },
  backend_feature: {
    maxModelTurns: 56,
    maxToolCalls: 220,
    maxMutations: 72,
    maxRepairCycles: 12,
  },
  full_site: {
    maxModelTurns: 48,
    maxToolCalls: 180,
    maxMutations: 60,
    maxRepairCycles: 10,
  },
  deployment: {
    maxModelTurns: 12,
    maxToolCalls: 32,
    maxMutations: 4,
    maxRepairCycles: 2,
  },
};
