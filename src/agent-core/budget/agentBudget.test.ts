import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import {
  AGENT_CONTEXT_BUDGET,
  AGENT_TASK_BUDGETS,
} from "./agentBudget";
import {
  CONTEXT_ENVELOPE_CHAR_BUDGET,
  CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET,
} from "../../agent/project/contextCompression";

describe("agent budget config", () => {
  it("exposes one unified context and task budget table", () => {
    expect(AGENT_CONTEXT_BUDGET).toEqual({
      normalContextChars: 180_000,
      criticalContextChars: 120_000,
    });
    expect(AGENT_TASK_BUDGETS.backend_feature.maxToolCalls).toBe(220);
  });

  it("context compression uses AGENT_CONTEXT_BUDGET", () => {
    expect(CONTEXT_ENVELOPE_CHAR_BUDGET)
      .toBe(AGENT_CONTEXT_BUDGET.normalContextChars);
    expect(CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET)
      .toBe(AGENT_CONTEXT_BUDGET.criticalContextChars);
  });

  it("task contracts use AGENT_TASK_BUDGETS", () => {
    const contract = compileTaskContract({
      objective: "Implement Supabase login API",
    });

    expect(contract.budget).toEqual(AGENT_TASK_BUDGETS.backend_feature);
  });
});
