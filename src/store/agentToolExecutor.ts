import {
  AgentObservation,
  AgentToolBatchStep,
  AgentToolCallStep,
  formatProjectFileTree,
} from "../agent/projectModifier";
import { applySupabaseSchema } from "../agent/project/backendContext";
import {
  getAllowedFilePaths,
} from "../agent/project/pathRules";
import { validatePackageJsonContent } from "../agent/project/packageValidation";
import { getAgentToolDefinition } from "../agent/project/toolRegistry";
import {
  CommandResult,
  FileTree,
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
} from "../services/projects";
import {
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./agentHooks";
import { deleteAgentFiles, writeAgentFiles } from "./agentFileChanges";
import { formatChangeRecordMessage } from "./changeHistory";
import type { StoreAccess } from "./storeAccess";

const MAX_TOOL_OUTPUT_CHARS = 18_000;
const MAX_READ_FILE_CHARS = 24_000;
const MAX_GREP_FILES = 250;

export type AgentReadFileState = {
  content: string;
  contentHash: string;
  path: string;
  readAt: string;
};

export type AgentRunState = {
  readFiles: Map<string, AgentReadFileState>;
};

export type AgentToolResult = {
  didChangeFiles?: boolean;
  didChangePackage?: boolean;
  observation: AgentObservation;
};

export function createAgentRunState(): AgentRunState {
  return {
    readFiles: new Map(),
  };
}

export async function executeAgentToolBatch(
  store: StoreAccess,
  project: ProjectInfo,
  step: AgentToolBatchStep,
  firstObservationStep: number,
  runState: AgentRunState,
): Promise<AgentToolResult[]> {
  const unsafeCall = step.calls.find((call) => {
    const definition = getAgentToolDefinition(call.tool);
    return !definition?.isReadOnly || !definition.isConcurrencySafe;
  });

  if (unsafeCall) {
    return [
      {
        observation: createAgentObservation({
          ok: false,
          step: firstObservationStep,
          summary: `tool_calls may only batch read-only tools, but included ${unsafeCall.tool}.`,
          tool: "tool_calls",
        }),
      },
    ];
  }

  return Promise.all(
    step.calls.map((call, index) =>
      executeAgentTool(store, project, call, firstObservationStep + index, runState),
    ),
  );
}

export async function executeAgentTool(
  store: StoreAccess,
  project: ProjectInfo,
  step: AgentToolCallStep,
  observationStep: number,
  runState: AgentRunState,
): Promise<AgentToolResult> {
  try {
    ensureCurrentProject(store, project.id);
    const preHook = runPreToolUseHooks(step);

    if (!preHook.ok) {
      return {
        observation: createAgentObservation({
          content: preHook.message,
          ok: false,
          step: observationStep,
          summary: `${step.tool} blocked by PreToolUse hook.`,
          tool: step.tool,
        }),
      };
    }

    const result = await executeAgentToolCore(
      store,
      project,
      step,
      observationStep,
      runState,
    );
    const postHookNotes = runPostToolUseHooks(step, result);

    if (postHookNotes.length > 0) {
      result.observation = createAgentObservation({
        ...result.observation,
        content: [result.observation.content, ...postHookNotes]
          .filter(Boolean)
          .join("\n\n"),
      });
    }

    return result;
  } catch (error) {
    if (isActiveProjectChangeError(error)) {
      throw error;
    }

    return {
      observation: createAgentObservation({
        content: getProjectErrorMessage(error),
        ok: false,
        step: observationStep,
        summary: `${step.tool} failed: ${getProjectErrorMessage(error)}`,
        tool: step.tool,
      }),
    };
  }
}

async function executeAgentToolCore(
  store: StoreAccess,
  project: ProjectInfo,
  step: AgentToolCallStep,
  observationStep: number,
  runState: AgentRunState,
): Promise<AgentToolResult> {
  switch (step.tool) {
      case "list_files": {
        const fileTree = await projectApi.listFiles(project.id);
        store.set({ fileTree });

        return {
          observation: createAgentObservation({
            content: formatProjectFileTree(fileTree),
            ok: true,
            step: observationStep,
            summary: "Listed project files.",
            tool: step.tool,
          }),
        };
      }
      case "read_files": {
        const files = await Promise.all(
          step.args.paths.map(async (path) => {
            const content = await projectApi.readFile(project.id, path);
            rememberReadFile(runState, path, content);

            return formatReadFileResult(
              path,
              content,
              step.args.offset,
              step.args.limit,
            );
          }),
        );

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ files }, null, 2),
            ok: true,
            step: observationStep,
            summary: `Read ${files.length} file(s): ${files
              .map((file) => file.path)
              .join(", ")}`,
            tool: step.tool,
          }),
        };
      }
      case "grep_files": {
        const fileTree = await ensureFileTree(store, project);
        const files = getAllowedFilePaths(fileTree)
          .filter((path) => matchesSearchPaths(path, step.args.paths))
          .slice(0, MAX_GREP_FILES);
        const results = await grepProjectFiles(project, files, step.args);

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ results }, null, 2),
            ok: true,
            step: observationStep,
            summary: `Found ${results.length} match(es) for "${step.args.query}".`,
            tool: step.tool,
          }),
        };
      }
      case "glob_files": {
        const fileTree = await ensureFileTree(store, project);
        const matcher = createGlobMatcher(step.args.pattern);
        const matches = getAllowedFilePaths(fileTree)
          .filter((path) => matcher(path))
          .slice(0, step.args.maxResults ?? 100);

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ files: matches }, null, 2),
            ok: true,
            step: observationStep,
            summary: `Matched ${matches.length} file(s) for ${step.args.pattern}.`,
            tool: step.tool,
          }),
        };
      }
      case "edit_file": {
        const currentContent = await requireFreshReadState(
          project,
          runState,
          step.args.path,
        );
        const nextContent = applyTextEdit(currentContent, step.args);

        if (step.args.path === "package.json") {
          validatePackageJsonContent(nextContent);
        }

        const changeRecord = await writeAgentFiles(
          store,
          project,
          [{ path: step.args.path, content: nextContent }],
          step.args.summary,
        );
        rememberReadFile(runState, step.args.path, nextContent);
        ensureCurrentProject(store, project.id);

        store.set((state) => ({
          previewRefreshKey: state.previewRefreshKey + 1,
        }));

        return {
          didChangeFiles: true,
          didChangePackage: step.args.path === "package.json",
          observation: createAgentObservation({
            content: formatChangeRecordMessage(step.args.summary, changeRecord),
            ok: true,
            step: observationStep,
            summary: `Edited ${step.args.path}.`,
            tool: step.tool,
          }),
        };
      }
      case "write_files": {
        for (const file of step.args.files) {
          await requireFreshReadForExistingFile(project, runState, file.path);
        }

        const changeRecord = await writeAgentFiles(
          store,
          project,
          step.args.files,
          step.args.summary,
        );
        for (const file of step.args.files) {
          rememberReadFile(runState, file.path, file.content);
        }
        ensureCurrentProject(store, project.id);

        store.set((state) => ({
          previewRefreshKey: state.previewRefreshKey + 1,
        }));

        return {
          didChangeFiles: true,
          didChangePackage: step.args.files.some(
            (file) => file.path === "package.json",
          ),
          observation: createAgentObservation({
            content: formatChangeRecordMessage(step.args.summary, changeRecord),
            ok: true,
            step: observationStep,
            summary: `Wrote ${step.args.files.length} file(s).`,
            tool: step.tool,
          }),
        };
      }
      case "delete_files": {
        for (const path of step.args.paths) {
          await requireFreshReadState(project, runState, path);
        }

        const changeRecord = await deleteAgentFiles(
          store,
          project,
          step.args.paths,
          step.args.summary,
        );
        ensureCurrentProject(store, project.id);

        store.set((state) => ({
          previewRefreshKey: state.previewRefreshKey + 1,
        }));

        return {
          didChangeFiles: true,
          observation: createAgentObservation({
            content: formatChangeRecordMessage(step.args.summary, changeRecord),
            ok: true,
            step: observationStep,
            summary: `Deleted ${step.args.paths.length} file(s).`,
            tool: step.tool,
          }),
        };
      }
      case "run_command": {
        return {
          observation: await runAgentCommandObservation(
            store,
            project,
            step.args.command,
            observationStep,
            "Ran requested command.",
          ),
        };
      }
      case "apply_supabase_schema": {
        const result = await applySupabaseSchema(project.id, step.args);

        return {
          observation: createAgentObservation({
            content: JSON.stringify(result, null, 2),
            ok: true,
            step: observationStep,
            summary: step.args.summary,
            tool: step.tool,
          }),
        };
      }
      case "start_dev_server": {
        await store.get().startDevServer(project.id);
        ensureCurrentProject(store, project.id);

        const state = store.get();
        const ok = state.devServerStatus === "running";

        return {
          observation: createAgentObservation({
            content: state.previewUrl ?? undefined,
            ok,
            step: observationStep,
            summary: ok
              ? `Preview server is running at ${state.previewUrl}.`
              : "Preview server did not start.",
            tool: step.tool,
          }),
        };
      }
      case "stop_dev_server": {
        await store.get().stopDevServer(project.id);
        ensureCurrentProject(store, project.id);

        const state = store.get();
        const ok = state.devServerStatus === "stopped";

        return {
          observation: createAgentObservation({
            ok,
            step: observationStep,
            summary: ok
              ? "Preview server stopped."
              : "Preview server did not stop cleanly.",
            tool: step.tool,
          }),
        };
      }
      case "refresh_preview": {
        store.get().refreshPreview();

        return {
          observation: createAgentObservation({
            ok: true,
            step: observationStep,
            summary: "Preview refreshed.",
            tool: step.tool,
          }),
        };
      }
  }
}

async function ensureFileTree(store: StoreAccess, project: ProjectInfo) {
  const cachedTree = store.get().fileTree;

  if (cachedTree) {
    return cachedTree;
  }

  const fileTree = await projectApi.listFiles(project.id);
  store.set({ fileTree });
  return fileTree;
}

function rememberReadFile(
  runState: AgentRunState,
  path: string,
  content: string,
) {
  runState.readFiles.set(path, {
    content,
    contentHash: hashText(content),
    path,
    readAt: new Date().toISOString(),
  });
}

async function requireFreshReadState(
  project: ProjectInfo,
  runState: AgentRunState,
  path: string,
) {
  const snapshot = runState.readFiles.get(path);

  if (!snapshot) {
    throw new Error(
      `${path} must be read with read_files in this agent run before it can be edited, deleted, or overwritten.`,
    );
  }

  const currentContent = await projectApi.readFile(project.id, path);
  const currentHash = hashText(currentContent);

  if (currentHash !== snapshot.contentHash) {
    throw new Error(
      `${path} changed after it was read. Read the file again before editing.`,
    );
  }

  return currentContent;
}

async function requireFreshReadForExistingFile(
  project: ProjectInfo,
  runState: AgentRunState,
  path: string,
) {
  let currentContent = "";

  try {
    currentContent = await projectApi.readFile(project.id, path);
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (message.toLowerCase().includes("not found")) {
      return;
    }

    throw error;
  }

  const snapshot = runState.readFiles.get(path);

  if (!snapshot) {
    throw new Error(
      `${path} already exists and must be read with read_files before it can be overwritten.`,
    );
  }

  if (hashText(currentContent) !== snapshot.contentHash) {
    throw new Error(
      `${path} changed after it was read. Read the file again before overwriting.`,
    );
  }
}

function formatReadFileResult(
  path: string,
  content: string,
  offset?: number,
  limit?: number,
) {
  const lines = content.split(/\r?\n/);
  const startLine = Math.min(Math.max(offset ?? 1, 1), Math.max(lines.length, 1));
  const requestedLimit =
    limit ?? (content.length > MAX_READ_FILE_CHARS ? 360 : lines.length);
  const endLine = Math.min(lines.length, startLine + requestedLimit - 1);
  const selectedLines = lines.slice(startLine - 1, endLine);
  const lineNumberWidth = String(endLine).length;
  const lineNumberedContent = selectedLines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(lineNumberWidth, " ");
      return `${lineNumber} | ${line}`;
    })
    .join("\n");

  return {
    content: lineNumberedContent,
    contentHash: hashText(content),
    endLine,
    path,
    readAt: new Date().toISOString(),
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || endLine < lines.length,
  };
}

async function grepProjectFiles(
  project: ProjectInfo,
  files: string[],
  args: Extract<AgentToolCallStep, { tool: "grep_files" }>["args"],
) {
  const results: Array<{
    context: string;
    line: number;
    path: string;
    text: string;
  }> = [];
  const maxResults = args.maxResults ?? 50;
  const contextLines = args.contextLines ?? 0;
  const needle = args.caseSensitive ? args.query : args.query.toLowerCase();

  for (const path of files) {
    if (results.length >= maxResults) {
      break;
    }

    let content = "";

    try {
      content = await projectApi.readFile(project.id, path);
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const haystack = args.caseSensitive ? lines[index] : lines[index].toLowerCase();

      if (!haystack.includes(needle)) {
        continue;
      }

      const contextStart = Math.max(0, index - contextLines);
      const contextEnd = Math.min(lines.length - 1, index + contextLines);

      results.push({
        context: lines
          .slice(contextStart, contextEnd + 1)
          .map((line, contextIndex) => {
            const lineNumber = contextStart + contextIndex + 1;
            return `${lineNumber} | ${line}`;
          })
          .join("\n"),
        line: index + 1,
        path,
        text: lines[index].trim(),
      });

      if (results.length >= maxResults) {
        break;
      }
    }
  }

  return results;
}

function matchesSearchPaths(path: string, prefixes?: string[]) {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return path === prefix || path.startsWith(normalizedPrefix);
  });
}

function createGlobMatcher(pattern: string) {
  const normalizedPattern = pattern.includes("/") ? pattern : `**/${pattern}`;
  const regex = new RegExp(`^${globPatternToRegexSource(normalizedPattern)}$`);

  return (path: string) => regex.test(path);
}

function globPatternToRegexSource(pattern: string) {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegex(char);
  }

  return source;
}

function applyTextEdit(
  content: string,
  args: Extract<AgentToolCallStep, { tool: "edit_file" }>["args"],
) {
  if (args.old_string === args.new_string) {
    throw new Error("edit_file old_string and new_string are identical.");
  }

  const occurrenceCount = countOccurrences(content, args.old_string);

  if (occurrenceCount === 0) {
    throw new Error("edit_file old_string was not found in the current file.");
  }

  if (occurrenceCount > 1 && !args.replace_all) {
    throw new Error(
      `edit_file old_string matched ${occurrenceCount} times. Provide a more specific old_string or set replace_all.`,
    );
  }

  if (args.replace_all) {
    return content.split(args.old_string).join(args.new_string);
  }

  return content.replace(args.old_string, args.new_string);
}

function countOccurrences(content: string, search: string) {
  if (!search) {
    return 0;
  }

  let count = 0;
  let index = 0;

  while (index !== -1) {
    index = content.indexOf(search, index);

    if (index !== -1) {
      count += 1;
      index += search.length;
    }
  }

  return count;
}

export async function runAgentCommandObservation(
  store: StoreAccess,
  project: ProjectInfo,
  command: CommandResult["command"],
  observationStep: number,
  reason: string,
): Promise<AgentObservation> {
  ensureCurrentProject(store, project.id);

  const result = await store.get().runProjectCommand(project.id, command);
  ensureCurrentProject(store, project.id);

  if (!result) {
    return createAgentObservation({
      ok: false,
      step: observationStep,
      summary: `${reason} ${command} did not return a result.`,
      tool: "run_command",
    });
  }

  const exitCode = result.exitCode ?? "unknown";

  return createAgentObservation({
    content: formatCommandObservation(result),
    ok: result.success,
    step: observationStep,
    summary: result.success
      ? `${reason} ${command} succeeded.`
      : `${reason} ${command} failed with exit code ${exitCode}.`,
    tool: "run_command",
  });
}

export function getPreferredProjectCommand(
  store: StoreAccess,
  kind: "build" | "install",
) {
  const fileTree = store.get().fileTree;
  const usesPnpm = fileTree ? hasFilePath(fileTree, "pnpm-lock.yaml") : false;

  if (kind === "install") {
    return usesPnpm ? "pnpm install" : "npm install";
  }

  return usesPnpm ? "pnpm build" : "npm run build";
}

export function ensureCurrentProject(store: StoreAccess, projectId: string) {
  if (store.get().currentProject?.id !== projectId) {
    throw new Error("The active project changed, so this agent step was cancelled.");
  }
}

export function formatAgentToolLabel(step: AgentToolCallStep) {
  switch (step.tool) {
    case "read_files":
      return `read_files ${step.args.paths.join(", ")}`;
    case "grep_files":
      return `grep_files "${step.args.query}"`;
    case "glob_files":
      return `glob_files ${step.args.pattern}`;
    case "edit_file":
      return `edit_file ${step.args.path}`;
    case "write_files":
      return `write_files ${step.args.files.map((file) => file.path).join(", ")}`;
    case "delete_files":
      return `delete_files ${step.args.paths.join(", ")}`;
    case "run_command":
      return `run_command ${step.args.command}`;
    case "apply_supabase_schema":
      return `apply_supabase_schema ${step.args.tables.map((table) => table.name).join(", ")}`;
    default:
      return step.tool;
  }
}

function createAgentObservation(observation: AgentObservation): AgentObservation {
  return {
    ...observation,
    content: observation.content
      ? truncateToolOutput(observation.content)
      : observation.content,
  };
}

function isActiveProjectChangeError(error: unknown) {
  return getProjectErrorMessage(error).includes("active project changed");
}

function hasFilePath(fileTree: FileTree, path: string): boolean {
  if (fileTree.path === path) {
    return true;
  }

  return (fileTree.children ?? []).some((child) => hasFilePath(child, path));
}

function formatCommandObservation(result: CommandResult) {
  const diagnostics = extractCommandDiagnostics(result.output);
  const diagnosticsBlock =
    diagnostics.length > 0
      ? ["", "diagnostics:", JSON.stringify(diagnostics, null, 2)]
      : [];

  return truncateToolOutput(
    [
      `command: ${result.command}`,
      `success: ${String(result.success)}`,
      `exitCode: ${result.exitCode ?? "unknown"}`,
      ...diagnosticsBlock,
      "",
      result.output.trim(),
    ].join("\n"),
  );
}

function extractCommandDiagnostics(output: string) {
  const diagnostics: Array<{
    column?: number;
    line?: number;
    message: string;
    path?: string;
  }> = [];
  const lines = output.split(/\r?\n/);
  const pathPattern =
    "(?:app|components|lib|data|public)/[^\\s:(]+|package\\.json|tsconfig\\.json|next\\.config\\.[^\\s:(]+|tailwind\\.config\\.[^\\s:(]+";

  for (const line of lines) {
    const colonMatch = line.match(
      new RegExp(`(${pathPattern}):(\\d+):(\\d+)\\s*-?\\s*(.*)`),
    );
    const parenMatch = line.match(
      new RegExp(`(${pathPattern})\\((\\d+),(\\d+)\\):\\s*(.*)`),
    );
    const match = colonMatch ?? parenMatch;

    if (match) {
      diagnostics.push({
        column: Number(match[3]),
        line: Number(match[2]),
        message: match[4]?.trim() || line.trim(),
        path: match[1],
      });
    } else if (/^(?:Type error|Error|Failed to compile)/i.test(line.trim())) {
      diagnostics.push({
        message: line.trim(),
      });
    }

    if (diagnostics.length >= 20) {
      break;
    }
  }

  return diagnostics;
}

function truncateToolOutput(content: string) {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) {
    return content;
  }

  const headLength = Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.55);
  const tailLength = MAX_TOOL_OUTPUT_CHARS - headLength;

  return `${content.slice(0, headLength)}\n\n[Tool output truncated. Showing tail.]\n\n${content.slice(-tailLength)}`;
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function escapeRegex(value: string) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}
