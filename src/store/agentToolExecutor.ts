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
import { ensureSiteIndex, refreshSiteIndex } from "../adapters/siteIrAdapter";
import { flattenNodes, findSiteNode } from "../agent-core/site-ir/siteIndex";
import type {
  AgentFailureCode,
  AgentStructuredObservation,
  SuggestedAgentAction,
  PageSpec,
  SiteNode,
  SiteSpec,
} from "../agent-core/types";
import { agentRuntimeApi } from "../services/agentRuntime";
import {
  CommandResult,
  FileTree,
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
} from "../services/projects";
import type { CommandRunLink } from "./commandLogs";
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

export const AGENT_TOOL_EXECUTOR_NAMES = new Set<string>([
  "apply_supabase_schema",
  "delete_files",
  "edit_file",
  "find_site_node",
  "get_page_spec",
  "get_site_spec",
  "glob_files",
  "grep_files",
  "list_files",
  "read_files",
  "replace_file_range",
  "refresh_preview",
  "refresh_site_index",
  "resolve_node_source",
  "run_command",
  "start_dev_server",
  "stop_dev_server",
  "update_design_tokens",
  "write_files",
]);

export type AgentReadFileState = {
  content: string;
  contentHash: string;
  path: string;
  ranges: Array<{ endLine: number; startLine: number }>;
  readAt: string;
};

export type AgentRunState = {
  packageBaselineJson: string | null;
  readFiles: Map<string, AgentReadFileState>;
};

export type AgentToolResult = {
  changedFiles?: string[];
  deletedFiles?: string[];
  didChangeFiles?: boolean;
  didChangePackage?: boolean;
  externalEffects?: string[];
  observation: AgentObservation;
};

export function createAgentRunState(): AgentRunState {
  return {
    packageBaselineJson: null,
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
  commandRunLink?: CommandRunLink,
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
      commandRunLink,
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

    const failure = classifyToolError(step.tool, step.args, error);
    return {
      observation: createAgentObservation({
        content: JSON.stringify(failure, null, 2),
        ok: false,
        step: observationStep,
        structuredData: failure,
        summary: failure.summary,
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
  commandRunLink?: CommandRunLink,
): Promise<AgentToolResult> {
  switch (step.tool) {
      case "list_files": {
        const fileTree = await projectApi.listFiles(project.id);
        const paths = getAllowedFilePaths(fileTree);
        const summary = "Listed project files.";
        store.set({ fileTree });

        return {
          observation: createAgentObservation({
            content: formatProjectFileTree(fileTree),
            ok: true,
            step: observationStep,
            structuredData: buildSearchStructuredObservation({
              fingerprint: buildSearchFingerprint(step.tool, {}),
              newPaths: paths,
              resultCount: paths.length,
              summary,
              tool: step.tool,
            }),
            summary,
            tool: step.tool,
          }),
        };
      }
      case "read_files": {
        const files = await Promise.all(
          step.args.paths.map(async (path) => {
            const content = await projectApi.readFile(project.id, path);
            const file = formatReadFileResult(
              path,
              content,
              step.args.offset,
              step.args.limit,
            );
            rememberReadFile(runState, path, content, {
              endLine: file.endLine,
              startLine: file.startLine,
              totalLines: file.totalLines,
              truncated: file.truncated,
            });

            return file;
          }),
        );

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ files }, null, 2),
            ok: true,
            step: observationStep,
            structuredData: {
              evidence: {
                readFiles: files.map((file) => ({
                  contentHash: file.contentHash,
                  endLine: file.endLine,
                  path: file.path,
                  startLine: file.startLine,
                })),
              },
              ok: true,
              summary: `Read ${files.length} file(s): ${files
                .map((file) => file.path)
                .join(", ")}`,
              tool: step.tool,
            },
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
        const paths = uniqueStrings(results.map((result) => result.path));
        const summary = `Found ${results.length} match(es) for "${step.args.query}".`;

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ results }, null, 2),
            ok: true,
            step: observationStep,
            structuredData: buildSearchStructuredObservation({
              fingerprint: buildSearchFingerprint(step.tool, step.args),
              newPaths: paths,
              resultCount: results.length,
              summary,
              tool: step.tool,
            }),
            summary,
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
        const summary = `Matched ${matches.length} file(s) for ${step.args.pattern}.`;

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ files: matches }, null, 2),
            ok: true,
            step: observationStep,
            structuredData: buildSearchStructuredObservation({
              fingerprint: buildSearchFingerprint(step.tool, step.args),
              newPaths: matches,
              resultCount: matches.length,
              summary,
              tool: step.tool,
            }),
            summary,
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
        rememberPackageBaseline(runState, step.args.path, currentContent);
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

        return {
          changedFiles: changeRecord.files.map((file) => file.path),
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
          if (file.path === "package.json") {
            rememberPackageBaseline(
              runState,
              file.path,
              runState.readFiles.get(file.path)?.content ?? null,
            );
          }
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

        return {
          changedFiles: changeRecord.files.map((file) => file.path),
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

        return {
          changedFiles: changeRecord.files.map((file) => file.path),
          deletedFiles: step.args.paths,
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
            commandRunLink,
          ),
        };
      }
      case "replace_file_range": {
        const currentContent = await requireFreshReadRange(
          project,
          runState,
          step.args.path,
          step.args.startLine,
          step.args.endLine,
        );
        rememberPackageBaseline(runState, step.args.path, currentContent);
        const nextContent = replaceFileLineRange(currentContent, step.args);

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

        return {
          changedFiles: changeRecord.files.map((file) => file.path),
          didChangeFiles: true,
          didChangePackage: step.args.path === "package.json",
          observation: createAgentObservation({
            content: formatChangeRecordMessage(step.args.summary, changeRecord),
            ok: true,
            step: observationStep,
            structuredData: {
              evidence: {
                changedFiles: changeRecord.files.map((file) => file.path),
              },
              ok: true,
              summary: `Replaced lines ${step.args.startLine}-${step.args.endLine} in ${step.args.path}.`,
              tool: step.tool,
            },
            summary: `Replaced lines ${step.args.startLine}-${step.args.endLine} in ${step.args.path}.`,
            tool: step.tool,
          }),
        };
      }
      case "apply_supabase_schema": {
        const result = await applySupabaseSchema(project.id, step.args);
        const tableNames = step.args.tables.map((table) => table.name).join(", ");

        return {
          externalEffects: [
            `Supabase schema applied for table(s): ${tableNames}. ${step.args.summary}`,
          ],
          observation: createAgentObservation({
            content: JSON.stringify(result, null, 2),
            ok: true,
            step: observationStep,
            summary: step.args.summary,
            tool: step.tool,
          }),
        };
      }
      case "get_site_spec": {
        const siteSpec = await ensureSiteIndex(project, store.get().fileTree);

        return {
          observation: createAgentObservation({
            content: JSON.stringify(siteSpec, null, 2),
            ok: true,
            step: observationStep,
            summary: `Loaded SiteSpec with ${siteSpec.pages.length} page(s).`,
            tool: step.tool,
          }),
        };
      }
      case "get_page_spec": {
        const siteSpec = await ensureSiteIndex(project, store.get().fileTree);
        const page = findPageSpec(siteSpec, step.args);

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ page }, null, 2),
            ok: Boolean(page),
            step: observationStep,
            summary: page
              ? `Loaded page spec for ${page.route}.`
              : "No matching page spec was found.",
            tool: step.tool,
          }),
        };
      }
      case "find_site_node": {
        const siteSpec = await ensureSiteIndex(project, store.get().fileTree);
        const matches = findSiteNodes(siteSpec, step.args);

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ matches }, null, 2),
            ok: matches.length > 0,
            step: observationStep,
            summary: `Found ${matches.length} SiteSpec node match(es).`,
            tool: step.tool,
          }),
        };
      }
      case "resolve_node_source": {
        const siteSpec = await ensureSiteIndex(project, store.get().fileTree);
        const sourceMap = await agentRuntimeApi.readSiteSourceMap(project.id);
        const source =
          sourceMap?.entries.find((entry) => entry.nodeId === step.args.nodeId) ??
          findSiteNode(siteSpec, step.args.nodeId)?.source ??
          null;

        return {
          observation: createAgentObservation({
            content: JSON.stringify({ nodeId: step.args.nodeId, source }, null, 2),
            ok: Boolean(source),
            step: observationStep,
            summary: source
              ? `Resolved ${step.args.nodeId} to ${source.path}.`
              : `No source mapping found for ${step.args.nodeId}.`,
            tool: step.tool,
          }),
        };
      }
      case "refresh_site_index": {
        const siteSpec = await refreshSiteIndex(project, store.get().fileTree);

        return {
          observation: createAgentObservation({
            content: JSON.stringify(
              {
                pages: siteSpec.pages.length,
                reason: step.args.reason,
                reusableComponents: siteSpec.reusableComponents.length,
              },
              null,
              2,
            ),
            ok: true,
            step: observationStep,
            summary: `Refreshed SiteSpec with ${siteSpec.pages.length} page(s).`,
            tool: step.tool,
          }),
        };
      }
      case "update_design_tokens": {
        const result = await updateDesignTokens(store, project, step.args);

        return {
          changedFiles: result.changedFiles,
          didChangeFiles: true,
          observation: createAgentObservation({
            content: JSON.stringify(result, null, 2),
            ok: true,
            step: observationStep,
            summary: step.args.summary ?? "Updated design tokens.",
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

function findPageSpec(
  siteSpec: SiteSpec,
  args: { pageId?: string; route?: string },
): PageSpec | null {
  return (
    siteSpec.pages.find(
      (page) =>
        (args.pageId && page.id === args.pageId) ||
        (args.route && page.route === args.route),
    ) ?? null
  );
}

function findSiteNodes(
  siteSpec: SiteSpec,
  args: {
    label?: string;
    nodeId?: string;
    route?: string;
    textHint?: string;
  },
) {
  const pages = args.route
    ? siteSpec.pages.filter((page) => page.route === args.route)
    : siteSpec.pages;
  const normalized = {
    label: args.label?.toLowerCase(),
    nodeId: args.nodeId?.toLowerCase(),
    textHint: args.textHint?.toLowerCase(),
  };

  return pages.flatMap((page) =>
    flattenNodes(page.nodes)
      .filter((node) => matchesSiteNode(node, normalized))
      .map((node) => ({
        node,
        page: {
          id: page.id,
          route: page.route,
          title: page.title,
        },
      })),
  );
}

function matchesSiteNode(
  node: SiteNode,
  query: { label?: string; nodeId?: string; textHint?: string },
) {
  if (query.nodeId && node.id.toLowerCase() === query.nodeId) {
    return true;
  }

  if (query.label && node.label?.toLowerCase().includes(query.label)) {
    return true;
  }

  if (!query.textHint) {
    return false;
  }

  const haystack = [
    node.id,
    node.label,
    node.type,
    JSON.stringify(node.props ?? {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.textHint);
}

async function updateDesignTokens(
  store: StoreAccess,
  project: ProjectInfo,
  args: Extract<AgentToolCallStep, { tool: "update_design_tokens" }>["args"],
) {
  const fileTree = await ensureFileTree(store, project);
  const siteSpec = await ensureSiteIndex(project, fileTree);
  const tokenPath = findDesignTokenPath(fileTree);
  const tokenFileExisted = hasFilePath(fileTree, tokenPath);
  const currentContent = await readOptionalProjectFile(project.id, tokenPath);
  const mergedDesignSystem = {
    colors: {
      ...siteSpec.designSystem.colors,
      ...(args.tokens.colors ?? {}),
    },
    radii: {
      ...siteSpec.designSystem.radii,
      ...(args.tokens.radii ?? {}),
    },
    spacing: {
      ...siteSpec.designSystem.spacing,
      ...(args.tokens.spacing ?? {}),
    },
    typography: {
      ...siteSpec.designSystem.typography,
      ...(args.tokens.typography ?? {}),
    },
  };
  const nextContent = updateCssTokenBlock(currentContent, mergedDesignSystem);
  const nextSiteSpec: SiteSpec = {
    ...siteSpec,
    designSystem: mergedDesignSystem,
  };

  let cssChanged = false;

  try {
    const changeRecord = await writeAgentFiles(
      store,
      project,
      [{ content: nextContent, path: tokenPath }],
      args.summary ?? "Updated design tokens.",
    );
    cssChanged = true;
    await agentRuntimeApi.writeSiteSpec(project.id, nextSiteSpec);
    store.set({ fileTree: await projectApi.listFiles(project.id) });

    return {
      changedFiles: changeRecord.files.map((file) => file.path),
      designSystem: nextSiteSpec.designSystem,
      tokenPath,
    };
  } catch (error) {
    const rollbackErrors: string[] = [];

    if (cssChanged) {
      try {
        if (tokenFileExisted) {
          await writeAgentFiles(
            store,
            project,
            [{ content: currentContent, path: tokenPath }],
            "Rolled back design token CSS after metadata update failed.",
          );
        } else {
          await deleteAgentFiles(
            store,
            project,
            [tokenPath],
            "Rolled back design token CSS after metadata update failed.",
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(getProjectErrorMessage(rollbackError));
      }
    }

    try {
      await agentRuntimeApi.writeSiteSpec(project.id, siteSpec);
    } catch (rollbackError) {
      rollbackErrors.push(getProjectErrorMessage(rollbackError));
    }

    const message = getProjectErrorMessage(error);
    const rollbackSuffix = rollbackErrors.length > 0
      ? ` Rollback also reported: ${rollbackErrors.join("; ")}`
      : "";
    throw new Error(`update_design_tokens failed before committing CSS/SiteSpec together: ${message}.${rollbackSuffix}`);
  }
}

function findDesignTokenPath(fileTree: FileTree) {
  const files = flattenFileTree(fileTree).map((file) => file.path);

  return (
    [
      "app/globals.css",
      "styles/globals.css",
      "styles/tokens.css",
      "styles/nocode-tokens.css",
    ].find((path) => files.includes(path)) ?? "styles/nocode-tokens.css"
  );
}

async function readOptionalProjectFile(projectId: string, path: string) {
  try {
    return await projectApi.readFile(projectId, path);
  } catch (error) {
    const message = getProjectErrorMessage(error).toLowerCase();

    if (message.includes("not found")) {
      return "";
    }

    throw error;
  }
}

function updateCssTokenBlock(
  currentContent: string,
  tokens: SiteSpec["designSystem"],
) {
  const declarations = Object.entries(tokens)
    .flatMap(([group, values]) =>
      Object.entries(values ?? {}).map(
        ([key, value]) => `  --ncb-${toCssTokenName(group)}-${toCssTokenName(key)}: ${value};`,
      ),
    )
    .sort();
  const block = [
    "/* nocode-builder-design-tokens:start */",
    ":root {",
    ...declarations,
    "}",
    "/* nocode-builder-design-tokens:end */",
  ].join("\n");
  const pattern =
    /\/\* nocode-builder-design-tokens:start \*\/[\s\S]*?\/\* nocode-builder-design-tokens:end \*\//;

  if (pattern.test(currentContent)) {
    return currentContent.replace(pattern, block);
  }

  return [currentContent.trimEnd(), "", block, ""].filter(Boolean).join("\n");
}

function toCssTokenName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function flattenFileTree(fileTree: FileTree): FileTree[] {
  return [
    fileTree,
    ...(fileTree.children ?? []).flatMap((child) => flattenFileTree(child)),
  ];
}

function rememberReadFile(
  runState: AgentRunState,
  path: string,
  content: string,
  range?: {
    endLine: number;
    startLine: number;
    totalLines: number;
    truncated: boolean;
  },
) {
  const existing = runState.readFiles.get(path);
  const totalLines = splitContentIntoLines(content).length;
  const ranges = range
    ? mergeReadRanges(
        existing?.contentHash === hashText(content) ? existing.ranges : [],
        [
          range.truncated
            ? { endLine: range.endLine, startLine: range.startLine }
            : { endLine: totalLines, startLine: 1 },
        ],
      )
    : [{ endLine: totalLines, startLine: 1 }];

  runState.readFiles.set(path, {
    content,
    contentHash: hashText(content),
    path,
    ranges,
    readAt: new Date().toISOString(),
  });
}

function rememberPackageBaseline(
  runState: AgentRunState,
  path: string,
  content: string | null,
) {
  if (path !== "package.json" || runState.packageBaselineJson !== null || content === null) {
    return;
  }

  runState.packageBaselineJson = content;
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

async function requireFreshReadRange(
  project: ProjectInfo,
  runState: AgentRunState,
  path: string,
  startLine: number,
  endLine: number,
) {
  const currentContent = await requireFreshReadState(project, runState, path);
  const snapshot = runState.readFiles.get(path);

  if (!snapshot || !isRangeCovered(snapshot.ranges, startLine, endLine)) {
    throw new Error(
      `${path} lines ${startLine}-${endLine} must be read with read_files in this agent run before replace_file_range can edit them.`,
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

function mergeReadRanges(
  current: Array<{ endLine: number; startLine: number }>,
  next: Array<{ endLine: number; startLine: number }>,
) {
  const sorted = [...current, ...next]
    .filter((range) => range.startLine > 0 && range.endLine >= range.startLine)
    .sort((left, right) => left.startLine - right.startLine);
  const merged: Array<{ endLine: number; startLine: number }> = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];

    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.endLine = Math.max(previous.endLine, range.endLine);
  }

  return merged;
}

function isRangeCovered(
  ranges: Array<{ endLine: number; startLine: number }>,
  startLine: number,
  endLine: number,
) {
  return ranges.some(
    (range) => range.startLine <= startLine && range.endLine >= endLine,
  );
}

function replaceFileLineRange(
  content: string,
  args: Extract<AgentToolCallStep, { tool: "replace_file_range" }>["args"],
) {
  const lines = splitContentIntoLines(content);

  if (
    args.startLine < 1 ||
    args.endLine < args.startLine ||
    args.endLine > lines.length
  ) {
    throw new Error(
      `replace_file_range line range ${args.startLine}-${args.endLine} is outside the file's ${lines.length} line(s).`,
    );
  }

  const before = lines
    .slice(0, args.startLine - 1)
    .map((line) => `${line.text}${line.lineEnding}`)
    .join("");
  const replacedSegment = lines
    .slice(args.startLine - 1, args.endLine)
    .map((line) => `${line.text}${line.lineEnding}`)
    .join("");
  const after = lines
    .slice(args.endLine)
    .map((line) => `${line.text}${line.lineEnding}`)
    .join("");
  let replacement = adaptReplacementLineEndings(
    args.newContent,
    replacedSegment,
    content,
  );

  if (after && !/(?:\r\n|\r|\n)$/.test(replacement)) {
    replacement += detectDominantLineEnding(replacedSegment) ??
      detectDominantLineEnding(content) ??
      "\n";
  }

  const nextContent = `${before}${replacement}${after}`;

  if (nextContent === content) {
    throw new Error("replace_file_range produced identical file content.");
  }

  return nextContent;
}

function formatReadFileResult(
  path: string,
  content: string,
  offset?: number,
  limit?: number,
) {
  const lines = splitContentIntoLines(content);
  const startLine = Math.min(Math.max(offset ?? 1, 1), Math.max(lines.length, 1));
  const requestedLimit =
    limit ?? (content.length > MAX_READ_FILE_CHARS ? 360 : lines.length);
  const endLine = Math.min(lines.length, startLine + requestedLimit - 1);
  const selectedLines = lines.slice(startLine - 1, endLine);
  const lineNumberWidth = String(endLine).length;
  const lineNumberedContent = selectedLines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(lineNumberWidth, " ");
      return `${lineNumber} | ${line.text}`;
    })
    .join("\n");
  const exactContent = selectedLines
    .map((line, index) =>
      index < selectedLines.length - 1 ? `${line.text}${line.lineEnding}` : line.text,
    )
    .join("");

  return {
    content: exactContent,
    contentHash: hashText(content),
    endLine,
    numberedContent: lineNumberedContent,
    path,
    readAt: new Date().toISOString(),
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || endLine < lines.length,
  };
}

function splitContentIntoLines(content: string) {
  const lines: Array<{ lineEnding: string; text: string }> = [];
  let lineStart = 0;

  for (let index = 0; index < content.length;) {
    const char = content[index];

    if (char === "\r" || char === "\n") {
      const lineEnding =
        char === "\r" && content[index + 1] === "\n" ? "\r\n" : char;
      lines.push({
        lineEnding,
        text: content.slice(lineStart, index),
      });
      index += lineEnding.length;
      lineStart = index;
      continue;
    }

    index += 1;
  }

  lines.push({
    lineEnding: "",
    text: content.slice(lineStart),
  });

  return lines;
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

  const exactEdit = tryApplyExactTextEdit(
    content,
    args.old_string,
    args.new_string,
    args.replace_all,
  );

  if (exactEdit !== null) {
    return exactEdit;
  }

  const lineEndingEdit = tryApplyLineEndingNormalizedTextEdit(
    content,
    args.old_string,
    args.new_string,
    args.replace_all,
  );

  if (lineEndingEdit !== null) {
    return lineEndingEdit;
  }

  const strippedOldString = stripReadFilesLinePrefixes(args.old_string);

  if (strippedOldString !== null && strippedOldString !== args.old_string) {
    const strippedNewString =
      stripReadFilesLinePrefixes(args.new_string) ?? args.new_string;
    const strippedExactEdit = tryApplyExactTextEdit(
      content,
      strippedOldString,
      strippedNewString,
      args.replace_all,
    );

    if (strippedExactEdit !== null) {
      return strippedExactEdit;
    }

    const strippedLineEndingEdit = tryApplyLineEndingNormalizedTextEdit(
      content,
      strippedOldString,
      strippedNewString,
      args.replace_all,
    );

    if (strippedLineEndingEdit !== null) {
      return strippedLineEndingEdit;
    }
  }

  throw new Error(
    "edit_file old_string was not found in the current file. If copying from read_files, use the exact content field and omit numberedContent line prefixes.",
  );
}

function tryApplyExactTextEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
) {
  const occurrenceCount = countOccurrences(content, oldString);

  if (occurrenceCount === 0) {
    return null;
  }

  if (occurrenceCount > 1 && !replaceAll) {
    throw new Error(
      `edit_file old_string matched ${occurrenceCount} times. Provide a more specific old_string or set replace_all.`,
    );
  }

  return replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
}

function tryApplyLineEndingNormalizedTextEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
) {
  const normalizedContent = normalizeLineEndingsWithMap(content);
  const normalizedOldString = normalizeLineEndings(oldString);

  if (
    normalizedContent.content === content &&
    normalizedOldString === oldString
  ) {
    return null;
  }

  const ranges = findNormalizedMatchRanges(
    normalizedContent.content,
    normalizedOldString,
    normalizedContent.originalIndexByNormalizedIndex,
    content.length,
  );

  if (ranges.length === 0) {
    return null;
  }

  if (ranges.length > 1 && !replaceAll) {
    throw new Error(
      `edit_file old_string matched ${ranges.length} times after normalizing line endings. Provide a more specific old_string or set replace_all.`,
    );
  }

  let nextContent = content;

  for (const range of ranges.slice().reverse()) {
    const originalSegment = content.slice(range.start, range.end);
    const replacement = adaptReplacementLineEndings(
      newString,
      originalSegment,
      content,
    );
    nextContent =
      nextContent.slice(0, range.start) +
      replacement +
      nextContent.slice(range.end);
  }

  return nextContent;
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n|\r/g, "\n");
}

function normalizeLineEndingsWithMap(value: string) {
  let content = "";
  const originalIndexByNormalizedIndex: number[] = [];

  for (let index = 0; index < value.length;) {
    const char = value[index];

    if (char === "\r") {
      content += "\n";
      originalIndexByNormalizedIndex.push(index);
      index += value[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    content += char;
    originalIndexByNormalizedIndex.push(index);
    index += 1;
  }

  return { content, originalIndexByNormalizedIndex };
}

function findNormalizedMatchRanges(
  normalizedContent: string,
  normalizedSearch: string,
  originalIndexByNormalizedIndex: number[],
  originalContentLength: number,
) {
  const ranges: Array<{ end: number; start: number }> = [];

  if (!normalizedSearch) {
    return ranges;
  }

  let index = 0;

  while (index !== -1) {
    index = normalizedContent.indexOf(normalizedSearch, index);

    if (index === -1) {
      break;
    }

    const normalizedEnd = index + normalizedSearch.length;
    const end =
      normalizedEnd >= normalizedContent.length
        ? originalContentLength
        : originalIndexByNormalizedIndex[normalizedEnd];

    ranges.push({
      end,
      start: originalIndexByNormalizedIndex[index],
    });
    index += normalizedSearch.length;
  }

  return ranges;
}

function adaptReplacementLineEndings(
  replacement: string,
  originalSegment: string,
  fullContent: string,
) {
  const lineEnding =
    detectDominantLineEnding(originalSegment) ??
    detectDominantLineEnding(fullContent);

  if (!lineEnding) {
    return replacement;
  }

  return normalizeLineEndings(replacement).replace(/\n/g, lineEnding);
}

function detectDominantLineEnding(value: string) {
  const crlf = countOccurrences(value, "\r\n");
  const withoutCrlf = value.replace(/\r\n/g, "");
  const lf = countOccurrences(withoutCrlf, "\n");
  const cr = countOccurrences(withoutCrlf, "\r");

  if (crlf === 0 && lf === 0 && cr === 0) {
    return null;
  }

  if (crlf >= lf && crlf >= cr) {
    return "\r\n";
  }

  return lf >= cr ? "\n" : "\r";
}

function stripReadFilesLinePrefixes(value: string) {
  const lines = value.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (
    nonEmptyLines.length === 0 ||
    !nonEmptyLines.every((line) => /^\s*\d+\s+\|\s?/.test(line))
  ) {
    return null;
  }

  return lines
    .map((line) => line.replace(/^\s*\d+\s+\|\s?/, ""))
    .join("\n");
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
  link?: CommandRunLink,
): Promise<AgentObservation> {
  ensureCurrentProject(store, project.id);

  const result = await store.get().runProjectCommand(project.id, command, link);
  ensureCurrentProject(store, project.id);

  if (!result) {
    const structuredData: AgentStructuredObservation = {
      ok: false,
      tool: "run_command",
      summary: `${reason} ${command} did not return a result.`,
      error: {
        code: "COMMAND_FAILED",
        message: `${command} did not return a result.`,
        retryable: true,
        suggestedAction: {
          type: "tool_call",
          tool: "run_command",
          args: { command },
          rationale: "Retry the allowed command once if the missing result was transient.",
        },
      },
      evidence: {
        command,
        commandSuccess: false,
      },
    };

    return createAgentObservation({
      content: JSON.stringify(structuredData, null, 2),
      ok: false,
      step: observationStep,
      structuredData,
      summary: `${reason} ${command} did not return a result.`,
      tool: "run_command",
    });
  }

  const exitCode = result.exitCode ?? "unknown";

  const diagnostics = extractCommandDiagnostics(result.output);
  const structuredData: AgentStructuredObservation = result.success
    ? {
        evidence: {
          command,
          commandSuccess: true,
        },
        ok: true,
        summary: `${reason} ${command} succeeded.`,
        tool: "run_command",
      }
    : {
        evidence: {
          command,
          commandSuccess: false,
        },
        error: {
          code: "COMMAND_FAILED",
          diagnostics,
          message: `${command} failed with exit code ${exitCode}.`,
          retryable: true,
        },
        ok: false,
        summary: `${reason} ${command} failed with exit code ${exitCode}.`,
        tool: "run_command",
      };

  return createAgentObservation({
    content: result.success
      ? formatCommandObservation(result)
      : JSON.stringify({
          ...structuredData,
          output: formatCommandObservation(result),
        }, null, 2),
    ok: result.success,
    step: observationStep,
    structuredData,
    summary: structuredData.summary,
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
    case "get_site_spec":
      return "get_site_spec";
    case "get_page_spec":
      return `get_page_spec ${step.args.route ?? step.args.pageId ?? ""}`.trim();
    case "find_site_node":
      return `find_site_node ${step.args.nodeId ?? step.args.label ?? step.args.textHint ?? step.args.route ?? ""}`.trim();
    case "update_design_tokens":
      return "update_design_tokens";
    case "resolve_node_source":
      return `resolve_node_source ${step.args.nodeId}`;
    case "refresh_site_index":
      return "refresh_site_index";
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

function buildSearchStructuredObservation({
  fingerprint,
  newPaths,
  resultCount,
  summary,
  tool,
}: {
  fingerprint: string;
  newPaths: string[];
  resultCount: number;
  summary: string;
  tool: "list_files" | "grep_files" | "glob_files";
}): AgentStructuredObservation {
  return {
    evidence: {
      searches: [
        {
          fingerprint,
          newPaths: uniqueStrings(newPaths),
          resultCount,
          summary,
          tool,
        },
      ],
    },
    ok: true,
    summary,
    tool,
  };
}

function buildSearchFingerprint(tool: string, args: unknown) {
  return `${tool}:${stableJson(args)}`;
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

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyToolError(
  tool: string,
  args: unknown,
  error: unknown,
): AgentStructuredObservation {
  const message = getProjectErrorMessage(error);
  const lowerMessage = message.toLowerCase();
  const relatedFiles = collectToolRelatedFiles(args);
  const code: AgentFailureCode =
    /old_string.*not found/i.test(message)
      ? "OLD_STRING_NOT_FOUND"
      : /old_string and new_string are identical|produced identical file content/i.test(message)
        ? "IDENTICAL_EDIT"
        : /changed after it was read|read the file again before/i.test(message)
          ? "STALE_READ"
          : /must be read with read_files|already exists and must be read/i.test(message)
            ? "MUST_READ_BEFORE_WRITE"
            : /package\.json|invalid package|could not parse/i.test(message)
              ? "PACKAGE_INVALID"
              : "UNKNOWN_RUNTIME_FAILURE";
  const retryable = code !== "PACKAGE_INVALID" && code !== "UNKNOWN_RUNTIME_FAILURE";
  const suggestedAction = buildSuggestedActionForToolFailure(
    code,
    tool,
    relatedFiles,
    message,
  );
  const summary = `${tool} failed: ${code}`;

  return {
    ok: false,
    tool,
    summary,
    error: {
      code,
      fingerprint: buildFailureFingerprint(code, tool, relatedFiles, lowerMessage),
      message,
      retryable,
      relatedFiles,
      suggestedAction,
    },
  };
}

function buildSuggestedActionForToolFailure(
  code: AgentFailureCode,
  tool: string,
  relatedFiles: string[],
  message: string,
): SuggestedAgentAction | undefined {
  if (
    relatedFiles.length > 0 &&
    (
      code === "MUST_READ_BEFORE_WRITE" ||
      code === "STALE_READ" ||
      code === "OLD_STRING_NOT_FOUND"
    )
  ) {
    return {
      type: "tool_call",
      tool: "read_files",
      args: { paths: relatedFiles },
      rationale: `Refresh file evidence before retrying ${tool}.`,
    };
  }

  if (code === "IDENTICAL_EDIT") {
    return {
      type: "finish_candidate",
      summary: "The requested file content already appears to match the target state.",
      verification: message,
    };
  }

  return undefined;
}

function collectToolRelatedFiles(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }

  const record = args as Record<string, unknown>;
  const paths = new Set<string>();

  if (typeof record.path === "string") {
    paths.add(record.path);
  }

  if (Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === "string") {
        paths.add(path);
      }
    }
  }

  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (
        typeof file === "object" &&
        file !== null &&
        typeof (file as { path?: unknown }).path === "string"
      ) {
        paths.add((file as { path: string }).path);
      }
    }
  }

  return [...paths];
}

function buildFailureFingerprint(
  code: AgentFailureCode,
  tool: string,
  relatedFiles: string[],
  message: string,
) {
  return `${code}:${tool}:${relatedFiles.sort().join(",")}:${message
    .replace(/\d+/g, "n")
    .replace(/\s+/g, " ")
    .slice(0, 240)}`;
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
    codeFrame?: string[];
    line?: number;
    message: string;
    path?: string;
  }> = [];
  const lines = output.split(/\r?\n/).map((line) => stripAnsi(line).trimEnd());
  const pathPattern =
    "(?:\\.\\/)?(?:(?:app|components|lib|data|public)/[^\\s:(]+|package\\.json|tsconfig\\.json|next\\.config\\.[^\\s:(]+|tailwind\\.config\\.[^\\s:(]+)";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const colonMatch = line.match(
      new RegExp(`(${pathPattern}):(\\d+):(\\d+)\\s*-?\\s*(.*)`),
    );
    const parenMatch = line.match(
      new RegExp(`(${pathPattern})\\((\\d+),(\\d+)\\):\\s*(.*)`),
    );
    const match = colonMatch ?? parenMatch;

    if (match) {
      const following = collectFollowingCodeFrame(lines, index + 1);
      diagnostics.push({
        column: Number(match[3]),
        codeFrame: following.length > 0 ? following : undefined,
        line: Number(match[2]),
        message: collectDiagnosticMessage(lines, index, match[4]?.trim() || line.trim()),
        path: (match[1] ?? "").replace(/^\.\//, ""),
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

function collectDiagnosticMessage(
  lines: string[],
  locationIndex: number,
  fallback: string,
) {
  for (let index = locationIndex + 1; index < Math.min(lines.length, locationIndex + 4); index += 1) {
    const line = lines[index]?.trim() ?? "";

    if (/^(?:Type error|Error|Failed)/i.test(line)) {
      return line;
    }
  }

  return fallback;
}

function collectFollowingCodeFrame(lines: string[], startIndex: number) {
  const frame: string[] = [];

  for (let index = startIndex; index < Math.min(lines.length, startIndex + 8); index += 1) {
    const line = lines[index] ?? "";

    if (!line.trim() && frame.length > 0) {
      break;
    }

    if (/^\s*(?:>?\s*\d+\s*\||\|)/.test(line)) {
      frame.push(line.trim());
    } else if (frame.length > 0) {
      break;
    }
  }

  return frame;
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
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
