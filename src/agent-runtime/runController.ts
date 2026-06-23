import {
  formatProjectFileTree,
  getContextFilePaths,
  requestAgentStep,
  requestProjectGeneration,
  type AgentObservation,
  type AgentStepResponse,
  type AgentToolCallStep,
} from "../agent/projectModifier";
import {
  buildProjectBackendContext,
  hasBackendIntent,
} from "../agent/project/backendContext";
import { buildDynamicAgentContext } from "../agent/project/memory";
import { AgentVerifier } from "../agent-core/verifier/verifier";
import { compileTaskContract } from "../agent-core/contract/taskContract";
import { RunStateMachine } from "../agent-core/runtime/runStateMachine";
import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunCheckpoint,
  TaskType,
  VerificationReport,
} from "../agent-core/types";
import { getCoreToolDefinition } from "../agent-core/tools/toolRegistry";
import {
  PolicyEngine,
  type PolicyDecision,
} from "../agent-core/policy/policyEngine";
import { keyStore } from "../services/keyStore";
import {
  getProjectErrorMessage,
  ProjectInfo,
  projectApi,
} from "../services/projects";
import { agentRuntimeApi } from "../services/agentRuntime";
import { getAiProviderDefinition } from "../services/aiProviders";
import { addStableNodeIdsToGeneratedFiles, ensureSiteIndex, refreshSiteIndex } from "../adapters/siteIrAdapter";
import { appendLogs } from "../store/commandLogs";
import { formatChangeRecordMessage } from "../store/changeHistory";
import { persistCurrentConversation } from "../store/conversationState";
import {
  appendAssistantMessage,
  appendTerminalLog,
  type AgentActivityInput,
  type AgentStreamController,
  startStreamingAgentMessage,
  updateAgentStatus,
} from "../store/agentUi";
import { writeAgentFiles } from "../store/agentFileChanges";
import {
  createAgentRunState,
  ensureCurrentProject,
  executeAgentTool,
  executeAgentToolBatch,
  formatAgentToolLabel,
} from "../store/agentToolExecutor";
import type { StoreAccess } from "../store/storeAccess";
import {
  createRunAbortController,
  releaseRunAbortController,
} from "./agentRunControl";

const MAX_AGENT_DIAGNOSTIC_CHARS = 6_000;
const MAX_AGENT_DIAGNOSTIC_LINES = 36;

const stateMachine = new RunStateMachine();
const policyEngine = new PolicyEngine();

class RunStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStopped";
  }
}

type RuntimeRunState = ReturnType<typeof createAgentRunState>;

type GenerationVerificationResult = {
  changedFiles: string[];
  completed: boolean;
  packageChanged: boolean;
  report: VerificationReport;
  run: AgentRun;
};

export async function generateInitialProjectRuntime(
  store: StoreAccess,
  project: ProjectInfo,
  projectPrompt: string,
) {
  const stream = startStreamingAgentMessage(
    store,
    `Generating ${project.name} with the runtime`,
  );
  let run: AgentRun | null = null;
  let abortController: AbortController | null = null;

  store.set((state) => ({
    isGeneratingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Starting persistent run for ${project.name}`,
    ]),
  }));

  try {
    run = await createRuntimeRun(store, project, projectPrompt, "full_site");
    abortController = createRunAbortController(run.id);
    run = await commitTransition(store, project.id, run, stateMachine.transition(run, { type: "start" }));
    const config = await keyStore.getAiProviderConfig();

    if (!config) {
      throw new Error("Configure your AI provider first.");
    }

    await appendRuntimeEvent(store, project.id, run.id, "model.started", {
      taskType: run.contract.taskType,
    });
    const backendContext = await buildProjectBackendContext(project.id, {
      includeSchema: hasBackendIntent(projectPrompt),
    });
    const response = await requestProjectGeneration({
      backendContext,
      config,
      onDelta: stream.onModelDelta,
      projectName: project.name,
      signal: abortController.signal,
      userPrompt: projectPrompt,
    });
    run = await persistRunCounters(
      store,
      project.id,
      run,
      { modelTurns: run.modelTurns + 1 },
      "model.completed",
      {
        fileCount: response.files.length,
        summary: response.summary,
      },
    );

    await checkRunInterruption(store, project.id, run, stream);
    run = getCurrentRun(store, run.id) ?? run;
    run = await commitTransition(
      store,
      project.id,
      run,
      withRunPatch(stateMachine.transition(run, { type: "enter_mutating", mutationDelta: 1 }), {
        mutationCount: run.mutationCount + 1,
      }),
    );

    const files = addStableNodeIdsToGeneratedFiles(response.files);
    const writeActivityId = stream.addActivity({
      detail: `${files.length} file(s) returned by the model.`,
      kind: "file",
      title: "Writing project files",
    });
    const changeRecord = await writeAgentFiles(store, project, files, response.summary);
    stream.updateActivity(writeActivityId, {
      detail: response.summary,
      finishActivity: true,
      status: "succeeded",
    });
    await refreshSiteIndex(project, store.get().fileTree);
    const changedFiles = new Set(changeRecord.files.map((file) => file.path));
    const packageChanged = changeRecord.files.some((file) => file.path === "package.json");
    await appendRuntimeEvent(store, project.id, run.id, "tool.completed", {
      changedFiles: Array.from(changedFiles),
      tool: "write_files",
    });

    const report = await verifyRun(store, project, run, stream, {
      changedFiles: Array.from(changedFiles),
      deletedFiles: [],
      packageChanged,
      previewUrl: store.get().previewUrl,
    });
    run = getCurrentRun(store, run.id) ?? run;

    if (report.status === "passed") {
      run = await commitTransition(
        store,
        project.id,
        run,
        stateMachine.transition(run, { type: "verification_passed", report }),
      );
      stream.completeWithTypewriter(formatChangeRecordMessage(response.summary, changeRecord));
      void persistCurrentConversation(store);
      store.set((state) => ({
        previewRefreshKey: state.previewRefreshKey + 1,
        terminalLogs: appendLogs(state.terminalLogs, [`[agent] ${response.summary}`]),
      }));
      return true;
    }

    const observations: AgentObservation[] = [];
    const repair = await prepareRepairFromVerificationFailure(store, project, run, stream, {
      changedFiles,
      deletedFiles: new Set(),
      observations,
      packageChanged,
      reason: "initial-generation-repair-observation-recorded",
      report,
      repairFeedback: [...report.repairFeedback],
      runState: createAgentRunState(),
    });

    if (!repair.canRepair) {
      return false;
    }

    run = repair.run;
    stream.completeWithTypewriter(
      "Initial generation produced files, but verifier found issues. Continuing with a repair pass in the same run.",
    );
    void persistCurrentConversation(store);
    await modifyCurrentProjectRuntime(store, projectPrompt, { existingRun: run });
    return getCurrentRun(store, run.id)?.status === "completed";
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (!(error instanceof RunStopped)) {
      if (run) {
        await failRunBestEffort(store, project.id, run, message);
      }

      stream.failWithTypewriter(`Project generation failed: ${message}`);
      void persistCurrentConversation(store);
      store.set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
      }));
    }

    return false;
  } finally {
    if (run) {
      releaseRunAbortController(run.id);
    }

    store.set({ isGeneratingProject: false });
  }
}

export async function modifyCurrentProjectRuntime(
  store: StoreAccess,
  userRequest: string,
  options: { existingRun?: AgentRun; resumeObservation?: AgentObservation } = {},
) {
  const project = store.get().currentProject;

  if (!project) {
    appendAssistantMessage(
      store,
      "Create or select a project first, then describe what to build.",
    );
    return;
  }

  const stream = startStreamingAgentMessage(store, "Working with the persistent agent");
  const statusLines: string[] = [];
  const observations: AgentObservation[] = [];
  const runState = createAgentRunState();
  let run = options.existingRun ?? null;
  let abortController: AbortController | null = null;
  let didChangeFiles = false;
  let buildVerified = false;
  let previewNeedsFinalRefresh = false;
  let changedFiles = new Set<string>();
  let deletedFiles = new Set<string>();
  let packageChanged = false;
  let latestReportId: string | undefined;
  let repairFeedback: string[] = [];

  store.set((state) => ({
    isModifyingProject: true,
    projectError: null,
    terminalLogs: appendLogs(state.terminalLogs, [
      `[agent] Starting persistent tool workflow for ${project.name}`,
    ]),
  }));

  try {
    if (!run) {
      run = await createRuntimeRun(store, project, userRequest);
    } else {
      store.set({ currentAgentRun: run });
      const checkpoint = await restoreRuntimeCheckpoint(store, project, run);

      if (checkpoint) {
        observations.push(...restoreCheckpointObservations(checkpoint));
        await restoreCheckpointReadSnapshots(project, checkpoint, runState);
        changedFiles = new Set(checkpoint.changedFiles);
        deletedFiles = new Set(checkpoint.deletedFiles);
        packageChanged = checkpoint.packageChanged;
        runState.packageBaselineJson = checkpoint.packageBaselineJson ?? null;
        latestReportId = checkpoint.latestReportId;
        repairFeedback = [...checkpoint.repairFeedback];
      }

      if (options.resumeObservation) {
        observations.push({
          ...options.resumeObservation,
          step: observations.length + 1,
        });
      }

      if (run.status === "paused") {
        run = await commitTransition(
          store,
          project.id,
          run,
          stateMachine.transition(run, { type: "resume" }),
        );
      }
    }

    abortController = createRunAbortController(run.id);
    if (run.status === "created") {
      run = await commitTransition(store, project.id, run, stateMachine.transition(run, { type: "start" }));
    }
    await saveRuntimeCheckpoint(store, project, run, {
      changedFiles,
      deletedFiles,
      latestReportId,
      observations,
      packageChanged,
      reason: options.existingRun ? "run-resumed" : "run-started",
      repairFeedback,
      runState,
    });
    const config = await keyStore.getAiProviderConfig();

    if (!config) {
      throw new Error("Configure your AI provider first.");
    }

    const provider = getAiProviderDefinition(config.provider);
    appendTerminalLog(store, `[agent] Using ${provider.label} model ${config.model}`);
    updateAgentStatus(stream, statusLines, "Collecting project context.");
    await ensureSiteIndex(project, store.get().fileTree);

    let fileTree = store.get().fileTree;

    if (!fileTree) {
      fileTree = await projectApi.listFiles(project.id);
      store.set({ fileTree });
    }

    const contextFilePaths = getContextFilePaths(fileTree);

    if (contextFilePaths.length === 0) {
      const generationResult = await generateInsideExistingRun(
        store,
        project,
        userRequest,
        run,
        stream,
        abortController.signal,
      );

      run = generationResult.run;

      if (generationResult.completed) {
        return true;
      }

      changedFiles = new Set(generationResult.changedFiles);
      packageChanged = generationResult.packageChanged;
      latestReportId = generationResult.report.id;
      repairFeedback = [...generationResult.report.repairFeedback];
      const repair = await prepareRepairFromVerificationFailure(store, project, run, stream, {
        changedFiles,
        deletedFiles: new Set(),
        observations,
        packageChanged,
        reason: "empty-project-generation-repair-observation-recorded",
        report: generationResult.report,
        repairFeedback,
        runState,
        statusLines,
      });

      if (!repair.canRepair) {
        return false;
      }

      run = repair.run;
    }

    while (run.modelTurns < run.contract.budget.maxModelTurns) {
      await checkRunInterruption(store, project.id, run, stream);
      run = getCurrentRun(store, run.id) ?? run;
      ensureCurrentProject(store, project.id);
      const stepIndex = run.modelTurns + 1;
      updateAgentStatus(stream, statusLines, `Planning step ${stepIndex}.`);
      const planningActivityId = stream.addActivity({
        detail: "Asking the model for the next project action.",
        kind: "thinking",
        title: `Planning step ${stepIndex}`,
      });
      await appendRuntimeEvent(store, project.id, run.id, "model.started", {
        stepIndex,
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
            run,
          ),
          onDelta: stream.onModelDelta,
          signal: abortController.signal,
          userRequest,
        });
        run = await persistRunCounters(
          store,
          project.id,
          run,
          { modelTurns: run.modelTurns + 1 },
          "model.completed",
          { stepType: step.type },
        );
        await saveRuntimeCheckpoint(store, project, run, {
          changedFiles,
          deletedFiles,
          latestReportId,
          observations,
          packageChanged,
          reason: "model-completed",
          repairFeedback,
          runState,
        });
        stream.updateActivity(planningActivityId, {
          detail: formatAgentStepLabelForStatus(step),
          finishActivity: true,
          status: "succeeded",
        });
      } catch (error) {
        const message = getProjectErrorMessage(error);
        await appendRuntimeEvent(store, project.id, run.id, "model.failed", {
          message,
        });
        stream.updateActivity(planningActivityId, {
          detail: message,
          error: message,
          finishActivity: true,
          status: "failed",
        });
        throw error;
      }

      if (step.type === "answer") {
        if (shouldRequireProjectActionBeforeAnswer(userRequest, observations)) {
          const observation: AgentObservation = {
            content: [
              "The model tried to answer before inspecting the project.",
              "For bug, error, broken preview, fix, or change requests, inspect diagnostics and relevant files first.",
              `Proposed answer: ${step.message}`,
            ].join("\n"),
            ok: false,
            step: observations.length + 1,
            summary: "Answer was not enough for this project action request.",
            tool: "answer",
          };
          observations.push(observation);
          continue;
        }

        await completeAnswerRun(store, project, run, step.message);
        stream.completeWithTypewriter(step.message);
        void persistCurrentConversation(store);
        return;
      }

      if (step.type === "finish_candidate") {
        if (previewNeedsFinalRefresh && buildVerified) {
          await refreshPreviewAfterFinalAgentChange(store, project.id, stream, statusLines);
        }

        const report = await verifyRun(store, project, run, stream, {
          changedFiles: Array.from(changedFiles),
          deletedFiles: Array.from(deletedFiles),
          packageChanged,
          packageBaselineJson: runState.packageBaselineJson,
          previewUrl: store.get().previewUrl,
        });
        run = getCurrentRun(store, run.id) ?? run;
        latestReportId = report.id;
        repairFeedback = [...report.repairFeedback];
        await saveRuntimeCheckpoint(store, project, run, {
          changedFiles,
          deletedFiles,
          latestReportId,
          observations,
          packageChanged,
          reason: "verification-completed",
          repairFeedback,
          runState,
        });

        if (report.status === "passed") {
          await commitTransition(
            store,
            project.id,
            run,
            stateMachine.transition(run, { type: "verification_passed", report }),
          );
          stream.completeWithTypewriter(formatAgentFinishMessage(step, report));
          void persistCurrentConversation(store);
          return;
        }

        if (run.repairCycles >= run.contract.budget.maxRepairCycles) {
          await commitTransition(
            store,
            project.id,
            run,
            stateMachine.transition(run, { type: "repair_budget_exceeded", report }),
          );
          stream.failWithTypewriter(formatVerificationFailure(report));
          void persistCurrentConversation(store);
          return;
        }

        run = await commitTransition(
          store,
          project.id,
          run,
          stateMachine.transition(run, { type: "verification_failed", report }),
        );
        observations.push(reportToObservation(report, observations.length + 1));
        await saveRuntimeCheckpoint(store, project, run, {
          changedFiles,
          deletedFiles,
          latestReportId,
          observations,
          packageChanged,
          reason: "repair-observation-recorded",
          repairFeedback,
          runState,
        });
        continue;
      }

      const approvedHashes = await loadApprovedApprovalHashes(project.id, run.id);
      const policyDecision = evaluateStepPolicy(run, step, approvedHashes);

      if (!policyDecision.allowed) {
        await appendRuntimeEvent(store, project.id, run.id, "policy.denied", {
          reason: policyDecision.reason,
          tool: policyDecision.toolName,
        });
        observations.push({
          content: policyDecision.reason,
          ok: false,
          step: observations.length + 1,
          summary: policyDecision.reason,
          tool: policyDecision.toolName,
        });
        continue;
      }

      if (policyDecision.approvalRequired) {
        const approvalCreatedAt = new Date().toISOString();
        const approval = await agentRuntimeApi.createApproval(project.id, {
          id: createRuntimeId("approval"),
          runId: run.id,
          toolCallId: createRuntimeId("tool-call"),
          toolName: policyDecision.toolName,
          normalizedArgsHash: policyDecision.approvalHash,
          targetResources: collectTargetResources(policyDecision.args),
          exactSideEffect: policyDecision.reason,
          createdAt: approvalCreatedAt,
          expiresAt: addMinutesIso(approvalCreatedAt, 30),
        });
        await appendRuntimeEvent(store, project.id, run.id, "approval.requested", {
          approvalId: approval.id,
          approvalHash: policyDecision.approvalHash,
          reason: policyDecision.reason,
          tool: policyDecision.toolName,
        });
        run = await commitTransition(
          store,
          project.id,
          run,
          stateMachine.transition(run, { type: "enter_waiting_approval" }),
        );
        await saveRuntimeCheckpoint(store, project, run, {
          changedFiles,
          deletedFiles,
          latestReportId,
          observations,
          packageChanged,
          reason: "approval-requested",
          repairFeedback,
          runState,
        });
        store.set({ currentAgentApproval: approval });
        stream.failWithTypewriter(`Approval required before continuing: ${policyDecision.reason}`);
        void persistCurrentConversation(store);
        return;
      }

      await appendRuntimeEvent(store, project.id, run.id, "policy.allowed", {
        reason: policyDecision.reason,
      });
      updateAgentStatus(stream, statusLines, `Tool: ${formatAgentStepLabel(step)}.`);
      const activityIds = createToolActivities(stream, step);
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
                      chatMessageId: stream.messageId,
                    }
                  : undefined,
              ),
            ];
      run = await persistRunCounters(
        store,
        project.id,
        run,
        { toolCalls: run.toolCalls + results.length },
        "checkpoint.created",
        {
          counters: {
            toolCalls: run.toolCalls + results.length,
          },
          reason: "tool batch completed",
          toolCallsDelta: results.length,
        },
      );

      for (const [resultIndex, result] of results.entries()) {
        observations.push(result.observation);
        const activityId = activityIds[resultIndex];

        if (activityId) {
          stream.updateActivity(activityId, {
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
        await appendRuntimeEvent(
          store,
          project.id,
          run.id,
          result.observation.ok ? "tool.completed" : "tool.failed",
          {
            changedFiles: result.changedFiles ?? [],
            deletedFiles: result.deletedFiles ?? [],
            summary: result.observation.summary,
            tool: result.observation.tool,
          },
        );
      }

      const stepChangedFiles = results.some((result) => result.didChangeFiles);
      const stepChangedPackage = results.some((result) => result.didChangePackage);

      for (const result of results) {
        for (const path of result.changedFiles ?? []) {
          changedFiles.add(path);
        }
        for (const path of result.deletedFiles ?? []) {
          deletedFiles.add(path);
        }
      }
      packageChanged ||= stepChangedPackage;
      await saveRuntimeCheckpoint(store, project, run, {
        changedFiles,
        deletedFiles,
        latestReportId,
        observations,
        packageChanged,
        reason: "tool-batch-completed",
        repairFeedback,
        runState,
      });

      if (stepChangedFiles) {
        didChangeFiles = true;
        buildVerified = false;
        previewNeedsFinalRefresh = true;
        await refreshSiteIndex(project, store.get().fileTree);

        const report = await verifyRun(store, project, run, stream, {
          changedFiles: Array.from(changedFiles),
          deletedFiles: Array.from(deletedFiles),
          packageChanged,
          packageBaselineJson: runState.packageBaselineJson,
          previewUrl: store.get().previewUrl,
        });
        run = getCurrentRun(store, run.id) ?? run;
        latestReportId = report.id;
        repairFeedback = [...report.repairFeedback];
        await saveRuntimeCheckpoint(store, project, run, {
          changedFiles,
          deletedFiles,
          latestReportId,
          observations,
          packageChanged,
          reason: "verification-completed",
          repairFeedback,
          runState,
        });

        if (report.status === "passed") {
          buildVerified = true;
          updateAgentStatus(stream, statusLines, "Verification passed.");
          if (previewNeedsFinalRefresh) {
            await refreshPreviewAfterFinalAgentChange(store, project.id, stream, statusLines);
          }
          run = getCurrentRun(store, run.id) ?? run;
          await commitTransition(
            store,
            project.id,
            run,
            stateMachine.transition(run, { type: "verification_passed", report }),
          );
          stream.completeWithTypewriter(
            formatVerifiedToolCompletionMessage({
              changedFiles: Array.from(changedFiles),
              deletedFiles: Array.from(deletedFiles),
              report,
              userRequest,
            }),
          );
          void persistCurrentConversation(store);
          return;
        } else if (run.repairCycles < run.contract.budget.maxRepairCycles) {
          run = await commitTransition(
            store,
            project.id,
            run,
            stateMachine.transition(run, { type: "verification_failed", report }),
          );
          observations.push(reportToObservation(report, observations.length + 1));
          await saveRuntimeCheckpoint(store, project, run, {
            changedFiles,
            deletedFiles,
            latestReportId,
            observations,
            packageChanged,
            reason: "repair-observation-recorded",
            repairFeedback,
            runState,
          });
          updateAgentStatus(
            stream,
            statusLines,
            `Verification failed. Asking for repair ${run.repairCycles}/${run.contract.budget.maxRepairCycles}.`,
          );
        } else {
          await commitTransition(
            store,
            project.id,
            run,
            stateMachine.transition(run, { type: "repair_budget_exceeded", report }),
          );
          stream.failWithTypewriter(formatVerificationFailure(report));
          void persistCurrentConversation(store);
          return;
        }
      }
    }

    if (previewNeedsFinalRefresh && buildVerified) {
      await refreshPreviewAfterFinalAgentChange(store, project.id, stream, statusLines);
    }

    const message = [
      "I stopped after reaching the agent model-turn budget.",
      "",
      didChangeFiles ? "Some project files were changed." : "No project files were changed.",
    ].join("\n");
    run = getCurrentRun(store, run.id) ?? run;
    await commitTransition(
      store,
      project.id,
      run,
      stateMachine.transition(run, {
        type: "budget_exceeded",
        budget: "maxModelTurns",
        reason: message,
      }),
    );
    stream.failWithTypewriter(message);
    void persistCurrentConversation(store);
  } catch (error) {
    const message = getProjectErrorMessage(error);

    if (!(error instanceof RunStopped)) {
      if (run) {
        await failRunBestEffort(store, project.id, run, message);
      }

      stream.failWithTypewriter(`Agent workflow failed: ${message}`);
      void persistCurrentConversation(store);
      store.set((state) => ({
        projectError: message,
        terminalLogs: appendLogs(state.terminalLogs, [`[agent:error] ${message}`]),
      }));
    }
  } finally {
    if (run) {
      releaseRunAbortController(run.id);
    }

    store.set({ isModifyingProject: false });
  }
}

async function generateInsideExistingRun(
  store: StoreAccess,
  project: ProjectInfo,
  userRequest: string,
  run: AgentRun,
  stream: AgentStreamController,
  signal: AbortSignal,
): Promise<GenerationVerificationResult> {
  const config = await keyStore.getAiProviderConfig();

  if (!config) {
    throw new Error("Configure your AI provider first.");
  }

  await appendRuntimeEvent(store, project.id, run.id, "model.started", {
    taskType: run.contract.taskType,
  });
  const backendContext = await buildProjectBackendContext(project.id, {
    includeSchema: hasBackendIntent(userRequest),
  });
  const response = await requestProjectGeneration({
    backendContext,
    config,
    onDelta: stream.onModelDelta,
    projectName: project.name,
    signal,
    userPrompt: userRequest,
  });
  run = await persistRunCounters(
    store,
    project.id,
    run,
    { modelTurns: run.modelTurns + 1 },
    "model.completed",
    {
      fileCount: response.files.length,
      summary: response.summary,
    },
  );
  run = await commitTransition(
    store,
    project.id,
    run,
    stateMachine.transition(run, { type: "enter_mutating", mutationDelta: 1 }),
  );
  const files = addStableNodeIdsToGeneratedFiles(response.files);
  const changeRecord = await writeAgentFiles(store, project, files, response.summary);
  await refreshSiteIndex(project, store.get().fileTree);
  const changedFiles = changeRecord.files.map((file) => file.path);
  const packageChanged = changeRecord.files.some((file) => file.path === "package.json");
  await appendRuntimeEvent(store, project.id, run.id, "tool.completed", {
    changedFiles,
    tool: "write_files",
  });
  const report = await verifyRun(store, project, run, stream, {
    changedFiles,
    deletedFiles: [],
    packageChanged,
    previewUrl: store.get().previewUrl,
  });
  run = getCurrentRun(store, run.id) ?? run;

  if (report.status !== "passed") {
    return {
      changedFiles,
      completed: false,
      packageChanged,
      report,
      run,
    };
  }

  run = await commitTransition(
    store,
    project.id,
    run,
    stateMachine.transition(run, { type: "verification_passed", report }),
  );
  stream.completeWithTypewriter(formatChangeRecordMessage(response.summary, changeRecord));
  void persistCurrentConversation(store);
  return {
    changedFiles,
    completed: true,
    packageChanged,
    report,
    run,
  };
}

async function prepareRepairFromVerificationFailure(
  store: StoreAccess,
  project: ProjectInfo,
  run: AgentRun,
  stream: AgentStreamController,
  input: {
    changedFiles: Set<string>;
    deletedFiles: Set<string>;
    observations: AgentObservation[];
    packageChanged: boolean;
    reason: string;
    report: VerificationReport;
    repairFeedback: string[];
    runState: RuntimeRunState;
    statusLines?: string[];
  },
): Promise<{ canRepair: boolean; run: AgentRun }> {
  run = getCurrentRun(store, run.id) ?? run;

  if (run.repairCycles >= run.contract.budget.maxRepairCycles) {
    const exceededRun = await commitTransition(
      store,
      project.id,
      run,
      stateMachine.transition(run, {
        type: "repair_budget_exceeded",
        report: input.report,
      }),
    );
    stream.failWithTypewriter(formatVerificationFailure(input.report));
    void persistCurrentConversation(store);
    return { canRepair: false, run: exceededRun };
  }

  const hasReportObservation = input.observations.some(
    (observation) =>
      observation.tool === "verifier" &&
      typeof observation.content === "string" &&
      observation.content.includes(`"id": "${input.report.id}"`),
  );

  if (!hasReportObservation) {
    input.observations.push(reportToObservation(input.report, input.observations.length + 1));
  }

  run = await commitTransition(
    store,
    project.id,
    run,
    stateMachine.transition(run, {
      type: "verification_failed",
      report: input.report,
    }),
  );

  await saveRuntimeCheckpoint(store, project, run, {
    changedFiles: input.changedFiles,
    deletedFiles: input.deletedFiles,
    latestReportId: input.report.id,
    observations: input.observations,
    packageChanged: input.packageChanged,
    reason: input.reason,
    repairFeedback: input.repairFeedback,
    runState: input.runState,
  });

  if (input.statusLines) {
    updateAgentStatus(
      stream,
      input.statusLines,
      `Verification failed. Asking for repair ${run.repairCycles}/${run.contract.budget.maxRepairCycles}.`,
    );
  }

  return { canRepair: true, run };
}

async function createRuntimeRun(
  store: StoreAccess,
  project: ProjectInfo,
  objective: string,
  taskType?: TaskType,
) {
  const conversationId = store.get().currentConversation?.id ?? "conversation";
  const contract = compileTaskContract({
    objective,
    selectedSiteNodeId: store.get().selectedSiteNodeId,
    taskType,
  });
  const run = stateMachine.createRun({
    contract,
    conversationId,
    projectId: project.id,
  });
  const persistedRun = await agentRuntimeApi.createRun(project.id, run);
  const events = await agentRuntimeApi.listEvents(project.id, run.id);

  store.set((state) => ({
    agentEvents: events,
    agentRuns: [persistedRun, ...state.agentRuns.filter((item) => item.id !== persistedRun.id)],
    currentAgentRun: persistedRun,
    currentVerificationReport: null,
  }));

  return persistedRun;
}

async function commitTransition(
  store: StoreAccess,
  projectId: string,
  previousRun: AgentRun,
  result: ReturnType<RunStateMachine["transition"]>,
) {
  const { run, event } = await agentRuntimeApi.transitionRun(projectId, previousRun, result);

  store.set((state) => ({
    agentEvents: [...state.agentEvents, event],
    agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
    currentAgentRun: run,
  }));

  return run;
}

async function appendRuntimeEvent(
  store: StoreAccess,
  projectId: string,
  runId: string,
  type: AgentEventType,
  payload: unknown,
) {
  const event = await agentRuntimeApi.appendEvent(projectId, {
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  });

  store.set((state) => ({
    agentEvents: [...state.agentEvents, event],
  }));
}

async function saveRuntimeCheckpoint(
  store: StoreAccess,
  project: ProjectInfo,
  run: AgentRun,
  input: {
    changedFiles: Set<string>;
    deletedFiles: Set<string>;
    latestReportId?: string;
    observations: AgentObservation[];
    packageChanged: boolean;
    reason: string;
    repairFeedback: string[];
    runState: ReturnType<typeof createAgentRunState>;
  },
) {
  const events = await agentRuntimeApi.listEvents(project.id, run.id);
  const workspaceFingerprint = await computeWorkspaceFingerprint(project);
  const checkpoint = await agentRuntimeApi.saveCheckpoint(project.id, {
    id: createRuntimeId("checkpoint"),
    runId: run.id,
    createdAt: new Date().toISOString(),
    workspaceFingerprint,
    plan: null,
    observations: input.observations,
    changedFiles: Array.from(input.changedFiles),
    deletedFiles: Array.from(input.deletedFiles),
    packageChanged: input.packageChanged,
    packageBaselineJson: input.runState.packageBaselineJson,
    readSnapshots: Array.from(input.runState.readFiles.values()).map(
      ({ contentHash, path, readAt }) => ({
        contentHash,
        path,
        readAt,
      }),
    ),
    latestReportId: input.latestReportId,
    repairFeedback: input.repairFeedback,
    steeringWatermark: getSteeringWatermark(events),
  });
  const event = await agentRuntimeApi.appendEvent(project.id, {
    runId: run.id,
    type: "checkpoint.created",
    timestamp: checkpoint.createdAt,
    payload: {
      checkpointId: checkpoint.id,
      kind: "runtime-checkpoint",
      reason: input.reason,
      steeringWatermark: checkpoint.steeringWatermark,
      workspaceFingerprint,
    },
  });

  store.set((state) => ({
    agentEvents: [...state.agentEvents, event],
  }));

  return checkpoint;
}

async function restoreRuntimeCheckpoint(
  store: StoreAccess,
  project: ProjectInfo,
  run: AgentRun,
) {
  const checkpoint = await agentRuntimeApi.getLatestCheckpoint(project.id, run.id);

  if (!checkpoint) {
    return null;
  }

  const currentFingerprint = await computeWorkspaceFingerprint(project);

  if (checkpoint.workspaceFingerprint !== currentFingerprint) {
    await commitTransition(
      store,
      project.id,
      run,
      stateMachine.transition(run, {
        type: "fail",
        reason:
          "Workspace changed since the latest checkpoint; resume requires reconciliation before continuing.",
      }),
    );
    throw new RunStopped("Workspace changed since the latest checkpoint.");
  }

  return checkpoint;
}

async function restoreCheckpointReadSnapshots(
  project: ProjectInfo,
  checkpoint: AgentRunCheckpoint,
  runState: ReturnType<typeof createAgentRunState>,
) {
  for (const snapshot of checkpoint.readSnapshots) {
    const content = await projectApi.readFile(project.id, snapshot.path);
    const currentHash = hashText(content);

    if (currentHash !== snapshot.contentHash) {
      throw new Error(
        `${snapshot.path} changed after the checkpoint. Read the file again before resuming edits.`,
      );
    }

    runState.readFiles.set(snapshot.path, {
      content,
      contentHash: snapshot.contentHash,
      path: snapshot.path,
      readAt: snapshot.readAt,
    });
  }
}

function restoreCheckpointObservations(checkpoint: AgentRunCheckpoint): AgentObservation[] {
  return checkpoint.observations
    .map((observation, index) => toAgentObservation(observation, index + 1))
    .filter((observation): observation is AgentObservation => Boolean(observation));
}

function toAgentObservation(
  value: unknown,
  fallbackStep: number,
): AgentObservation | null {
  if (typeof value === "string") {
    return {
      content: value,
      ok: true,
      step: fallbackStep,
      summary: value.slice(0, 160) || "Restored checkpoint observation.",
      tool: "checkpoint",
    };
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<AgentObservation>;

  if (
    typeof candidate.ok === "boolean" &&
    typeof candidate.summary === "string" &&
    typeof candidate.tool === "string"
  ) {
    return {
      content: typeof candidate.content === "string" ? candidate.content : undefined,
      ok: candidate.ok,
      step: typeof candidate.step === "number" ? candidate.step : fallbackStep,
      summary: candidate.summary,
      tool: candidate.tool,
    };
  }

  return null;
}

async function computeWorkspaceFingerprint(project: ProjectInfo) {
  const fileTree = await projectApi.listFiles(project.id);
  const paths = getContextFilePaths(fileTree);
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await projectApi.readFile(project.id, path);
        return `${path}:${hashText(content)}`;
      } catch (error) {
        return `${path}:missing:${getProjectErrorMessage(error)}`;
      }
    }),
  );

  return hashText(entries.sort().join("\n"));
}

async function verifyRun(
  store: StoreAccess,
  project: ProjectInfo,
  run: AgentRun,
  stream: AgentStreamController,
  input: {
    changedFiles: string[];
    deletedFiles: string[];
    packageChanged: boolean;
    packageBaselineJson?: string | null;
    previewUrl: string | null;
  },
): Promise<VerificationReport> {
  run = await commitTransition(
    store,
    project.id,
    run,
    stateMachine.transition(run, { type: "enter_verifying" }),
  );
  const activityId = stream.addActivity({
    detail: "Running scope, package, static, build, and preview checks.",
    kind: "verification",
    title: "Verifying run",
  });
  const verifier = new AgentVerifier({
    readFile: (path) => projectApi.readFile(project.id, path),
    recordArtifact: async ({ content, relativePath, runId }) => {
      const artifact = await agentRuntimeApi.writeArtifact(
        project.id,
        runId,
        relativePath,
        content,
      );

      return artifact.id;
    },
    runCommand: async (command) => {
      const result = await store.get().runProjectCommand(project.id, command);

      return result
        ? {
            command: result.command,
            exitCode: result.exitCode,
            output: result.output,
            success: result.success,
          }
        : null;
    },
    startPreview: async () => {
      await store.get().startDevServer(project.id);
      return store.get().previewUrl;
    },
    httpProbe: (url) => projectApi.probePreviewUrl(url),
    waitForPreviewDiagnostics: async ({ runId, windowMs }) => {
      await delay(windowMs);
      return getPreviewDiagnosticsForRun(store, runId);
    },
  });
  const report = await verifier.verify({
    approvedPackageChangeKeys: await loadApprovedPackageChangeKeys(project.id, run.id),
    approvedDeletionPaths: await loadApprovedDeletionPaths(project.id, run.id),
    baselinePackageJson: input.packageBaselineJson,
    changedFiles: input.changedFiles,
    deletedFiles: input.deletedFiles,
    packageChanged: input.packageChanged,
    previewDiagnostics: getPreviewDiagnosticsForRun(store, run.id),
    previewUrl: input.previewUrl,
    run,
  });

  await agentRuntimeApi.saveVerificationReport(project.id, report);
  await appendRuntimeEvent(store, project.id, run.id, "verification.completed", {
    reportId: report.id,
    status: report.status,
  });
  store.set({ currentVerificationReport: report });
  stream.updateActivity(activityId, {
    detail: formatVerificationSummary(report),
    error: report.status === "passed" ? undefined : formatVerificationFailure(report),
    finishActivity: true,
    status: report.status === "passed" ? "succeeded" : "failed",
  });

  return report;
}

async function completeAnswerRun(
  store: StoreAccess,
  project: ProjectInfo,
  run: AgentRun,
  message: string,
) {
  const report: VerificationReport = {
    id: `verification-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    runId: run.id,
    status: "passed",
    checks: [
      {
        id: "answer",
        title: "AnswerVerifier",
        status: "passed",
        summary: "No workspace mutation was requested; answer completed within the task contract.",
        details: { length: message.length },
      },
    ],
    newlyIntroducedFailures: [],
    missingEvidence: [],
    artifactIds: [],
    repairFeedback: [],
    createdAt: new Date().toISOString(),
  };

  await agentRuntimeApi.saveVerificationReport(project.id, report);
  await appendRuntimeEvent(store, project.id, run.id, "verification.completed", {
    reportId: report.id,
    status: report.status,
  });
  store.set({ currentVerificationReport: report });
  run = getCurrentRun(store, run.id) ?? run;
  await commitTransition(
    store,
    project.id,
    run,
    stateMachine.transition(run, { type: "verification_passed", report }),
  );
}

async function buildAgentStepContext(
  store: StoreAccess,
  project: ProjectInfo,
  observations: AgentObservation[],
  runState: ReturnType<typeof createAgentRunState>,
  userRequest: string,
  run: AgentRun,
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
  const siteSpec = await agentRuntimeApi.readSiteSpec(project.id);
  const steering = await consumeSteeringForNextContext(store, project.id, run.id);

  return {
    backend: backendContext,
    diagnostics: buildAgentDiagnostics(state.projectError, state.terminalLogs),
    devServerStatus: state.devServerStatus,
    fileTree: state.fileTree ? formatProjectFileTree(state.fileTree) : null,
    memory: {
      ...dynamicContext.memory,
      selectedSiteNodeId: state.selectedSiteNodeId,
      siteSpecPages: siteSpec?.pages.map((page) => ({
        id: page.id,
        route: page.route,
        title: page.title,
      })),
    },
    observations: dynamicContext.observations,
    previewUrl: state.previewUrl,
    projectName: project.name,
    recentMessages,
    steering,
    taskLedger: {
      ...dynamicContext.taskLedger,
      objective: run.contract.objective,
    },
    workingSummary: dynamicContext.workingSummary,
  };
}

async function consumeSteeringForNextContext(
  store: StoreAccess,
  projectId: string,
  runId: string,
) {
  const events = await agentRuntimeApi.listEvents(projectId, runId);
  const watermark = getSteeringWatermark(events);
  const steeringEvents = events.filter(
    (event) => event.type === "steering.received" && event.sequence > watermark,
  );

  if (steeringEvents.length === 0) {
    return [];
  }

  const steering = steeringEvents
    .map((event) => extractSteeringContent(event.payload))
    .filter((content): content is string => Boolean(content));
  const nextWatermark = Math.max(...steeringEvents.map((event) => event.sequence));
  const checkpoint = await agentRuntimeApi.appendEvent(projectId, {
    runId,
    type: "checkpoint.created",
    timestamp: new Date().toISOString(),
    payload: {
      kind: "steering-consumed",
      steeringWatermark: nextWatermark,
    },
  });

  store.set((state) => ({
    agentEvents: [...state.agentEvents, checkpoint],
  }));

  return steering;
}

function getSteeringWatermark(events: AgentEvent[]) {
  return events.reduce((watermark, event) => {
    if (event.type !== "checkpoint.created") {
      return watermark;
    }

    const payload = event.payload;

    if (
      typeof payload === "object" &&
      payload !== null &&
      "steeringWatermark" in payload &&
      typeof (payload as { steeringWatermark?: unknown }).steeringWatermark === "number"
    ) {
      return Math.max(
        watermark,
        (payload as { steeringWatermark: number }).steeringWatermark,
      );
    }

    return watermark;
  }, 0);
}

function extractSteeringContent(payload: unknown) {
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    typeof (payload as { content?: unknown }).content === "string"
  ) {
    return (payload as { content: string }).content.trim();
  }

  return null;
}

async function checkRunInterruption(
  store: StoreAccess,
  projectId: string,
  run: AgentRun,
  stream: AgentStreamController,
) {
  const latestRun = await agentRuntimeApi.getRun(projectId, run.id);

  if (!latestRun) {
    return;
  }

  if (latestRun.cancelRequested) {
    await commitTransition(
      store,
      projectId,
      latestRun,
      stateMachine.transition(latestRun, { type: "cancel" }),
    );
    stream.failWithTypewriter("Run cancelled.");
    void persistCurrentConversation(store);
    throw new RunStopped("Run cancelled.");
  }

  if (latestRun.pauseRequested) {
    await commitTransition(
      store,
      projectId,
      latestRun,
      stateMachine.transition(latestRun, { type: "pause_at_boundary" }),
    );
    stream.completeWithTypewriter("Run paused at a safe boundary.");
    void persistCurrentConversation(store);
    throw new RunStopped("Run paused.");
  }
}

type RuntimePolicyDecision =
  | (Extract<PolicyDecision, { allowed: false }> & {
      args: unknown;
      toolName: string;
    })
  | (Extract<PolicyDecision, { allowed: true; approvalRequired: true }> & {
      args: unknown;
      toolName: string;
    })
  | Extract<PolicyDecision, { allowed: true; approvalRequired: false }>;

function evaluateStepPolicy(
  run: AgentRun,
  step: Exclude<AgentStepResponse, { type: "answer" | "finish_candidate" }>,
  approvedHashes: Set<string>,
): RuntimePolicyDecision {
  const toolNames = step.type === "tool_calls" ? step.calls.map((call) => call.tool) : [step.tool];

  for (const toolName of toolNames) {
    const tool = getCoreToolDefinition(toolName);

    if (!tool) {
      return {
        allowed: false as const,
        args: null,
        reason: `Unknown tool: ${toolName}`,
        toolName,
      };
    }

    const args = step.type === "tool_calls"
      ? step.calls.find((call) => call.tool === toolName)?.args
      : step.args;
    const decision = policyEngine.evaluate({ approvedHashes, args, run, tool });

    if (!decision.allowed || decision.approvalRequired) {
      return {
        ...decision,
        args,
        toolName,
      };
    }
  }

  return {
    allowed: true as const,
    approvalRequired: false as const,
    reason: "Tool step allowed by policy.",
  };
}

async function failRunBestEffort(
  store: StoreAccess,
  projectId: string,
  run: AgentRun,
  reason: string,
) {
  try {
    const latestRun = (await agentRuntimeApi.getRun(projectId, run.id)) ?? run;

    if (["completed", "failed", "cancelled", "budget_exceeded"].includes(latestRun.status)) {
      return;
    }

    await commitTransition(
      store,
      projectId,
      latestRun,
      stateMachine.transition(latestRun, { type: "fail", reason }),
    );
  } catch {
    // Best-effort failure recording must not mask the user-facing error.
  }
}

function withRunPatch(
  result: ReturnType<RunStateMachine["transition"]>,
  patch: Partial<AgentRun>,
) {
  return {
    ...result,
    run: {
      ...result.run,
      ...patch,
    },
  };
}

function createRuntimeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function loadApprovedApprovalHashes(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);

  return new Set(
    approvals
      .filter((approval) => approval.decision === "approved")
      .map((approval) => approval.normalizedArgsHash),
  );
}

async function loadApprovedPackageChangeKeys(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);
  const hasApprovedPackageChange = approvals.some(
    (approval) =>
      approval.decision === "approved" &&
      approval.targetResources.some(
        (resource) => resource.replace(/\\/g, "/") === "package.json",
      ),
  );

  return hasApprovedPackageChange ? ["*"] : [];
}

async function loadApprovedDeletionPaths(projectId: string, runId: string) {
  const approvals = await agentRuntimeApi.listApprovals(projectId, runId);

  return approvals
    .filter(
      (approval) =>
        approval.decision === "approved" && approval.toolName === "delete_files",
    )
    .flatMap((approval) => approval.targetResources)
    .map((resource) => resource.replace(/\\/g, "/"));
}

function collectTargetResources(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }

  if (Array.isArray(args)) {
    return args.flatMap((item) =>
      typeof item === "object" && item !== null ? collectTargetResources(item) : [],
    );
  }

  const record = args as Record<string, unknown>;
  const resources: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey.includes("path")) {
      if (typeof value === "string") {
        resources.push(value);
      } else if (Array.isArray(value)) {
        resources.push(...value.filter((item): item is string => typeof item === "string"));
      }
    } else if (typeof value === "object" && value !== null) {
      resources.push(...collectTargetResources(value));
    }
  }

  return resources;
}

function addMinutesIso(now: string, minutes: number) {
  return new Date(new Date(now).getTime() + minutes * 60_000).toISOString();
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

async function persistRunCounters(
  store: StoreAccess,
  projectId: string,
  previousRun: AgentRun,
  patch: Partial<Pick<AgentRun, "modelTurns" | "toolCalls" | "mutationCount" | "repairCycles">>,
  eventType: AgentEventType,
  payload: unknown,
) {
  const timestamp = new Date().toISOString();
  const nextRun: AgentRun = {
    ...previousRun,
    ...patch,
    updatedAt: timestamp,
  };
  const { run, event } = await agentRuntimeApi.recordProgress(projectId, previousRun, nextRun, {
    runId: previousRun.id,
    type: eventType,
    timestamp,
    payload,
  });

  store.set((state) => ({
    agentEvents: [...state.agentEvents, event],
    agentRuns: [run, ...state.agentRuns.filter((item) => item.id !== run.id)],
    currentAgentRun: run,
  }));

  return run;
}

function getCurrentRun(store: StoreAccess, runId: string) {
  const run = store.get().currentAgentRun;
  return run?.id === runId ? run : null;
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
  return diagnostics.length <= MAX_AGENT_DIAGNOSTIC_CHARS
    ? diagnostics
    : diagnostics.slice(-MAX_AGENT_DIAGNOSTIC_CHARS);
}

function getPreviewDiagnosticsForRun(store: StoreAccess, runId: string) {
  return store
    .get()
    .previewDiagnostics.filter((diagnostic) => diagnostic.runId === runId || !diagnostic.runId);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

function shouldRequireProjectActionBeforeAnswer(
  userRequest: string,
  observations: AgentObservation[],
) {
  if (observations.length > 0) {
    return false;
  }

  return /(?:bug|error|failed|failure|broken|fix|repair|issue|crash|exception|syntax|compile|build|preview|报错|错误|异常|失败|修复|预览)/i.test(
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

  updateAgentStatus(activeStream, statusLines, "Refreshing preview with verified changes.");
  const activityId = activeStream.addActivity({
    detail: "The final file changes are verified, so the local preview is restarting once.",
    kind: "preview",
    title: "Refreshing final preview",
  });
  await store.get().stopDevServer(projectId);
  await store.get().startDevServer(projectId);
  const nextState = store.get();
  const ok =
    nextState.currentProject?.id === projectId &&
    nextState.devServerStatus === "running" &&
    Boolean(nextState.previewUrl);

  activeStream.updateActivity(activityId, {
    detail: ok ? `Preview restarted at ${nextState.previewUrl}.` : "Preview restart did not complete.",
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

  if (step.type === "finish_candidate") {
    return "The model proposed finishing; verifier will decide.";
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

function createToolActivity(stream: AgentStreamController, step: AgentToolCallStep) {
  return stream.addActivity(describeToolActivity(step));
}

function describeToolActivity(step: AgentToolCallStep): AgentActivityInput {
  switch (step.tool) {
    case "list_files":
      return { detail: step.rationale, kind: "tool", title: "Listing project files" };
    case "read_files":
      return { detail: step.args.paths.join(", "), kind: "tool", title: `Reading ${step.args.paths.length} file(s)` };
    case "grep_files":
      return { detail: `"${step.args.query}"`, kind: "tool", title: "Searching project files" };
    case "glob_files":
      return { detail: step.args.pattern, kind: "tool", title: "Finding matching files" };
    case "edit_file":
      return { detail: step.args.summary, kind: "file", title: `Editing ${step.args.path}` };
    case "write_files":
      return { detail: step.args.files.map((file) => file.path).join(", "), kind: "file", title: `Writing ${step.args.files.length} file(s)` };
    case "delete_files":
      return { detail: step.args.paths.join(", "), kind: "file", title: `Deleting ${step.args.paths.length} file(s)` };
    case "run_command":
      return { command: step.args.command, detail: step.rationale, kind: "command", title: `Running ${step.args.command}` };
    case "apply_supabase_schema":
      return { detail: step.args.summary, kind: "database", title: "Applying database schema" };
    case "start_dev_server":
      return { detail: step.rationale, kind: "preview", title: "Starting preview" };
    case "stop_dev_server":
      return { detail: step.rationale, kind: "preview", title: "Stopping preview" };
    case "refresh_preview":
      return { detail: step.rationale, kind: "preview", title: "Refreshing preview" };
    case "get_site_spec":
      return { detail: step.rationale, kind: "tool", title: "Reading SiteSpec" };
    case "get_page_spec":
      return { detail: step.args.route ?? step.args.pageId ?? step.rationale, kind: "tool", title: "Reading page spec" };
    case "find_site_node":
      return { detail: step.rationale, kind: "tool", title: "Finding SiteSpec nodes" };
    case "update_design_tokens":
      return { detail: step.args.summary ?? step.rationale, kind: "file", title: "Updating design tokens" };
    case "resolve_node_source":
      return { detail: step.args.nodeId, kind: "tool", title: "Resolving node source" };
    case "refresh_site_index":
      return { detail: step.args.reason ?? step.rationale, kind: "tool", title: "Refreshing SiteSpec" };
  }
}

function reportToObservation(report: VerificationReport, step: number): AgentObservation {
  return {
    content: JSON.stringify(report, null, 2),
    ok: false,
    step,
    summary: formatVerificationFailure(report),
    tool: "verifier",
  };
}

function formatVerificationSummary(report: VerificationReport) {
  return report.checks
    .map((check) => `${check.title}: ${check.status} - ${check.summary}`)
    .join("\n");
}

function formatVerificationFailure(report: VerificationReport) {
  const feedback = report.repairFeedback.length > 0
    ? report.repairFeedback.join("\n")
    : report.missingEvidence.join("\n");

  return [
    `Verification ${report.status}.`,
    feedback || "The verifier did not produce enough evidence to complete the run.",
  ].join("\n");
}

function formatAgentFinishMessage(
  step: Extract<AgentStepResponse, { type: "finish_candidate" }>,
  report: VerificationReport,
) {
  const lines = [step.summary];

  if (step.verification) {
    lines.push("", `Model verification note: ${step.verification}`);
  }

  lines.push("", `Verifier: ${report.status}.`);
  return lines.join("\n");
}

function formatVerifiedToolCompletionMessage({
  changedFiles,
  deletedFiles,
  report,
  userRequest,
}: {
  changedFiles: string[];
  deletedFiles: string[];
  report: VerificationReport;
  userRequest: string;
}) {
  const uniqueChangedFiles = [...new Set(changedFiles)].sort();
  const uniqueDeletedFiles = [...new Set(deletedFiles)].sort();
  const lines = [
    `Done: ${userRequest}`,
    "",
    `Verifier: ${report.status}.`,
  ];

  if (uniqueChangedFiles.length > 0) {
    lines.push("", `Changed files: ${uniqueChangedFiles.join(", ")}`);
  }

  if (uniqueDeletedFiles.length > 0) {
    lines.push("", `Deleted files: ${uniqueDeletedFiles.join(", ")}`);
  }

  return lines.join("\n");
}
