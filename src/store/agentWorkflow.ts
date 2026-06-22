import {
  AgentObservation,
  AgentStepResponse,
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
  replaceConversationMessage,
} from "./conversationState";
import {
  appendAssistantMessage,
  appendTerminalLog,
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
      onDelta: stream.onDelta,
      projectName: project.name,
      userPrompt: projectPrompt,
    });
    stream.setStatus("Model output received. Applying files...");

    const changeRecord = await writeAgentFiles(
      store,
      project,
      response.files,
      response.summary,
    );

    if (store.get().currentProject?.id === project.id) {
      replaceConversationMessage(
        store,
        stream.messageId,
        formatChangeRecordMessage(response.summary, changeRecord),
        false,
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
      replaceConversationMessage(
        store,
        stream.messageId,
        `Project generation failed: ${message}`,
        false,
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

    let fileTree = store.get().fileTree;

    if (!fileTree) {
      fileTree = await projectApi.listFiles(project.id);
      store.set({ fileTree });
    }

    const contextFilePaths = getContextFilePaths(fileTree);

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
        onDelta: activeStream.onDelta,
        projectName: project.name,
        userPrompt: userRequest,
      });
      updateAgentStatus(
        activeStream,
        statusLines,
        "Model output received. Applying files.",
      );

      const changeRecord = await writeAgentFiles(
        store,
        project,
        response.files,
        response.summary,
      );

      if (store.get().currentProject?.id !== project.id) {
        return;
      }

      replaceConversationMessage(
        store,
        activeStream.messageId,
        formatChangeRecordMessage(response.summary, changeRecord),
        false,
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
          onDelta: activeStream.onDelta,
          userRequest,
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);

        if (!isRecoverableAgentPlanningError(message)) {
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
        updateAgentStatus(
          activeStream,
          statusLines,
          "The agent proposed a forbidden install command. Asking it to repair the plan.",
        );
        continue;
      }
      ensureCurrentProject(store, project.id);

      if (step.type === "answer") {
        replaceConversationMessage(
          store,
          activeStream.messageId,
          step.message,
          false,
        );
        void persistCurrentConversation(store);

        store.set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [`[agent] answered`]),
        }));
        return;
      }

      if (step.type === "finish") {
        const content = formatAgentFinishMessage(step, {
          buildVerified,
          didChangeFiles,
        });

        replaceConversationMessage(
          store,
          activeStream.messageId,
          content,
          false,
        );
        void persistCurrentConversation(store);

        store.set((state) => ({
          terminalLogs: appendLogs(state.terminalLogs, [`[agent] ${step.summary}`]),
        }));
        return;
      }

      updateAgentStatus(activeStream, statusLines, `Tool: ${formatAgentStepLabel(step)}.`);

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
              ),
            ];

      for (const result of results) {
        observations.push(result.observation);
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

        if (stepChangedPackage) {
          const installObservation = await runAgentCommandObservation(
            store,
            project,
            getPreferredProjectCommand(store, "install"),
            observations.length + 1,
            "Installing dependencies after package.json changed.",
          );
          observations.push(installObservation);
          appendTerminalLog(
            store,
            `[agent:${installObservation.ok ? "ok" : "error"}] ${installObservation.summary}`,
          );

          if (!installObservation.ok) {
            continue;
          }
        }

        const buildObservation = await runAgentCommandObservation(
          store,
          project,
          getPreferredProjectCommand(store, "build"),
          observations.length + 1,
          "Verifying project build after file changes.",
        );
        observations.push(buildObservation);
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

          replaceConversationMessage(
            store,
            activeStream.messageId,
            content,
            false,
          );
          void persistCurrentConversation(store);

          store.set({ projectError: buildObservation.summary });
          return;
        }
      }
    }

    replaceConversationMessage(
      store,
      activeStream.messageId,
      [
        "I stopped after reaching the agent step limit.",
        "",
        didChangeFiles
          ? "Some project files were changed."
          : "No project files were changed.",
      ].join("\n"),
      false,
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
      replaceConversationMessage(
        store,
        activeStream.messageId,
        `Agent workflow failed: ${message}`,
        false,
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
  const dynamicContext = buildDynamicAgentContext({
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

function formatAgentStepLabel(
  step: Extract<AgentStepResponse, { type: "tool_call" | "tool_calls" }>,
) {
  if (step.type === "tool_calls") {
    return `tool_calls ${step.calls.map((call) => call.tool).join(", ")}`;
  }

  return formatAgentToolLabel(step);
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
