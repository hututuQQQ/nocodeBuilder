import type { TaskManifest } from "../manifest/taskManifest";
import {
  isInvalidProjectPath,
  isPathForbidden,
  matchesProjectPathPattern,
  normalizeProjectPath,
} from "../pathScope";
import type { HeadlessModelAction } from "./runController";

export type DriftCheckResult = {
  ok: boolean;
  reason?: string;
  suggestedAction?: "continue" | "finish" | "ask_for_revision" | "block_scope" | "block_plan";
};

export function checkRunDrift(input: {
  manifest: TaskManifest;
  action: HeadlessModelAction;
  recentObservations: string[];
  changedFiles: string[];
}): DriftCheckResult {
  const mutatedPaths = collectMutatedPaths(input.action);
  const outsideAllowedPath = mutatedPaths.find((path: string) =>
    !isPathForbidden(path, input.manifest.runtimeContract.forbiddenPaths) &&
    !isPathAllowedByManifest(path, input.manifest),
  );

  if (outsideAllowedPath) {
    return {
      ok: false,
      reason: `Action targets ${outsideAllowedPath}, which is outside compiledAllowedPaths.`,
      suggestedAction: "block_scope",
    };
  }

  if (isPrematureAnswer(input.manifest, input.action)) {
    return {
      ok: false,
      reason: "Code-changing task returned answer before implementation or verification evidence.",
      suggestedAction: "block_plan",
    };
  }

  return { ok: true, suggestedAction: "continue" };
}

function collectMutatedPaths(action: HeadlessModelAction): string[] {
  if (action.type === "tool_calls") {
    return action.calls.flatMap((call) =>
      collectMutatedPaths({ ...call, type: "tool_call" }),
    );
  }

  if (action.type !== "tool_call") {
    return [];
  }

  if (action.tool === "edit_file" && isRecord(action.args)) {
    return readPath(action.args.path);
  }

  if (action.tool === "write_files" && isRecord(action.args)) {
    return Array.isArray(action.args.files)
      ? action.args.files.flatMap((file) =>
          isRecord(file) ? readPath(file.path) : [],
        )
      : [];
  }

  if (action.tool === "delete_files" && isRecord(action.args)) {
    return Array.isArray(action.args.paths)
      ? action.args.paths.flatMap(readPath)
      : [];
  }

  return [];
}

function isPathAllowedByManifest(path: string, manifest: TaskManifest) {
  const normalized = normalizeProjectPath(path);

  return (
    !isInvalidProjectPath(normalized) &&
    manifest.runtimeContract.compiledAllowedPaths.some((pattern) =>
      matchesProjectPathPattern(normalized, pattern),
    )
  );
}

function isPrematureAnswer(manifest: TaskManifest, action: HeadlessModelAction) {
  if (
    action.type !== "answer" ||
    manifest.mode !== "spec" ||
    manifest.runtimeContract.taskType === "answer" ||
    !manifest.runtimeContract.permissions.fileWrite
  ) {
    return false;
  }

  return !/(blocked|cannot|can't|need approval|需要|阻塞|无法|不能|权限)/i.test(
    action.message,
  );
}

function readPath(value: unknown) {
  return typeof value === "string" && value.trim()
    ? [normalizeProjectPath(value)]
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
