import {
  projectApi,
  type ProjectConversationSummary,
} from "../services/projects";
import { specApi } from "../services/specs";
import type { DevelopmentSpec } from "../spec-core/types";

export const INITIAL_BUILD_ITERATION_GATE_ERROR =
  "conversation: initial build must complete before creating iterations";

type InitialBuildGateState = {
  conversationSummaries: ProjectConversationSummary[];
  currentProject: { id: string } | null;
  currentSpec: DevelopmentSpec | null;
  historicalSpecs: DevelopmentSpec[];
};

export function hasCompletedInitialBuildEvidence(
  state: InitialBuildGateState,
  projectId: string,
) {
  if (state.currentProject?.id !== projectId) {
    return false;
  }

  const summaries = state.conversationSummaries.filter(
    (summary) => summary.projectId === projectId,
  );

  if (summaries.some((summary) => summary.kind === "iteration")) {
    return true;
  }

  const initialBuild = findInitialBuildSummary(summaries);
  const spec = findInitialBuildSpec(state, initialBuild);

  return spec?.status === "completed";
}

export async function ensureInitialBuildCompletedForIteration(
  projectId: string,
  state: InitialBuildGateState,
) {
  if (hasCompletedInitialBuildEvidence(state, projectId)) {
    return;
  }

  const summaries = await projectApi.listProjectConversations(projectId, true);
  const initialBuilds = summaries.filter(
    (summary) => summary.kind === "initial_build",
  );

  if (initialBuilds.length !== 1) {
    throw new Error(INITIAL_BUILD_ITERATION_GATE_ERROR);
  }

  const initialBuild = initialBuilds[0];
  const spec = await readInitialBuildSpecForGate(projectId, initialBuild);

  if (
    !spec ||
    spec.status !== "completed" ||
    spec.projectId !== projectId ||
    spec.conversationId !== initialBuild.id
  ) {
    throw new Error(INITIAL_BUILD_ITERATION_GATE_ERROR);
  }
}

export async function readInitialBuildSpecForGate(
  projectId: string,
  summary: ProjectConversationSummary | null,
) {
  if (!summary?.activeSpecId) {
    return null;
  }

  try {
    return await specApi.readSpec(projectId, summary.activeSpecId);
  } catch {
    return null;
  }
}

function findInitialBuildSummary(summaries: ProjectConversationSummary[]) {
  return summaries.find((summary) => summary.kind === "initial_build") ?? null;
}

function findInitialBuildSpec(
  state: InitialBuildGateState,
  summary: ProjectConversationSummary | null,
) {
  if (!summary?.activeSpecId) {
    return null;
  }

  return (
    [state.currentSpec, ...state.historicalSpecs].find(
      (spec) => spec?.id === summary.activeSpecId,
    ) ?? null
  );
}
