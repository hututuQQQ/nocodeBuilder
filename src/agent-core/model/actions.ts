import type { AgentStepResponse } from "../../agent/project/types";

export type NormalizedModelAction =
  | Exclude<AgentStepResponse, { type: "finish_candidate" }>
  | {
      type: "finish_candidate";
      summary: string;
      verification?: string;
    };

export function normalizeModelAction(action: AgentStepResponse): NormalizedModelAction {
  if (action.type !== "finish_candidate") {
    return action;
  }

  return {
    type: "finish_candidate",
    summary: action.summary,
    verification: action.verification,
  };
}
