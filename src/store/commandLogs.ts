import type { CommandOutputEvent, CommandStatusEvent } from "../services/projects";

const MAX_TERMINAL_LOGS = 1000;
export const MAX_COMMAND_OUTPUT_PREVIEW_LINES = 8;

export type CommandRunStatus =
  | "failed"
  | "ready"
  | "running"
  | "stopped"
  | "succeeded";

export type CommandRun = {
  chatActivityId?: string;
  chatMessageId?: string;
  command: string;
  elapsedMs?: number;
  exitCode: number | null;
  finishedAt?: string;
  id: string;
  message?: string | null;
  outputLineCount: number;
  outputPreview: string[];
  projectId: string;
  startedAt: string;
  status: CommandRunStatus;
  url?: string | null;
};

export type CommandRunLink = {
  chatActivityId?: string;
  chatMessageId?: string;
};

export function appendLogs(logs: string[], entries: string[]) {
  return [...logs, ...entries].slice(-MAX_TERMINAL_LOGS);
}

export function formatCommandOutput(event: CommandOutputEvent) {
  const stream = event.stream === "stderr" ? "err" : "out";
  return `[${event.command}:${stream}] ${event.line}`;
}

export function formatCommandStatus(event: CommandStatusEvent) {
  const exitCode =
    event.exitCode === null || event.exitCode === undefined
      ? ""
      : ` exit ${event.exitCode}`;
  const url = event.url ? ` ${event.url}` : "";
  const message = event.message ? ` ${event.message}` : "";

  return `[${event.command}] ${event.status}${exitCode}${url}${message}`;
}

export function formatCommandFailure(event: CommandStatusEvent) {
  const exitCode =
    event.exitCode === null || event.exitCode === undefined
      ? "unknown"
      : event.exitCode;

  return event.message ?? `command: '${event.command}' failed with code ${exitCode}`;
}

export function isInstallCommand(command: string) {
  return command === "npm install" || command === "pnpm install";
}

export function isDevCommand(command: string) {
  return command === "npm run dev" || command === "pnpm dev";
}

export function isDeployCommand(command: string) {
  return command === "vercel deploy";
}

export function appendCommandOutputPreview(
  outputPreview: string[],
  line: string,
) {
  return [...outputPreview, line].slice(-MAX_COMMAND_OUTPUT_PREVIEW_LINES);
}

export function calculateElapsedMs(startedAt?: string, finishedAt?: string) {
  if (!startedAt) {
    return undefined;
  }

  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }

  return Math.max(0, end - start);
}

export function formatElapsedTime(elapsedMs?: number) {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) {
    return "";
  }

  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }

  const seconds = Math.round(elapsedMs / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}m ${remainingSeconds}s`;
}
