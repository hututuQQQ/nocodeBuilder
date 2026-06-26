import { describe, expect, it } from "vitest";
import type { AgentRun } from "../../agent-core/types";
import {
  buildAgentBudgetState,
  compressAgentStepContext,
  CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET,
  CONTEXT_ENVELOPE_CHAR_BUDGET,
} from "./contextCompression";
import type { AgentStepContext } from "./types";

describe("agent context compression", () => {
  it("keeps critical failure, Spec, and backend context within the prompt budget", () => {
    const context = createAgentStepContext({
      observations: Array.from({ length: 30 }, (_, index) => ({
        content:
          index === 29
            ? `Build failed in app/api/rooms/route.ts ${"x".repeat(20_000)}`
            : `Observation ${index} ${"x".repeat(8_000)}`,
        ok: index !== 29,
        step: index + 1,
        summary: index === 29 ? "Build failed" : `Observation ${index}`,
        tool: index === 29 ? "npm run build" : "read_files",
      })),
    });

    const compressed = compressAgentStepContext(context);

    expect(compressed.contextReport.finalChars).toBeLessThanOrEqual(
      CONTEXT_ENVELOPE_CHAR_BUDGET,
    );
    expect(compressed.observations.some((item) => item.summary === "Build failed"))
      .toBe(true);
    expect(compressed.specContext?.design.integrations).toContain("Supabase Realtime");
    expect(compressed.backend?.supabase.configured).toBe(true);
    expect(compressed.contextReport.summarizedObservations).toBeGreaterThan(0);
  });

  it("marks budget pressure as low or critical near run limits", () => {
    expect(
      buildAgentBudgetState(createRun({ modelTurns: 8 })).pressure,
    ).toBe("low");
    expect(
      buildAgentBudgetState(createRun({ modelTurns: 9 })).pressure,
    ).toBe("critical");
  });

  it("retains recent model validation failures even when other failures are newer", () => {
    const context = createAgentStepContext({
      observations: Array.from({ length: 18 }, (_, index) => ({
        content:
          index === 1
            ? "Invalid model response: unsupported Supabase default value \"''\"."
            : `Failure ${index}`,
        ok: false,
        step: index + 1,
        summary:
          index === 1
            ? "Model response validation failed"
            : `Failure ${index}`,
        tool: index === 1 ? "model_validation" : "run_command",
      })),
    });

    const compressed = compressAgentStepContext(context);

    expect(compressed.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: "Model response validation failed",
          tool: "model_validation",
        }),
      ]),
    );
    expect(compressed.runContextSummary.latestFailures.join("\n")).toContain(
      "Build failed",
    );
  });

  it("uses the smaller critical budget for loop rescue context", () => {
    const context = createAgentStepContext({
      budgetState: buildAgentBudgetState(createRun({ modelTurns: 9 })),
      observations: [
        ...Array.from({ length: 20 }, (_, index) => ({
          content: `Large successful observation ${index} ${"x".repeat(8_000)}`,
          ok: true,
          step: index + 1,
          summary: `Successful observation ${index}`,
          tool: "read_files",
        })),
        {
          content: `Loop rescue details ${"y".repeat(20_000)}`,
          ok: false,
          step: 21,
          summary: "Loop rescue: Build failed",
          tool: "loop_rescue",
        },
      ],
    });

    const compressed = compressAgentStepContext(context);

    expect(compressed.contextReport.finalChars).toBeLessThanOrEqual(
      CRITICAL_CONTEXT_ENVELOPE_CHAR_BUDGET,
    );
    expect(compressed.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "loop_rescue",
        }),
      ]),
    );
  });
});

function createAgentStepContext(
  patch: Partial<AgentStepContext> = {},
): AgentStepContext {
  return {
    backend: {
      recommendedPatterns: ["Use App Router API routes for server writes."],
      supabase: {
        configured: true,
        env: {
          anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
          dbUrl: "SUPABASE_DB_URL",
          schema: "SUPABASE_SCHEMA",
          secretKey: "SUPABASE_SECRET_KEY",
          url: "NEXT_PUBLIC_SUPABASE_URL",
        },
        notes: ["Use server-only Supabase writes."],
        schema: "public",
        schemaLoadStatus: "loaded",
        status: {
          anonKeyConfigured: true,
          dbUrlConfigured: true,
          secretKeyConfigured: true,
          urlConfigured: true,
        },
        tables: [
          {
            columns: [
              {
                name: "id",
                nullable: false,
                required: true,
                type: "uuid",
              },
            ],
            name: "rooms",
            primaryKeys: ["id"],
          },
        ],
      },
    },
    budgetState: buildAgentBudgetState(createRun()),
    contextReport: {
      finalChars: 0,
      rawChars: 0,
      retainedObservations: 0,
      summarizedObservations: 0,
    },
    diagnostics: null,
    devServerStatus: "running",
    fileTree: `app/page.tsx\napp/api/rooms/route.ts\n${"x".repeat(20_000)}`,
    memory: null,
    observations: [],
    previewUrl: "http://localhost:3000",
    projectName: "Poker",
    recentMessages: [],
    runContextSummary: {
      changedFiles: ["app/api/rooms/route.ts"],
      completed: ["Created lobby UI"],
      decisions: ["Use Supabase Realtime for room updates"],
      deletedFiles: [],
      importantFiles: ["app/api/rooms/route.ts"],
      latestFailures: ["Build failed in app/api/rooms/route.ts"],
      nextStep: "Repair the latest build failure.",
      objective: "Build an online poker game.",
      summarizedObservationCount: 30,
    },
    specContext: {
      acceptanceCriteria: [
        {
          description: "Players can join a realtime poker room.",
          id: "criterion-1",
          required: true,
        },
      ],
      brief: "Online poker game",
      currentTask: {
        acceptanceCriteriaIds: ["criterion-1"],
        allowedPaths: ["app/**", "lib/**"],
        dependencyIds: [],
        expectedFiles: ["app/api/rooms/route.ts"],
        id: "task-1",
        objective: "Create realtime room backend.",
        requirementIds: ["story-1"],
        status: "running",
        title: "Realtime rooms",
      },
      design: {
        dataModel: ["rooms, room_players, game_states"],
        integrations: ["Supabase Realtime"],
        summary: "Use Supabase for backend state.",
        technicalDecisions: ["Server writes go through route handlers."],
        verificationStrategy: ["Build succeeds."],
      },
      executionMode: "modify",
      goal: "Build multiplayer poker.",
      kind: "initial_build",
      relatedTasks: [],
      requirements: [
        {
          description: "As a player, I can join a room.",
          id: "story-1",
        },
      ],
      revisionId: "revision-1",
      specId: "spec-1",
      specStatus: "building",
      taskProgress: {
        blocked: 0,
        failed: 0,
        passed: 0,
        pending: 1,
        running: 1,
        total: 2,
      },
    },
    steering: [],
    taskLedger: null,
    workingSummary: null,
    ...patch,
  };
}

function createRun(patch: Partial<AgentRun> = {}): AgentRun {
  return {
    cancelRequested: false,
    completedAt: undefined,
    contract: {
      acceptanceCriteria: [],
      budget: {
        maxModelTurns: 10,
        maxMutations: 10,
        maxRepairCycles: 10,
        maxToolCalls: 10,
      },
      objective: "Build poker",
      permissions: {
        databaseChange: "allow",
        dependencyChange: "allow",
        fileDelete: "ask",
        fileWrite: true,
        previewDeployment: "deny",
        productionDeployment: "deny",
      },
      scope: {
        allowedPaths: ["app/**"],
        forbiddenPaths: [],
      },
      taskType: "backend_feature",
    },
    conversationId: "conversation-1",
    id: "run-1",
    modelTurns: 0,
    mutationCount: 0,
    pauseRequested: false,
    phase: "planning",
    projectId: "project-1",
    repairCycles: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    stateVersion: 1,
    status: "planning",
    toolCalls: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
