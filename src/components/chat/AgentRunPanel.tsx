import { FormEvent, useState } from "react";
import {
  Check,
  CircleDot,
  FileText,
  Pause,
  Play,
  RotateCcw,
  SendHorizontal,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { isRunControllerActive } from "../../agent-runtime/agentRunControl";
import { getLegalRunTransitions } from "../../agent-core/runtime/runStateMachine";
import type {
  AgentApproval,
  AgentEvent,
  AgentRun,
  VerificationReport,
} from "../../agent-core/types";
import {
  agentRuntimeApi,
  type AgentArtifactContent,
} from "../../services/agentRuntime";

export function AgentRunPanel() {
  const [steering, setSteering] = useState("");
  const currentRun = useAppStore((state) => state.currentAgentRun);
  const currentProject = useAppStore((state) => state.currentProject);
  const currentApproval = useAppStore((state) => state.currentAgentApproval);
  const events = useAppStore((state) => state.agentEvents);
  const report = useAppStore((state) => state.currentVerificationReport);
  const approveCurrentAgentApproval = useAppStore(
    (state) => state.approveCurrentAgentApproval,
  );
  const cancelCurrentAgentRun = useAppStore((state) => state.cancelCurrentAgentRun);
  const denyCurrentAgentApproval = useAppStore(
    (state) => state.denyCurrentAgentApproval,
  );
  const pauseCurrentAgentRun = useAppStore((state) => state.pauseCurrentAgentRun);
  const recoverCurrentAgentRun = useAppStore((state) => state.recoverCurrentAgentRun);
  const sendAgentSteering = useAppStore((state) => state.sendAgentSteering);

  if (!currentRun) {
    return null;
  }

  async function submitSteering(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = steering.trim();

    if (!message) {
      return;
    }

    await sendAgentSteering(message);
    setSteering("");
  }

  const controllerActive = isRunControllerActive(currentRun.id);
  const legalTransitions = getLegalRunTransitions(currentRun.status);
  const approvalPending = currentApproval ? isApprovalPending(currentApproval) : false;
  const canPause =
    controllerActive &&
    !isTerminalRun(currentRun) &&
    legalTransitions.includes("request_pause");
  const canResume =
    !controllerActive &&
    !isTerminalRun(currentRun) &&
    !(currentRun.status === "waiting_approval" && approvalPending);
  const canCancel = !isTerminalRun(currentRun);

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md border border-zinc-800 bg-zinc-900 text-teal-200">
          <CircleDot size={16} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">
              Agent Run
            </h3>
            <span className="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
              {formatRunStatus(currentRun)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {currentRun.contract.objective}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label="Pause run"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-amber-400/40 hover:text-amber-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canPause}
            onClick={() => void pauseCurrentAgentRun()}
            title="Pause"
            type="button"
          >
            <Pause size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Resume run"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-emerald-400/40 hover:text-emerald-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canResume}
            onClick={() => void recoverCurrentAgentRun()}
            title={currentRun.status === "paused" ? "Resume" : "Recover"}
            type="button"
          >
            <Play size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Cancel run"
            className="grid size-8 place-items-center rounded border border-zinc-800 text-zinc-500 transition hover:border-red-400/40 hover:text-red-200 disabled:cursor-not-allowed disabled:text-zinc-700"
            disabled={!canCancel}
            onClick={() => void cancelCurrentAgentRun()}
            title="Cancel"
            type="button"
          >
            <XCircle size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr]">
        <RunTimeline events={events} />
        <VerificationSummary
          projectId={currentProject?.id ?? null}
          report={report}
        />
      </div>

      {currentApproval && approvalPending ? (
        <ApprovalCard
          approval={currentApproval}
          onApprove={() => void approveCurrentAgentApproval()}
          onDeny={() => void denyCurrentAgentApproval()}
        />
      ) : null}

      {!isTerminalRun(currentRun) ? (
        <form className="mt-3 flex gap-2" onSubmit={submitSteering}>
          <input
            className="h-9 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/10"
            onChange={(event) => setSteering(event.currentTarget.value)}
            placeholder="Steering"
            value={steering}
          />
          <button
            aria-label="Send steering"
            className="grid size-9 shrink-0 place-items-center rounded-md border border-teal-400/30 bg-teal-400/10 text-teal-100 transition hover:border-teal-300/60 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900 disabled:text-zinc-700"
            disabled={!steering.trim()}
            title="Send steering"
            type="submit"
          >
            <SendHorizontal size={14} aria-hidden="true" />
          </button>
        </form>
      ) : null}
    </section>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: AgentApproval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="mt-3 rounded border border-amber-400/30 bg-amber-400/5 p-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="grid size-7 shrink-0 place-items-center rounded border border-amber-400/30 text-amber-200">
          <ShieldCheck size={14} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-amber-100">
              {approval.toolName}
            </span>
            <span className="shrink-0 text-[11px] text-amber-300/70">
              {approval.normalizedArgsHash.slice(0, 12)}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-zinc-400">
            {approval.exactSideEffect}
          </p>
          {approval.targetResources.length > 0 ? (
            <p className="mt-1 truncate text-[11px] text-zinc-500">
              {approval.targetResources.join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            aria-label="Approve"
            className="grid size-8 place-items-center rounded border border-emerald-400/30 bg-emerald-400/10 text-emerald-100 transition hover:border-emerald-300/60"
            onClick={onApprove}
            title="Approve"
            type="button"
          >
            <Check size={14} aria-hidden="true" />
          </button>
          <button
            aria-label="Deny"
            className="grid size-8 place-items-center rounded border border-red-400/30 bg-red-400/10 text-red-100 transition hover:border-red-300/60"
            onClick={onDeny}
            title="Deny"
            type="button"
          >
            <XCircle size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function RunTimeline({ events }: { events: AgentEvent[] }) {
  const visibleEvents = events.slice(-8);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
        <RotateCcw size={13} aria-hidden="true" />
        Timeline
      </div>
      <div className="space-y-1">
        {visibleEvents.length > 0 ? (
          visibleEvents.map((event) => (
            <div
              className="flex min-w-0 items-center gap-2 rounded border border-zinc-900 bg-zinc-950 px-2 py-1.5 text-xs"
              key={event.id}
            >
              <span className="w-8 shrink-0 text-zinc-600">#{event.sequence}</span>
              <span className="truncate text-zinc-300">{event.type}</span>
            </div>
          ))
        ) : (
          <p className="rounded border border-dashed border-zinc-900 px-2 py-2 text-xs text-zinc-600">
            No events yet.
          </p>
        )}
      </div>
    </div>
  );
}

function VerificationSummary({
  projectId,
  report,
}: {
  projectId: string | null;
  report: VerificationReport | null;
}) {
  const [artifact, setArtifact] = useState<AgentArtifactContent | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [loadingArtifactId, setLoadingArtifactId] = useState<string | null>(null);

  async function openArtifact(artifactId: string) {
    if (!projectId) {
      setArtifactError("No project is selected.");
      return;
    }

    setArtifactError(null);
    setLoadingArtifactId(artifactId);

    try {
      const nextArtifact = await agentRuntimeApi.readArtifact(projectId, artifactId);
      if (!nextArtifact) {
        setArtifact(null);
        setArtifactError("Artifact was not found.");
        return;
      }

      setArtifact(nextArtifact);
    } catch (error) {
      setArtifact(null);
      setArtifactError(error instanceof Error ? error.message : "Artifact could not be read.");
    } finally {
      setLoadingArtifactId(null);
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-300">
        <ShieldCheck size={13} aria-hidden="true" />
        Verification
      </div>
      {report ? (
        <div className="space-y-1">
          <div className="rounded border border-zinc-900 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
            {report.status}
          </div>
          {report.checks.slice(0, 5).map((check) => (
            <div
              className="flex min-w-0 items-center gap-2 rounded border border-zinc-900 bg-zinc-950 px-2 py-1.5 text-xs"
              key={check.id}
            >
              <span className="w-20 shrink-0 text-zinc-500">{check.status}</span>
              <span className="truncate text-zinc-300">{check.title}</span>
            </div>
          ))}
          {report.artifactIds.length > 0 ? (
            <div className="rounded border border-zinc-900 bg-zinc-950 p-2">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-zinc-400">
                <FileText size={12} aria-hidden="true" />
                Artifacts
              </div>
              <div className="flex flex-wrap gap-1.5">
                {report.artifactIds.slice(0, 6).map((artifactId, index) => (
                  <button
                    className="max-w-full rounded border border-zinc-800 px-2 py-1 text-left text-[11px] text-zinc-300 transition hover:border-teal-400/40 hover:text-teal-100 disabled:cursor-wait disabled:text-zinc-600"
                    disabled={loadingArtifactId === artifactId}
                    key={artifactId}
                    onClick={() => void openArtifact(artifactId)}
                    title={artifactId}
                    type="button"
                  >
                    {loadingArtifactId === artifactId
                      ? "Loading"
                      : `Artifact ${index + 1}`}
                  </button>
                ))}
              </div>
              {artifactError ? (
                <p className="mt-2 text-[11px] text-red-300">{artifactError}</p>
              ) : null}
              {artifact ? (
                <div className="mt-2 rounded border border-zinc-900 bg-zinc-900/70 p-2">
                  <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-zinc-500">
                    <span className="truncate">{artifact.path}</span>
                    <span className="shrink-0">{formatBytes(artifact.sizeBytes)}</span>
                  </div>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-[11px] leading-4 text-zinc-300">
                    {summarizeArtifactContent(artifact.content)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded border border-dashed border-zinc-900 px-2 py-2 text-xs text-zinc-600">
          No report yet.
        </p>
      )}
    </div>
  );
}

function summarizeArtifactContent(content: string) {
  const maxLength = 2400;
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n... truncated ${
    content.length - maxLength
  } character(s)`;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function formatRunStatus(run: AgentRun) {
  return `${run.status} / ${run.phase} / r${run.repairCycles}`;
}

function isApprovalPending(approval: AgentApproval) {
  return (
    !approval.decision &&
    !approval.resolvedAt &&
    new Date(approval.expiresAt).getTime() > Date.now()
  );
}

function isTerminalRun(run: AgentRun) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status);
}
