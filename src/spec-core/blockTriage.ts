import type { AgentRun, VerificationReport } from "../agent-core/types";
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
  | { action: "retry_task"; taskId: string; note: string }
  | { action: "expand_scope_and_retry"; taskId: string; extraAllowedPaths: string[]; note: string }
  | { action: "revise_spec"; feedback: string }
  | { action: "retry_verification"; note: string }
  | { action: "continue_in_chat"; reason: string }
  | { action: "ask_user"; question: string };

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
  latestVerificationReport?: VerificationReport | null;
  projectError?: string | null;
}): SpecBlockDiagnosis {
  const failedTask = selectFailedTask(input.revision);
  const runningTask = input.revision.tasks.find((task) => task.status === "running");
  const failedTaskId = failedTask?.id ?? runningTask?.id;
  const failedRunId = input.latestRun?.id ?? failedTask?.runId ?? runningTask?.runId;
  const evidence = collectEvidence(input, failedTask, runningTask);
  const evidenceText = evidence.join("\n");

  if (hasScopeEvidence(evidenceText)) {
    return {
      kind: "scope_blocked",
      summary: "Spec task is blocked by runtime path scope or permission limits.",
      failedTaskId,
      failedRunId,
      evidence,
      recommendedPlan: {
        action: "expand_scope_and_retry",
        taskId: failedTaskId ?? input.revision.tasks[0]?.id ?? "unknown-task",
        extraAllowedPaths: inferExtraAllowedPaths(evidenceText, failedTask),
        note: "Expand compiled allowed paths based on the failure evidence, then retry the task.",
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
        action: "retry_task",
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
            action: "retry_task",
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
          action: "retry_verification",
          note: "Retry final build/install verification before revising the plan.",
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
          action: "retry_verification",
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
        action: "retry_task",
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
          action: "retry_task",
          taskId: failedTask.id,
          note: "Retry the stopped task with the retained failure context.",
        }
      : {
          action: "revise_spec",
          feedback: "No retryable failed task was identified; revise the Spec plan.",
        },
  };
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
