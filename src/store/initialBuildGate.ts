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
  initialBuildSpec?: DevelopmentSpec | null;
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
  const initialBuild = findInitialBuildSummary(summaries);

  return hasCompletedInitialBuildSpecEvidence(state, projectId, initialBuild);
}

export async function ensureInitialBuildCompletedForIteration(
  projectId: string,
  state: InitialBuildGateState,
) {
  const stateInitialBuild = findInitialBuildSummary(
    state.conversationSummaries.filter(
      (summary) => summary.projectId === projectId,
    ),
  );

  if (hasCompletedInitialBuildSpecEvidence(state, projectId, stateInitialBuild)) {
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

  if (!hasCompletedInitialBuildSpec(projectId, initialBuild, spec)) {
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
    [state.initialBuildSpec, state.currentSpec, ...state.historicalSpecs].find(
      (spec) => spec?.id === summary.activeSpecId,
    ) ?? null
  );
}

function hasCompletedInitialBuildSpecEvidence(
  state: InitialBuildGateState,
  projectId: string,
  summary: ProjectConversationSummary | null,
) {
  if (state.currentProject?.id !== projectId) {
    return false;
  }

  return hasCompletedInitialBuildSpec(
    projectId,
    summary,
    findInitialBuildSpec(state, summary),
  );
}

function hasCompletedInitialBuildSpec(
  projectId: string,
  summary: ProjectConversationSummary | null,
  spec: DevelopmentSpec | null,
) {
  return Boolean(
    summary?.activeSpecId &&
      spec &&
      spec.id === summary.activeSpecId &&
      spec.status === "completed" &&
      spec.projectId === projectId &&
      spec.conversationId === summary.id,
  );
}
