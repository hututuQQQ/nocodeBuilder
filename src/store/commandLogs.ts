import type { CommandOutputEvent, CommandStatusEvent } from "../services/projects";

const MAX_TERMINAL_LOGS = 1000;

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
