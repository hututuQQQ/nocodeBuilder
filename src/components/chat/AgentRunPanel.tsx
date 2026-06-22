import { FormEvent, useState } from "react";
import {
  CircleDot,
  Pause,
  Play,
  RotateCcw,
  SendHorizontal,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useAppStore } from "../../store/appStore";
import type { AgentEvent, AgentRun, VerificationReport } from "../../agent-core/types";

export function AgentRunPanel() {
  const [steering, setSteering] = useState("");
  const currentRun = useAppStore((state) => state.currentAgentRun);
  const events = useAppStore((state) => state.agentEvents);
  const report = useAppStore((state) => state.currentVerificationReport);
  const cancelCurrentAgentRun = useAppStore((state) => state.cancelCurrentAgentRun);
  const pauseCurrentAgentRun = useAppStore((state) => state.pauseCurrentAgentRun);
  const resumeCurrentAgentRun = useAppStore((state) => state.resumeCurrentAgentRun);
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

  const canPause = !isTerminalRun(currentRun) && currentRun.status !== "paused";
  const canResume = currentRun.status === "paused";
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
            onClick={() => void resumeCurrentAgentRun()}
            title="Resume"
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
        <VerificationSummary report={report} />
      </div>

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

function VerificationSummary({ report }: { report: VerificationReport | null }) {
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
        </div>
      ) : (
        <p className="rounded border border-dashed border-zinc-900 px-2 py-2 text-xs text-zinc-600">
          No report yet.
        </p>
      )}
    </div>
  );
}

function formatRunStatus(run: AgentRun) {
  return `${run.status} / ${run.phase} / r${run.repairCycles}`;
}

function isTerminalRun(run: AgentRun) {
  return ["completed", "failed", "cancelled", "budget_exceeded"].includes(run.status);
}
