import { invoke } from "@tauri-apps/api/core";
import type {
  AgentEvent,
  AgentEventType,
  AgentRun,
  SiteSourceMap,
  SiteSpec,
  VerificationReport,
} from "../agent-core/types";
import type { RunTransitionResult } from "../agent-core/runtime/runStateMachine";

type AgentEventRecord = {
  id: string;
  runId: string;
  sequence: number;
  eventType: AgentEventType;
  timestamp: string;
  payload: unknown;
  artifactIds: string[];
};

type VerificationReportRecord = {
  id: string;
  runId: string;
  status: VerificationReport["status"];
  createdAt: string;
  report: VerificationReport;
  artifactIds: string[];
};

type AgentTransitionResultRecord = {
  run: AgentRun;
  event: AgentEventRecord;
};

export const agentRuntimeApi = {
  createRun(projectId: string, run: AgentRun) {
    return invoke<AgentRun>("create_agent_run", {
      projectId,
      run: {
        id: run.id,
        projectId: run.projectId,
        conversationId: run.conversationId,
        contract: run.contract,
        status: run.status,
        phase: run.phase,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
      },
    });
  },

  listRuns(projectId: string) {
    return invoke<AgentRun[]>("list_agent_runs", { projectId });
  },

  getRun(projectId: string, runId: string) {
    return invoke<AgentRun | null>("get_agent_run", { projectId, runId });
  },

  async transitionRun(
    projectId: string,
    previousRun: AgentRun,
    result: RunTransitionResult,
  ) {
    const record = await invoke<AgentTransitionResultRecord>("transition_agent_run", {
      projectId,
      update: {
        runId: result.run.id,
        expectedStateVersion: previousRun.stateVersion,
        status: result.run.status,
        phase: result.run.phase,
        modelTurns: result.run.modelTurns,
        toolCalls: result.run.toolCalls,
        mutationCount: result.run.mutationCount,
        repairCycles: result.run.repairCycles,
        cancelRequested: result.run.cancelRequested,
        pauseRequested: result.run.pauseRequested,
        completedAt: result.run.completedAt,
        updatedAt: result.run.updatedAt,
        eventType: result.event.type,
        eventTimestamp: result.event.timestamp,
        eventPayload: result.event.payload,
        artifactIds: result.event.artifactIds,
      },
    });

    return {
      run: record.run,
      event: mapEventRecord(record.event),
    };
  },

  async appendEvent(
    projectId: string,
    event: Omit<AgentEvent, "id" | "sequence"> & { id?: string },
  ) {
    const record = await invoke<AgentEventRecord>("append_agent_event", {
      projectId,
      event: {
        id: event.id ?? createId("event"),
        runId: event.runId,
        eventType: event.type,
        timestamp: event.timestamp,
        payload: event.payload,
        artifactIds: event.artifactIds,
      },
    });

    return mapEventRecord(record);
  },

  async listEvents(projectId: string, runId: string) {
    const records = await invoke<AgentEventRecord[]>("list_agent_events", {
      projectId,
      runId,
    });

    return records.map(mapEventRecord);
  },

  async saveVerificationReport(projectId: string, report: VerificationReport) {
    const record = await invoke<VerificationReportRecord>("save_verification_report", {
      projectId,
      report: {
        id: report.id,
        runId: report.runId,
        status: report.status,
        createdAt: report.createdAt,
        report,
        artifactIds: report.artifactIds,
      },
    });

    return record.report;
  },

  async getLatestVerificationReport(projectId: string, runId: string) {
    const record = await invoke<VerificationReportRecord | null>(
      "get_latest_verification_report",
      { projectId, runId },
    );

    return record?.report ?? null;
  },

  writeArtifact(projectId: string, runId: string, relativePath: string, content: string) {
    return invoke("write_agent_artifact", {
      projectId,
      artifact: {
        id: createId("artifact"),
        runId,
        relativePath,
        content,
      },
    });
  },

  readSiteSpec(projectId: string) {
    return invoke<SiteSpec | null>("read_site_spec", { projectId });
  },

  writeSiteSpec(projectId: string, siteSpec: SiteSpec) {
    return invoke<void>("write_site_spec", { projectId, siteSpec });
  },

  readSiteSourceMap(projectId: string) {
    return invoke<SiteSourceMap | null>("read_site_source_map", { projectId });
  },

  writeSiteSourceMap(projectId: string, sourceMap: SiteSourceMap) {
    return invoke<void>("write_site_source_map", { projectId, sourceMap });
  },
};

function mapEventRecord(record: AgentEventRecord): AgentEvent {
  return {
    id: record.id,
    runId: record.runId,
    sequence: record.sequence,
    type: record.eventType,
    timestamp: record.timestamp,
    payload: record.payload,
    artifactIds: record.artifactIds,
  };
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
