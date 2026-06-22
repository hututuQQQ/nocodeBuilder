import {
  AgentObservation,
  AgentStepResponse,
  AgentToolCallStep,
  formatProjectFileTree,
  getContextFilePaths,
  requestAgentStep,
  requestProjectGeneration,
} from "../agent/projectModifier";
import {
  buildProjectBackendContext,
  hasBackendIntent,
} from "../agent/project/backendContext";
import { buildDynamicAgentContext } from "../agent/project/memory";
import { keyStore } from "../services/keyStore";
import {
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
} from "../services/projects";
import {
  formatChangeRecordMessage,
} from "./changeHistory";
import { getAiProviderDefinition } from "../services/aiProviders";
import { appendLogs } from "./commandLogs";
import {
  persistCurrentConversation,
} from "./conversationState";
import {
  appendAssistantMessage,
  appendTerminalLog,
  type AgentActivityInput,
  type AgentStreamController,
  startStreamingAgentMessage,
  updateAgentStatus,
} from "./agentUi";
import { writeAgentFiles } from "./agentFileChanges";
import {
  createAgentRunState,
  ensureCurrentProject,
  executeAgentTool,
  executeAgentToolBatch,
  formatAgentToolLabel,
  getPreferredProjectCommand,
  runAgentCommandObservation,
} from "./agentToolExecutor";
import type { StoreAccess } from "./storeAccess";

const MAX_AGENT_STEPS = 10;
const MAX_AGENT_REPAIR_ATTEMPTS = 2;
const MAX_AGENT_DIAGNOSTIC_CHARS = 6_000;
const MAX_AGENT_DIAGNOSTIC_LINES = 36;

export async function generateInitialProject(
  store: StoreAccess,
  project: ProjectInfo,
  projectPrompt: string,
) {
  const stream = startStreamingAgentMessage(
    store,
    `Generating ${project.name} with the model`,
  );

  store.set((state) => ({
    isGeneratingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Generating Next.js project files for ${project.name}`,
    ]),
  }));

  try {
    const config = await keyStore.getAiProviderConfig();

    if (!config) {
      throw new Error("Configure your AI provider first.");
    }

    const backendContext = await buildProjectBackendContext(project.id, {
      includeSchema: hasBackendIntent(projectPrompt),
    });
    const response = await requestProjectGeneration({
      backendContext,
      config,
      onDelta: stream.onModelDelta,
      projectName: project.name,
      userPrompt: projectPrompt,
    });
    stream.setStatus("Model output received. Applying files...");
    const writeActivityId = stream.addActivity({
      detail: `${response.files.length} file(s) returned by the model.`,
      kind: "file",
      title: "Writing project files",
    });

    const changeRecord = await writeAgentFiles(
      store,
      project,
      response.files,
      response.summary,
    );
    stream.updateActivity(writeActivityId, {
      detail: response.summary,
      finishActivity: true,
      status: "succeeded",
    });

    if (store.get().currentProject?.id === project.id) {
      stream.completeWithTypewriter(
        formatChangeRecordMessage(response.summary, changeRecord),
      );
      void persistCurrentConversation(store);

      store.set((state) => ({
        previewRefreshKey: state.previewRefreshKey + 1,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] ${response.summary}`,
        ]),
      }));
    }

    return true;
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (store.get().currentProject?.id === project.id) {
      stream.failWithTypewriter(
        `Project generation failed: ${message}`,
      );
      void persistCurrentConversation(store);
    }

    store.set((state) => ({
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
    }));

    return false;
  } finally {
    store.set({ isGeneratingProject: false });
  }
}

export async function modifyCurrentProject(
  store: StoreAccess,
  userRequest: string,
) {
  const project = store.get().currentProject;

  if (!project) {
    appendAssistantMessage(
      store,
      "Create or select a project first, then describe what to build.",
    );
    return;
  }

  const activeStream = startStreamingAgentMessage(
    store,
    "Working with the project agent",
  );
  const statusLines: string[] = [];
  const observations: AgentObservation[] = [];
  const runState = createAgentRunState();
  let didChangeFiles = false;
  let repairAttempts = 0;
  let buildVerified = false;
  let previewNeedsFinalRefresh = false;

  store.set((state) => ({
    isModifyingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Starting tool workflow for ${project.name}`,
    ]),
  }));

  try {
    const config = await keyStore.getAiProviderConfig();

    if (!config) {
      throw new Error("Configure your AI provider first.");
    }

    const provider = getAiProviderDefinition(config.provider);
    appendTerminalLog(
      store,
      `[agent] Using ${provider.label} model ${config.model}`,
    );
    updateAgentStatus(activeStream, statusLines, "Collecting project context.");
    const contextActivityId = activeStream.addActivity({
      detail: "Reading the project file tree and current workspace state.",
      kind: "tool",
      title: "Collecting project context",
    });

    let fileTree = store.get().fileTree;

    if (!fileTree) {
      fileTree = await projectApi.listFiles(project.id);
      store.set({ fileTree });
    }

    const contextFilePaths = getContextFilePaths(fileTree);
    activeStream.updateActivity(contextActivityId, {
      detail:
        contextFilePaths.length > 0
          ? `Found ${contextFilePaths.length} editable context file(s).`
          : "No editable project files were found.",
      finishActivity: true,
      status: "succeeded",
    });

    if (contextFilePaths.length === 0) {
      appendTerminalLog(
        store,
        "[agent] No editable files found, generating a full Next.js project",
      );
      updateAgentStatus(
        activeStream,
        statusLines,
        "No editable files found. Generating a full project.",
      );

      const backendContext = await buildProjectBackendContext(project.id, {
        includeSchema: hasBackendIntent(userRequest),
      });
      const response = await requestProjectGeneration({
        backendContext,
        config,
        onDelta: activeStream.onModelDelta,
        projectName: project.name,
        userPrompt: userRequest,
      });
      updateAgentStatus(
        activeStream,
        statusLines,
        "Model output received. Applying files.",
      );
      const writeActivityId = activeStream.addActivity({
        detail: `${response.files.length} file(s) returned by the model.`,
        kind: "file",
        title: "Writing project files",
      });

      const changeRecord = await writeAgentFiles(
        store,
        project,
        response.files,
        response.summary,
      );
      activeStream.updateActivity(writeActivityId, {
        detail: response.summary,
        finishActivity: true,
        status: "succeeded",
      });

      if (store.get().currentProject?.id !== project.id) {
        return;
      }

      activeStream.completeWithTypewriter(
        formatChangeRecordMessage(response.summary, changeRecord),
      );
      void persistCurrentConversation(store);

      store.set((state) => ({
        previewRefreshKey: state.previewRefreshKey + 1,
        terminalLogs: appendLogs(state.terminalLogs, [
          `[agent] ${response.summary}`,
        ]),
      }));

      void store.get().bootstrapProject(project.id);
      return;
    }

    for (let stepIndex = 1; stepIndex <= MAX_AGENT_STEPS; stepIndex += 1) {
      ensureCurrentProject(store, project.id);
      updateAgentStatus(
        activeStream,
        statusLines,
        `Planning step ${stepIndex}.`,
      );
      const planningActivityId = activeStream.addActivity({
        detail: "Asking the model for the next project action.",
        kind: "thinking",
        title: `Planning step ${stepIndex}`,
      });

      let step: AgentStepResponse;

      try {
        step = await requestAgentStep({
          config,
          context: await buildAgentStepContext(
            store,
            project,
            observations,
            runState,
            userRequest,
          ),
          onDelta: activeStream.onModelDelta,
          userRequest,
        });
        activeStream.updateActivity(planningActivityId, {
          detail: formatAgentStepLabelForStatus(step),
          finishActivity: true,
          status: "succeeded",
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);

        if (!isRecoverableAgentPlanningError(message)) {
          activeStream.updateActivity(planningActivityId, {
            detail: message,
            error: message,
            finishActivity: true,
            status: "failed",
          });
          throw error;
        }

        const observation: AgentObservation = {
          content: [
            message,
            "Do not run install commands with package names. If a dependency is needed, edit package.json with an exact pinned version; the host will run the project install command automatically after package.json changes.",
          ].join("\n"),
          ok: false,
          step: observations.length + 1,
          summary: "Agent proposed a forbidden package install command.",
          tool: "run_command",
        };
        observations.push(observation);
        appendTerminalLog(store, `[agent:error] ${observation.summary}`);
        activeStream.updateActivity(planningActivityId, {
          detail: observation.summary,
          error: message,
          finishActivity: true,
          status: "failed",
        });
        updateAgentStatus(
          activeStream,
          statusLines,
          "The agent proposed a forbidden install command. Asking it to repair the plan.",
        );
        continue;
      }
      ensureCurrentProject(store, project.id);

      if (step.type === "answer") {
        if (shouldRequireProjectActionBeforeAnswer(userRequest, observations)) {
          const observation: AgentObservation = {
            content: [
              "The model tried to answer before inspecting the project.",
              "For bug, error, broken preview, fix, or change requests, inspect diagnostics and relevant files first, then modify or explain based on observations.",
              `Proposed answer: ${step.message}`,
            ].join("\n"),
            ok: false,
            step: observations.length + 1,
            summary: "Answer was not enough for this project action request.",
            tool: "answer",
          };
          observations.push(observation);
          appendTerminalLog(store, `[agent:error] ${observation.summary}`);
          updateAgentStatus(
            activeStream,
            statusLines,
            "The model answered too early. Asking it to inspect the project first.",
          );
          continue;
        }

        if (previewNeedsFinalRefresh && buildVerified) {
          await refreshPreviewAfterFinalAgentChange(
            store,
            project.id,
            activeStream,
            statusLines,
          );
        }

        activeStream.completeWithTypewriter(step.message);
        void persistCurrentConversation(store);

        store.set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [`[agent] answered`]),
        }));
        return;
      }

      if (step.type === "finish") {
        if (previewNeedsFinalRefresh && buildVerified) {
          await refreshPreviewAfterFinalAgentChange(
            store,
            project.id,
            activeStream,
            statusLines,
          );
        }

        const content = formatAgentFinishMessage(step, {
          buildVerified,
          didChangeFiles,
        });

        activeStream.completeWithTypewriter(content);
        void persistCurrentConversation(store);

        store.set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [`[agent] ${step.summary}`]),
        }));
        return;
      }

      updateAgentStatus(activeStream, statusLines, `Tool: ${formatAgentStepLabel(step)}.`);
      const activityIds = createToolActivities(activeStream, step);

      const results =
        step.type === "tool_calls"
          ? await executeAgentToolBatch(
              store,
              project,
              step,
              observations.length + 1,
              runState,
            )
          : [
              await executeAgentTool(
                store,
                project,
                step,
                observations.length + 1,
                runState,
                step.tool === "run_command"
                  ? {
                      chatActivityId: activityIds[0],
                      chatMessageId: activeStream.messageId,
                    }
                  : undefined,
              ),
            ];

      for (const [resultIndex, result] of results.entries()) {
        observations.push(result.observation);
        const activityId = activityIds[resultIndex];

        if (activityId) {
          activeStream.updateActivity(activityId, {
            detail: result.observation.summary,
            error: result.observation.ok ? undefined : result.observation.summary,
            finishActivity: true,
            outputPreview: result.observation.content
              ?.split(/\r?\n/)
              .filter(Boolean)
              .slice(-6),
            status: result.observation.ok ? "succeeded" : "failed",
          });
        }
        appendTerminalLog(
          store,
          `[agent:${result.observation.ok ? "ok" : "error"}] ${result.observation.summary}`,
        );
      }

      const stepChangedFiles = results.some((result) => result.didChangeFiles);
      const stepChangedPackage = results.some((result) => result.didChangePackage);

      if (stepChangedFiles) {
        didChangeFiles = true;
        buildVerified = false;
        previewNeedsFinalRefresh = true;

        if (stepChangedPackage) {
          const installCommand = getPreferredProjectCommand(store, "install");
          const installActivityId = activeStream.addActivity({
            command: installCommand,
            detail: "package.json changed, so dependencies need to be installed.",
            kind: "command",
            title: "Installing dependencies",
          });
          const installObservation = await runAgentCommandObservation(
            store,
            project,
            installCommand,
            observations.length + 1,
            "Installing dependencies after package.json changed.",
            {
              chatActivityId: installActivityId,
              chatMessageId: activeStream.messageId,
            },
          );
          observations.push(installObservation);
          activeStream.updateActivity(installActivityId, {
            detail: installObservation.summary,
            error: installObservation.ok ? undefined : installObservation.summary,
            finishActivity: true,
            outputPreview: installObservation.content
              ?.split(/\r?\n/)
              .filter(Boolean)
              .slice(-6),
            status: installObservation.ok ? "succeeded" : "failed",
          });
          appendTerminalLog(
            store,
            `[agent:${installObservation.ok ? "ok" : "error"}] ${installObservation.summary}`,
          );

          if (!installObservation.ok) {
            continue;
          }
        }

        const buildCommand = getPreferredProjectCommand(store, "build");
        const buildActivityId = activeStream.addActivity({
          command: buildCommand,
          detail: "Checking that the project still builds after file changes.",
          kind: "verification",
          title: "Verifying build",
        });
        const buildObservation = await runAgentCommandObservation(
          store,
          project,
          buildCommand,
          observations.length + 1,
          "Verifying project build after file changes.",
          {
            chatActivityId: buildActivityId,
            chatMessageId: activeStream.messageId,
          },
        );
        observations.push(buildObservation);
        activeStream.updateActivity(buildActivityId, {
          detail: buildObservation.summary,
          error: buildObservation.ok ? undefined : buildObservation.summary,
          finishActivity: true,
          outputPreview: buildObservation.content
            ?.split(/\r?\n/)
            .filter(Boolean)
            .slice(-6),
          status: buildObservation.ok ? "succeeded" : "failed",
        });
        appendTerminalLog(
          store,
          `[agent:${buildObservation.ok ? "ok" : "error"}] ${buildObservation.summary}`,
        );

        if (buildObservation.ok) {
          buildVerified = true;
          updateAgentStatus(activeStream, statusLines, "Build verification passed.");
        } else if (repairAttempts < MAX_AGENT_REPAIR_ATTEMPTS) {
          repairAttempts += 1;
          updateAgentStatus(
            activeStream,
            statusLines,
            `Build failed. Asking the agent for focused repair ${repairAttempts}/${MAX_AGENT_REPAIR_ATTEMPTS}.`,
          );
        } else {
          const content = [
            "Change applied, but build verification is still failing.",
            "",
            buildObservation.summary,
            "",
            "Review the changed files in the file panel before continuing.",
          ].join("\n");

          activeStream.failWithTypewriter(content);
          void persistCurrentConversation(store);

          store.set({ projectError: buildObservation.summary });
          return;
        }
      }
    }

    if (previewNeedsFinalRefresh && buildVerified) {
      await refreshPreviewAfterFinalAgentChange(
        store,
        project.id,
        activeStream,
        statusLines,
      );
    }

    activeStream.failWithTypewriter(
      [
        "I stopped after reaching the agent step limit.",
        "",
        didChangeFiles
          ? "Some project files were changed."
          : "No project files were changed.",
      ].join("\n"),
    );
    void persistCurrentConversation(store);

    store.set((state) => ({
      terminalLogs: appendLogs(state.terminalLogs, [
        "[agent:error] stopped after reaching step limit",
      ]),
    }));
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (store.get().currentProject?.id === project.id) {
      activeStream.failWithTypewriter(
        `Agent workflow failed: ${message}`,
      );
      void persistCurrentConversation(store);
    }

    store.set((state) => ({
      projectError: message,
      terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
    }));
  } finally {
    store.set({ isModifyingProject: false });
  }
}

async function buildAgentStepContext(
  store: StoreAccess,
  project: ProjectInfo,
  observations: AgentObservation[],
  runState: ReturnType<typeof createAgentRunState>,
  userRequest: string,
) {
  const state = store.get();
  const recentMessages = (state.currentConversation?.messages ?? [])
    .filter((message) => message.id !== "welcome" && !message.isStreaming)
    .slice(-8)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
  const backendIntentText = [
    userRequest,
    ...recentMessages.map((message) => message.content),
  ].join("\n");
  const backendContext = await buildProjectBackendContext(project.id, {
    includeSchema: hasBackendIntent(backendIntentText),
  });
  const dynamicContext = await buildDynamicAgentContext({
    changeHistory: state.changeHistory,
    fileTree: state.fileTree,
    observations,
    project,
    readFiles: Array.from(runState.readFiles.values()),
    recentMessages,
    userRequest,
  });

  return {
    backend: backendContext,
    diagnostics: buildAgentDiagnostics(state.projectError, state.terminalLogs),
    devServerStatus: state.devServerStatus,
    fileTree: state.fileTree ? formatProjectFileTree(state.fileTree) : null,
    memory: dynamicContext.memory,
    observations: dynamicContext.observations,
    previewUrl: state.previewUrl,
    projectName: project.name,
    recentMessages,
    taskLedger: dynamicContext.taskLedger,
    workingSummary: dynamicContext.workingSummary,
  };
}

function buildAgentDiagnostics(projectError: string | null, terminalLogs: string[]) {
  const lines = terminalLogs.slice(-MAX_AGENT_DIAGNOSTIC_LINES);
  const parts = [
    projectError ? `Current project error: ${projectError}` : "",
    lines.length > 0 ? `Recent logs:\n${lines.join("\n")}` : "",
  ].filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const diagnostics = parts.join("\n\n").trim();

  if (diagnostics.length <= MAX_AGENT_DIAGNOSTIC_CHARS) {
    return diagnostics;
  }

  return diagnostics.slice(-MAX_AGENT_DIAGNOSTIC_CHARS);
}

function shouldRequireProjectActionBeforeAnswer(
  userRequest: string,
  observations: AgentObservation[],
) {
  if (observations.length > 0) {
    return false;
  }

  return isProjectActionRequest(userRequest);
}

function isProjectActionRequest(userRequest: string) {
  return /(?:bug|error|failed|failure|broken|fix|repair|issue|crash|exception|syntax|compile|build|preview|报错|错误|异常|崩溃|失败|修|修复|改|修改|看.*bug|看看.*bug|预览|打不开|没生效)/i.test(
    userRequest,
  );
}

async function refreshPreviewAfterFinalAgentChange(
  store: StoreAccess,
  projectId: string,
  activeStream: AgentStreamController,
  statusLines: string[],
) {
  const state = store.get();

  if (state.currentProject?.id !== projectId) {
    return;
  }

  if (state.devServerStatus !== "running") {
    if (state.previewUrl) {
      store.get().refreshPreview();
    }
    return;
  }

  updateAgentStatus(
    activeStream,
    statusLines,
    "Refreshing preview with the final verified changes.",
  );
  const activityId = activeStream.addActivity({
    detail: "The final file changes are verified, so the local preview is restarting once.",
    kind: "preview",
    title: "Refreshing final preview",
  });
  appendTerminalLog(
    store,
    "[preview] Refreshing local preview after final agent changes.",
  );

  await store.get().stopDevServer(projectId);

  if (store.get().currentProject?.id !== projectId) {
    return;
  }

  await store.get().startDevServer(projectId);

  const nextState = store.get();
  const ok =
    nextState.currentProject?.id === projectId &&
    nextState.devServerStatus === "running" &&
    Boolean(nextState.previewUrl);

  activeStream.updateActivity(activityId, {
    detail: ok
      ? `Preview restarted at ${nextState.previewUrl}.`
      : "Preview restart did not complete.",
    error: ok ? undefined : nextState.projectError ?? "Preview restart failed.",
    finishActivity: true,
    status: ok ? "succeeded" : "failed",
  });
}

function formatAgentStepLabel(
  step: Extract<AgentStepResponse, { type: "tool_call" | "tool_calls" }>,
) {
  if (step.type === "tool_calls") {
    return `tool_calls ${step.calls.map((call) => call.tool).join(", ")}`;
  }

  return formatAgentToolLabel(step);
}

function formatAgentStepLabelForStatus(step: AgentStepResponse) {
  if (step.type === "answer") {
    return "The model answered without running a tool.";
  }

  if (step.type === "finish") {
    return "The model finished the workflow.";
  }

  return `Next action: ${formatAgentStepLabel(step)}.`;
}

function createToolActivities(
  stream: AgentStreamController,
  step: Extract<AgentStepResponse, { type: "tool_call" | "tool_calls" }>,
) {
  if (step.type === "tool_calls") {
    return step.calls.map((call) => createToolActivity(stream, call));
  }

  return [createToolActivity(stream, step)];
}

function createToolActivity(
  stream: AgentStreamController,
  step: AgentToolCallStep,
) {
  return stream.addActivity(describeToolActivity(step));
}

function describeToolActivity(step: AgentToolCallStep): AgentActivityInput {
  switch (step.tool) {
    case "list_files":
      return {
        detail: step.rationale,
        kind: "tool",
        title: "Listing project files",
      };
    case "read_files":
      return {
        detail: step.args.paths.join(", "),
        kind: "tool",
        title: `Reading ${step.args.paths.length} file(s)`,
      };
    case "grep_files":
      return {
        detail: `"${step.args.query}"`,
        kind: "tool",
        title: "Searching project files",
      };
    case "glob_files":
      return {
        detail: step.args.pattern,
        kind: "tool",
        title: "Finding matching files",
      };
    case "edit_file":
      return {
        detail: step.args.summary,
        kind: "file",
        title: `Editing ${step.args.path}`,
      };
    case "write_files":
      return {
        detail: step.args.files.map((file) => file.path).join(", "),
        kind: "file",
        title: `Writing ${step.args.files.length} file(s)`,
      };
    case "delete_files":
      return {
        detail: step.args.paths.join(", "),
        kind: "file",
        title: `Deleting ${step.args.paths.length} file(s)`,
      };
    case "run_command":
      return {
        command: step.args.command,
        detail: step.rationale,
        kind: "command",
        title: `Running ${step.args.command}`,
      };
    case "apply_supabase_schema":
      return {
        detail: step.args.summary,
        kind: "database",
        title: "Applying database schema",
      };
    case "start_dev_server":
      return {
        detail: step.rationale,
        kind: "preview",
        title: "Starting preview",
      };
    case "stop_dev_server":
      return {
        detail: step.rationale,
        kind: "preview",
        title: "Stopping preview",
      };
    case "refresh_preview":
      return {
        detail: step.rationale,
        kind: "preview",
        title: "Refreshing preview",
      };
  }
}

function isRecoverableAgentPlanningError(message: string) {
  return message.includes("Model attempted to run a forbidden command:");
}

function formatAgentFinishMessage(
  step: Extract<AgentStepResponse, { type: "finish" }>,
  result: { buildVerified: boolean; didChangeFiles: boolean },
) {
  const lines = [step.summary];

  if (step.verification) {
    lines.push("", `Verification: ${step.verification}`);
  } else if (result.buildVerified) {
    lines.push("", "Verification: npm run build passed.");
  }

  return lines.join("\n");
}
