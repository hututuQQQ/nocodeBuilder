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
  steering?: string[];
}): DriftCheckResult {
  const scopedPaths = uniquePaths([
    ...collectMutatedPaths(input.action),
    ...input.changedFiles,
  ]);
  const forbiddenPath = scopedPaths.find((path: string) =>
    isPathForbidden(path, input.manifest.runtimeContract.forbiddenPaths),
  );

  if (forbiddenPath) {
    return {
      ok: false,
      reason: `Action targets ${forbiddenPath}, which matches manifest forbiddenPaths.`,
      suggestedAction: "block_scope",
    };
  }

  const outsideAllowedPath = scopedPaths.find((path: string) =>
    !isPathAllowedByManifest(path, input.manifest),
  );

  if (outsideAllowedPath) {
    return {
      ok: false,
      reason: `Action targets ${outsideAllowedPath}, which is outside compiledAllowedPaths.`,
      suggestedAction: "block_scope",
    };
  }

  const conflictingSteering = findConflictingSteering(input.manifest, input.steering ?? []);

  if (conflictingSteering) {
    return {
      ok: false,
      reason: conflictingSteering,
      suggestedAction: "ask_for_revision",
    };
  }

  if (actionObviouslyDriftsFromTask(input.manifest, input.action)) {
    return {
      ok: false,
      reason: "Action appears to target a different task objective than the TaskManifest.",
      suggestedAction: "block_plan",
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

  if (
    (action.tool === "edit_file" || action.tool === "replace_file_range") &&
    isRecord(action.args)
  ) {
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

function findConflictingSteering(manifest: TaskManifest, steering: string[]) {
  if (manifest.mode !== "spec" || steering.length === 0) {
    return null;
  }

  const manifestText = normalizeText([
    manifest.projectGoal,
    manifest.rawUserGoal,
    manifest.spec?.taskTitle ?? "",
    manifest.spec?.taskObjective ?? "",
    ...(manifest.spec?.expectedFiles ?? []),
    ...manifest.runtimeContract.expectedFiles,
    ...(manifest.spec?.linkedRequirements.map((item) => item.description) ?? []),
    ...(manifest.spec?.linkedAcceptanceCriteria.map((item) => item.description) ?? []),
  ].join("\n"));

  const conflict = steering
    .map((item) => item.trim())
    .filter(Boolean)
    .find((item) => {
      const text = normalizeText(item);

      if (
        /(change|switch|instead|replace|new plan|different approach|revise|改方案|换做法|改成|换成|不要|改为)/i.test(item) &&
        !hasMeaningfulWordOverlap(manifestText, item, 2)
      ) {
        return true;
      }

      if (
        /(database|supabase|auth|login|api|backend|dependency|package|install|数据库|登录|认证|接口|后端|依赖)/i.test(item) &&
        !hasMeaningfulWordOverlap(manifestText, item, 1)
      ) {
        return true;
      }

      return /(ignore|skip|bypass).*(manifest|task|acceptance|scope)/i.test(text);
    });

  return conflict
    ? `Latest steering conflicts with TaskManifest: ${conflict}`
    : null;
}

function actionObviouslyDriftsFromTask(
  manifest: TaskManifest,
  action: HeadlessModelAction,
) {
  if (
    manifest.mode !== "spec" ||
    !manifest.spec ||
    action.type === "answer" ||
    action.type === "finish_candidate" ||
    action.type === "model_validation_error"
  ) {
    return false;
  }

  const manifestText = normalizeText([
    manifest.projectGoal,
    manifest.rawUserGoal,
    manifest.spec.taskTitle,
    manifest.spec.taskObjective,
    ...manifest.spec.expectedFiles,
    ...manifest.runtimeContract.expectedFiles,
    ...manifest.spec.linkedRequirements.map((item) => item.description),
    ...manifest.spec.linkedAcceptanceCriteria.map((item) => item.description),
  ].join("\n"));
  const actionText = normalizeText(actionToText(action));

  if (!actionText.trim()) {
    return false;
  }

  const driftDomains = [
    /(auth|login|signup|sign in|认证|登录|注册)/i,
    /(database|supabase|schema|sql|数据)/i,
    /(api|backend|server|route handler|接口|后端)/i,
    /(payment|stripe|checkout|billing|支付|结账)/i,
  ];

  return driftDomains.some((domain) =>
    domain.test(actionText) &&
    !domain.test(manifestText) &&
    !hasMeaningfulWordOverlap(manifestText, actionText, 2),
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

function actionToText(action: HeadlessModelAction): string {
  if (action.type === "tool_calls") {
    return [
      action.rationale ?? "",
      ...action.calls.map((call) =>
        [call.tool, call.rationale ?? "", safeJson(call.args)].join("\n"),
      ),
    ].join("\n");
  }

  if (action.type === "tool_call") {
    return [action.tool, action.rationale ?? "", safeJson(action.args)].join("\n");
  }

  return "";
}

function readPath(value: unknown) {
  return typeof value === "string" && value.trim()
    ? [normalizeProjectPath(value)]
    : [];
}

function uniquePaths(paths: string[]) {
  return Array.from(new Set(paths.map(normalizeProjectPath).filter(Boolean)));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[_./:-]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasMeaningfulWordOverlap(
  haystack: string,
  needle: string,
  minimum: number,
) {
  const haystackWords = new Set(extractMeaningfulWords(haystack));
  const needleWords = extractMeaningfulWords(needle);
  let overlap = 0;

  for (const word of needleWords) {
    if (haystackWords.has(word)) {
      overlap += 1;
    }

    if (overlap >= minimum) {
      return true;
    }
  }

  return false;
}

function extractMeaningfulWords(value: string) {
  const stopWords = new Set([
    "and",
    "the",
    "for",
    "with",
    "from",
    "this",
    "that",
    "task",
    "page",
    "file",
    "update",
    "change",
    "implement",
    "create",
    "edit",
  ]);

  return normalizeText(value)
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word));
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 4_000);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
