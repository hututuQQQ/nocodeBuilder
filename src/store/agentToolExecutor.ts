import {
  AgentObservation,
  AgentToolCallStep,
  formatProjectFileTree,
} from "../agent/projectModifier";
import {
  CommandResult,
  FileTree,
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
} from "../services/projects";
import { deleteAgentFiles, writeAgentFiles } from "./agentFileChanges";
import { formatChangeRecordMessage } from "./changeHistory";
import type { StoreAccess } from "./storeAccess";

const MAX_TOOL_OUTPUT_CHARS = 18_000;

export type AgentToolResult = {
  didChangeFiles?: boolean;
  didChangePackage?: boolean;
  observation: AgentObservation;
};

export async function executeAgentTool(
  store: StoreAccess,
  project: ProjectInfo,
  step: AgentToolCallStep,
  observationStep: number,
): Promise<AgentToolResult> {
  try {
    ensureCurrentProject(store, project.id);

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
          step.args.paths.map(async (path) => ({
            path,
            content: await projectApi.readFile(project.id, path),
          })),
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
      case "write_files": {
        const changeRecord = await writeAgentFiles(
          store,
          project,
          step.args.files,
          step.args.summary,
        );
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
      case "rollback_last_change": {
        const record = store
          .get()
          .changeHistory.find((change) => change.projectId === project.id);

        if (!record) {
          return {
            observation: createAgentObservation({
              ok: false,
              step: observationStep,
              summary: "No agent change is available to roll back.",
              tool: step.tool,
            }),
          };
        }

        await store.get().rollbackLastChange();
        ensureCurrentProject(store, project.id);

        const wasRemoved = !store
          .get()
          .changeHistory.some((change) => change.id === record.id);

        return {
          didChangeFiles: wasRemoved,
          observation: createAgentObservation({
            content: record.files.map((file) => file.path).join(", "),
            ok: wasRemoved,
            step: observationStep,
            summary: wasRemoved
              ? `Rolled back ${record.files.length} file change(s).`
              : "Rollback did not complete.",
            tool: step.tool,
          }),
        };
      }
    }
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
    case "write_files":
      return `write_files ${step.args.files.map((file) => file.path).join(", ")}`;
    case "delete_files":
      return `delete_files ${step.args.paths.join(", ")}`;
    case "run_command":
      return `run_command ${step.args.command}`;
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
  return truncateToolOutput(
    [
      `command: ${result.command}`,
      `success: ${String(result.success)}`,
      `exitCode: ${result.exitCode ?? "unknown"}`,
      "",
      result.output.trim(),
    ].join("\n"),
  );
}

function truncateToolOutput(content: string) {
  if (content.length <= MAX_TOOL_OUTPUT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Tool output truncated.]`;
}
