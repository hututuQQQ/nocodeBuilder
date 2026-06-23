import type { DevelopmentSpec, SpecStatus } from "./types";

const TERMINAL_STATUSES = new Set<SpecStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const TRANSITIONS: Record<SpecStatus, SpecStatus[]> = {
  approved: ["building", "cancelled"],
  blocked: ["building", "verifying", "cancelled"],
  building: ["verifying", "blocked", "failed", "cancelled"],
  cancelled: [],
  completed: [],
  drafting: ["review", "failed", "cancelled"],
  failed: [],
  review: ["approved", "revising", "cancelled"],
  revising: ["review", "failed", "cancelled"],
  verifying: ["completed", "blocked", "failed", "cancelled"],
};

export function isTerminalSpecStatus(status: SpecStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function getLegalSpecTransitions(status: SpecStatus): SpecStatus[] {
  return TRANSITIONS[status] ?? [];
}

export function transitionSpecStatus(
  spec: DevelopmentSpec,
  nextStatus: SpecStatus,
  options: {
    failureMessage?: string;
    now?: string;
  } = {},
): DevelopmentSpec {
  const currentStatus = spec.status;

  if (!getLegalSpecTransitions(currentStatus).includes(nextStatus)) {
    throw new Error(
      `Spec status transition ${currentStatus} -> ${nextStatus} is not allowed.`,
    );
  }

  const now = options.now ?? new Date().toISOString();

  return {
    ...spec,
    cancelledAt: nextStatus === "cancelled" ? now : spec.cancelledAt,
    completedAt: nextStatus === "completed" ? now : spec.completedAt,
    failureMessage:
      nextStatus === "failed" || nextStatus === "blocked"
        ? options.failureMessage ?? spec.failureMessage ?? "Spec failed."
        : spec.failureMessage,
    status: nextStatus,
    updatedAt: now,
  };
}

export function markSpecFailed(
  spec: DevelopmentSpec,
  failureMessage: string,
  now = new Date().toISOString(),
): DevelopmentSpec {
  return transitionSpecStatus(spec, "failed", { failureMessage, now });
}

export function markSpecBlocked(
  spec: DevelopmentSpec,
  failureMessage: string,
  now = new Date().toISOString(),
): DevelopmentSpec {
  return transitionSpecStatus(spec, "blocked", { failureMessage, now });
}

export function markSpecCancelled(
  spec: DevelopmentSpec,
  now = new Date().toISOString(),
): DevelopmentSpec {
  return transitionSpecStatus(spec, "cancelled", { now });
}
