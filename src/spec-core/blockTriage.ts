import type {
  AgentFailureCode,
  AgentRun,
  AgentRunCheckpoint,
  AgentWorkingState,
  SuggestedAgentAction,
  VerificationReport,
} from "../agent-core/types";
import type { DevelopmentSpec, SpecRevision, SpecTask } from "./types";

export type SpecBlockKind =
  | "plan_blocked"
  | "scope_blocked"
  | "runtime_blocked"
  | "verification_blocked"
  | "build_blocked"
  | "acceptance_blocked"
  | "approval_blocked"
  | "external_dependency_blocked";

export type SpecRecoveryPlan =
  | {
      action: "retry_with_suggested_action";
      taskId: string;
      note: string;
      suggestedAction?: SuggestedAgentAction;
      targetedRetry?: boolean;
    }
  | {
      action: "revise_spec";
      feedback: string;
      contractPatch?: Record<string, unknown>;
    }
  | {
      action: "expand_scope";
      taskId: string;
      extraAllowedPaths: string[];
      note: string;
      contractPatch?: Record<string, unknown>;
    }
  | { action: "convert_to_repair_task"; taskId: string; note: string; contractPatch?: Record<string, unknown> }
  | { action: "accept_noop"; reason: string }
  | { action: "ignore_preexisting"; reason: string }
  | { action: "manual_approval"; reason: string }
  | { action: "cancel"; reason: string };

export type SpecBlockDiagnosis = {
  kind: SpecBlockKind;
  summary: string;
  failedTaskId?: string;
  failedRunId?: string;
  evidence: string[];
  recommendedPlan: SpecRecoveryPlan;
};

export function diagnoseSpecBlock(input: {
  spec: DevelopmentSpec;
  revision: SpecRevision;
  latestRun?: AgentRun | null;
  latestCheckpoint?: AgentRunCheckpoint | null;
  latestVerificationReport?: VerificationReport | null;
  projectError?: string | null;
}): SpecBlockDiagnosis {
  const failedTask = selectFailedTask(input.revision);
  const runningTask = input.revision.tasks.find((task) => task.status === "running");
  const failedTaskId = failedTask?.id ?? runningTask?.id;
  const failedRunId = input.latestRun?.id ?? failedTask?.runId ?? runningTask?.runId;
  const evidence = collectEvidence(input, failedTask, runningTask);
  const evidenceText = evidence.join("\n");
  const currentBlocker = extractCurrentBlocker(input.latestCheckpoint);

  if (currentBlocker) {
    evidence.push(`currentBlocker: ${currentBlocker.code} ${currentBlocker.message}`);
  }

  if (currentBlocker) {
    const blockerDiagnosis = diagnoseCurrentBlocker({
      blocker: currentBlocker,
      evidence,
      evidenceText,
      failedRunId,
      failedTask,
      failedTaskId,
      revision: input.revision,
    });

    if (blockerDiagnosis) {
      return blockerDiagnosis;
    }
  }

  if (hasScopeEvidence(evidenceText)) {
    return {
      kind: "scope_blocked",
      summary: "Spec task is blocked by runtime path scope or permission limits.",
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "expand_scope",
        taskId: failedTaskId ?? input.revision.tasks[0]?.id ?? "unknown-task",
        extraAllowedPaths: inferExtraAllowedPaths(evidenceText, failedTask),
        note: "Expand compiled allowed paths based on the failure evidence, then retry the task.",
        contractPatch: {
          scope: {
            extraAllowedPaths: inferExtraAllowedPaths(evidenceText, failedTask),
          },
        },
      },
    };
  }

  if (
    !input.latestRun &&
    (runningTask?.runId || failedTask?.runId || runningTask)
  ) {
    return {
      kind: "runtime_blocked",
      summary: runningTask?.runId
        ? "The referenced AgentRun could not be found."
        : "The running task is missing its AgentRun id.",
      failedTaskId,
      failedRunId: failedTask?.runId ?? runningTask?.runId,
      evidence,
      recommendedPlan: {
        action: "retry_with_suggested_action",
        taskId: failedTaskId ?? input.revision.tasks[0]?.id ?? "unknown-task",
        note: "Runtime state is incomplete; reset and retry the affected task.",
      },
    };
  }

  if (input.spec.finalVerification?.success === false) {
    if (isBuildCommand(input.spec.finalVerification.command)) {
      const output = input.spec.finalVerification.output;
      const retryTask = failedTask ?? selectRetryableTask(input.revision);

      if (hasActionableBuildError(output)) {
        return {
          kind: "build_blocked",
          summary: `Final ${input.spec.finalVerification.command} failed with code diagnostics.`,
          failedTaskId: failedTaskId ?? retryTask?.id,
          failedRunId,
          evidence,
          recommendedPlan: {
              action: "retry_with_suggested_action",
              taskId: failedTaskId ?? retryTask?.id ?? input.revision.tasks[0]?.id ?? "unknown-task",
            note: [
              `Final ${input.spec.finalVerification.command} failed with actionable build output.`,
              "Use this output as retry context:",
              output.trim(),
            ].filter(Boolean).join("\n"),
          },
        };
      }

      return {
        kind: "build_blocked",
        summary: hasEnvironmentalBuildFailure(output)
          ? `Final ${input.spec.finalVerification.command} appears to have failed for an environmental reason.`
          : `Final ${input.spec.finalVerification.command} failed without actionable source diagnostics.`,
        failedTaskId,
        failedRunId,
        evidence,
        recommendedPlan: {
          action: "ignore_preexisting",
          reason: "Retry final build/install verification before revising the plan; current evidence looks environmental or pre-existing.",
        },
      };
    }

    if (input.spec.finalVerification.command === "acceptance criteria") {
      return {
        kind: "acceptance_blocked",
        summary: "Required acceptance criteria did not pass final verification.",
        failedTaskId,
        failedRunId,
        evidence,
        recommendedPlan: {
          action: "revise_spec",
          feedback: "Required acceptance criteria are not covered or verified. Revise the task plan or retry the linked implementation task.",
        },
      };
    }

    if (input.spec.finalVerification.command === "task verification reports") {
      return {
        kind: "verification_blocked",
        summary: "One or more task verification reports are missing or failed.",
        failedTaskId,
        failedRunId,
        evidence,
        recommendedPlan: {
          action: "retry_with_suggested_action",
          taskId: failedTaskId ?? selectRetryableTask(input.revision)?.id ?? "unknown-task",
          note: "Retry task/final verification after checking the latest task run reports.",
        },
      };
    }
  }

  if (input.latestVerificationReport && input.latestVerificationReport.status !== "passed") {
    return {
      kind: "verification_blocked",
      summary: `Latest task verification is ${input.latestVerificationReport.status}.`,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "retry_with_suggested_action",
        taskId: failedTaskId ?? selectRetryableTask(input.revision)?.id ?? "unknown-task",
        note: "Retry the failed task using the latest verification feedback.",
      },
    };
  }

  if (hasPlanEvidence(input.revision, evidenceText)) {
    return {
      kind: "plan_blocked",
      summary: "The task dependency graph or acceptance coverage cannot advance safely.",
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "revise_spec",
        feedback: "Revise the Spec plan so dependencies and required acceptance criteria are covered by runnable tasks.",
      },
    };
  }

  return {
    kind: failedTask ? "verification_blocked" : "plan_blocked",
    summary: failedTask
      ? `Task ${failedTask.title} is stopped and needs targeted recovery.`
      : "Spec is blocked and needs conservative recovery.",
    failedTaskId,
    failedRunId,
    evidence,
    recommendedPlan: failedTask
      ? {
          action: "retry_with_suggested_action",
          taskId: failedTask.id,
          note: "Retry the stopped task with the retained failure context.",
        }
      : {
          action: "revise_spec",
          feedback: "No retryable failed task was identified; revise the Spec plan.",
        },
  };
}

function diagnoseCurrentBlocker({
  blocker,
  evidence,
  evidenceText,
  failedRunId,
  failedTask,
  failedTaskId,
  revision,
}: {
  blocker: NonNullable<AgentWorkingState["currentBlocker"]>;
  evidence: string[];
  evidenceText: string;
  failedRunId?: string;
  failedTask: SpecTask | null;
  failedTaskId?: string;
  revision: SpecRevision;
}): SpecBlockDiagnosis | null {
  const taskId = failedTaskId ?? failedTask?.id ?? revision.tasks[0]?.id ?? "unknown-task";

  if (isScopeFailure(blocker.code)) {
    const extraAllowedPaths = inferExtraAllowedPaths(
      [evidenceText, blocker.message].join("\n"),
      failedTask,
    );

    return {
      kind: "scope_blocked",
      summary: blocker.message || "Spec task is blocked by runtime path scope or permission limits.",
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "expand_scope",
        taskId,
        extraAllowedPaths,
        note: "Expand allowed paths or revise the Spec scope before retrying.",
        contractPatch: {
          scope: { extraAllowedPaths },
        },
      },
    };
  }

  if (blocker.code === "APPROVAL_REQUIRED") {
    return {
      kind: "approval_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "manual_approval",
        reason: blocker.message,
      },
    };
  }

  if (blocker.code === "TASK_CLASSIFICATION_MISMATCH") {
    return {
      kind: "plan_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "convert_to_repair_task",
        taskId,
        note: "The AgentRun contract was too read-only for the requested repair.",
        contractPatch: { taskType: "component_edit", permissions: { fileWrite: true } },
      },
    };
  }

  if (
    blocker.code === "BUILD_PREEXISTING_UNRELATED" ||
    blocker.code === "STATIC_PREEXISTING_UNRELATED"
  ) {
    return {
      kind: "verification_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "ignore_preexisting",
        reason: blocker.message,
      },
    };
  }

  if (blocker.code === "LOOP_EXHAUSTED" || /loop_exhausted/i.test(blocker.message)) {
    const suggestedFingerprint = blocker.suggestedAction
      ? buildSuggestedActionFingerprint(blocker.suggestedAction)
      : undefined;
    const hasTargetedRetry =
      Boolean(blocker.suggestedAction) &&
      suggestedFingerprint !== blocker.fingerprint;

    return {
      kind: "runtime_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: hasTargetedRetry
        ? {
            action: "retry_with_suggested_action",
            taskId,
            note: "Loop exhausted, but the runtime supplied a distinct targeted recovery action.",
            suggestedAction: blocker.suggestedAction,
            targetedRetry: true,
          }
        : {
            action: "cancel",
            reason: "Loop exhausted without a distinct targeted recovery action.",
          },
    };
  }

  if (
    blocker.suggestedAction?.type === "finish_candidate" &&
    blocker.suggestedAction.evidence?.noOpReason
  ) {
    return {
      kind: "acceptance_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "accept_noop",
        reason: blocker.suggestedAction.evidence.noOpReason,
      },
    };
  }

  if (blocker.suggestedAction) {
    return {
      kind: "runtime_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "retry_with_suggested_action",
        taskId,
        note: "Retry using the runtime-suggested recovery action.",
        suggestedAction: blocker.suggestedAction,
        targetedRetry: true,
      },
    };
  }

  if (blocker.code === "MISSING_ACCEPTANCE_EVIDENCE") {
    return {
      kind: "acceptance_blocked",
      summary: blocker.message,
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "revise_spec",
        feedback: "Add or clarify acceptance evidence requirements before retrying.",
      },
    };
  }

  return null;
}

function isScopeFailure(code: AgentFailureCode) {
  return code === "SPEC_SCOPE_INSUFFICIENT" ||
    code === "OUTSIDE_ALLOWED_PATH" ||
    code === "FORBIDDEN_PATH" ||
    code === "POLICY_DENIED";
}

function selectFailedTask(revision: SpecRevision) {
  return revision.tasks.find((task) =>
    ["failed", "blocked", "cancelled"].includes(task.status),
  ) ?? null;
}

function selectRetryableTask(revision: SpecRevision) {
  return revision.tasks.find((task) =>
    ["failed", "blocked", "cancelled"].includes(task.status),
  ) ?? revision.tasks.find((task) => task.status === "passed") ?? null;
}

function extractCurrentBlocker(checkpoint?: AgentRunCheckpoint | null) {
  const plan = checkpoint?.plan;

  if (!isRecord(plan)) {
    return null;
  }

  const metadata = plan.__headlessRunController;

  if (!isRecord(metadata) || !isRecord(metadata.workingState)) {
    return null;
  }

  const blocker = metadata.workingState.currentBlocker;

  if (
    !isRecord(blocker) ||
    typeof blocker.code !== "string" ||
    typeof blocker.message !== "string"
  ) {
    return null;
  }

  return {
    code: blocker.code as AgentFailureCode,
    message: blocker.message,
    fingerprint:
      typeof blocker.fingerprint === "string" ? blocker.fingerprint : undefined,
    suggestedAction: isRecord(blocker.suggestedAction)
      ? blocker.suggestedAction as SuggestedAgentAction
      : undefined,
  };
}

function buildSuggestedActionFingerprint(action: SuggestedAgentAction) {
  return `${action.type}:${stableJson(action)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function collectEvidence(
  input: Parameters<typeof diagnoseSpecBlock>[0],
  failedTask: SpecTask | null,
  runningTask: SpecTask | undefined,
) {
  return [
    input.projectError ? `projectError: ${input.projectError}` : "",
    input.spec.failureMessage ? `spec.failureMessage: ${input.spec.failureMessage}` : "",
    input.spec.finalVerification
      ? `finalVerification: ${input.spec.finalVerification.command} success=${input.spec.finalVerification.success}\n${input.spec.finalVerification.output}`
      : "",
    failedTask?.error ? `task ${failedTask.id}: ${failedTask.error}` : "",
    runningTask && !runningTask.runId
      ? `task ${runningTask.id}: running task has no runId`
      : "",
    input.latestRun
      ? `latestRun: ${input.latestRun.id} status=${input.latestRun.status}`
      : "",
    input.latestVerificationReport
      ? `latestVerificationReport: ${input.latestVerificationReport.status} ${[
          ...input.latestVerificationReport.repairFeedback,
          ...input.latestVerificationReport.missingEvidence,
          ...input.latestVerificationReport.newlyIntroducedFailures,
        ].join(" ")}`
      : "",
  ].filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasScopeEvidence(text: string) {
  return /(forbidden path|allowed paths?|not permitted|permission denied|policy denied|scope|outside.*allowed|path.*denied|\u8d8a\u6743|\u6743\u9650|\u4e0d\u5141\u8bb8)/i.test(text);
}

function hasPlanEvidence(revision: SpecRevision, evidenceText: string) {
  return /(dependency graph|dependencies could not advance|required acceptance|not covered|coverage|plan|\u4f9d\u8d56|\u9a8c\u6536|\u8ba1\u5212)/i.test(evidenceText) ||
    revision.tasks.some((task) =>
      task.status === "pending" &&
      task.dependencyIds.some((dependencyId) =>
        revision.tasks.some((candidate) =>
          candidate.id === dependencyId &&
          ["failed", "blocked", "cancelled"].includes(candidate.status),
        ),
      ),
    );
}

function isBuildCommand(command: string) {
  return /(install|build|npm|pnpm)/i.test(command);
}

function hasActionableBuildError(output: string) {
  return (
    hasSourceLocation(output) ||
    /(Type error|TS\d{4}|Failed to compile|Build error|Syntax error|Module not found|Cannot find module|Property .+ does not exist|Type .+ is not assignable|ESLint:|Parsing error)/i.test(output)
  );
}

function hasSourceLocation(output: string) {
  return /(?:^|\s)(?:\.\/)?(?:app|src|components|lib|styles|pages|middleware|public|server|client|next\.config|tsconfig|package\.json)[\w./-]*(?::\d+(?::\d+)?|\(\d+,\d+\))/i.test(output);
}

function hasEnvironmentalBuildFailure(output: string) {
  return /(EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|timeout|timed out|registry|502|503|504|rate limit|temporary|temporarily|Internal Server Error|ERR_PNPM_FETCH|fetch failed|socket hang up)/i.test(output);
}

function inferExtraAllowedPaths(text: string, task: SpecTask | null) {
  const paths = new Set<string>();

  if (/(api|backend|server|auth|database|supabase|realtime|multiplayer)/i.test(text)) {
    paths.add("app/api/**");
    paths.add("lib/**");
    paths.add("middleware.ts");
    paths.add("package.json");
  }

  for (const path of task?.expectedFiles ?? []) {
    paths.add(path);
  }

  return [...paths];
}
