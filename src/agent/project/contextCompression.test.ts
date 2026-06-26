import { describe, expect, it } from "vitest";
import type { AgentRun } from "../../agent-core/types";
import { createTaskManifestFromContract } from "../../agent-core/manifest/taskManifest";
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

  it("applies a final hard cap while retaining critical task fields", () => {
    const large = (label: string) => `${label} ${"x".repeat(12_000)}`;
    const context = createAgentStepContext({
      backend: {
        recommendedPatterns: Array.from({ length: 20 }, (_, index) =>
          large(`pattern-${index}`),
        ),
        supabase: {
          ...createAgentStepContext().backend!.supabase,
          notes: Array.from({ length: 20 }, (_, index) => large(`note-${index}`)),
          tables: Array.from({ length: 30 }, (_, tableIndex) => ({
            columns: Array.from({ length: 30 }, (_, columnIndex) => ({
              name: `column_${tableIndex}_${columnIndex}_${"x".repeat(200)}`,
              nullable: false,
              required: true,
              type: `text_${"x".repeat(200)}`,
            })),
            name: `table_${tableIndex}_${"x".repeat(200)}`,
            primaryKeys: ["id"],
          })),
        },
      },
      diagnostics: large("diagnostics"),
      fileTree: large("file-tree"),
      memory: {
        designConventions: Array.from({ length: 20 }, (_, index) =>
          large(`convention-${index}`),
        ),
        fileSummaries: Array.from({ length: 40 }, (_, index) => ({
          contentHash: `hash-${index}`,
          path: `app/file-${index}.tsx`,
          summary: large(`summary-${index}`),
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        objective: large("memory objective"),
        projectIndex: {
          components: Array.from({ length: 50 }, (_, index) => `component-${index}`),
          dataFiles: Array.from({ length: 50 }, (_, index) => `data-${index}`),
          dependencies: Array.from({ length: 50 }, (_, index) => `dep-${index}`),
          fileTreeHash: "hash",
          libFiles: Array.from({ length: 50 }, (_, index) => `lib-${index}`),
          packageManager: "pnpm",
          routes: Array.from({ length: 50 }, (_, index) => `route-${index}`),
          totalEditableFiles: 200,
        },
        recentChanges: Array.from({ length: 20 }, (_, index) => large(`change-${index}`)),
        structureSummary: large("structure"),
        techStack: Array.from({ length: 30 }, (_, index) => `tech-${index}`),
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      observations: Array.from({ length: 60 }, (_, index) => ({
        content: large(`observation-${index}`),
        ok: index % 11 !== 0,
        step: index + 1,
        summary: index % 11 === 0 ? `Failure ${index}` : `Observation ${index}`,
        tool: index % 17 === 0 ? "model_validation" : "read_files",
      })),
      specContext: {
        ...createAgentStepContext().specContext!,
        acceptanceCriteria: [
          {
            description: large("critical acceptance criteria"),
            id: "criterion-critical",
            required: true,
          },
        ],
        currentTask: {
          ...createAgentStepContext().specContext!.currentTask,
          objective: "Keep this current task objective.",
        },
        design: {
          dataModel: Array.from({ length: 30 }, (_, index) => large(`model-${index}`)),
          integrations: Array.from({ length: 30 }, (_, index) => large(`integration-${index}`)),
          summary: large("design summary"),
          technicalDecisions: Array.from({ length: 30 }, (_, index) =>
            large(`decision-${index}`),
          ),
          verificationStrategy: Array.from({ length: 30 }, (_, index) =>
            large(`verify-${index}`),
          ),
        },
        relatedTasks: Array.from({ length: 30 }, (_, index) => ({
          id: `task-${index}`,
          status: "pending",
          title: large(`related-${index}`),
        })),
      },
    });

    const compressed = compressAgentStepContext(context);

    expect(compressed.contextReport.finalChars).toBeLessThanOrEqual(
      CONTEXT_ENVELOPE_CHAR_BUDGET,
    );
    expect(compressed.contextReport.rawChars).toBeGreaterThan(
      compressed.contextReport.finalChars,
    );
    expect(compressed.contextReport.finalChars).toBe(JSON.stringify(compressed).length);
    expect(compressed.specContext?.currentTask.objective).toContain(
      "Keep this current task objective",
    );
    expect(compressed.specContext?.acceptanceCriteria).toHaveLength(1);
    expect(compressed.budgetState.pressure).toBe("normal");
    expect(compressed.runContextSummary.nextStep).toContain("Repair the latest build failure");
  });

  it("keeps current task linked requirements, criteria, and manifest beyond the first dozen", () => {
    const context = createAgentStepContext({
      specContext: {
        ...createAgentStepContext().specContext!,
        acceptanceCriteria: [
          ...Array.from({ length: 16 }, (_, index) => ({
            description: `Secondary criterion ${index}`,
            id: `criterion-secondary-${index}`,
            required: true,
          })),
          {
            description: "Primary linked criterion that must survive compression.",
            id: "criterion-linked",
            required: true,
          },
        ],
        currentTask: {
          ...createAgentStepContext().specContext!.currentTask,
          acceptanceCriteriaIds: ["criterion-linked"],
          requirementIds: ["story-linked"],
        },
        requirements: [
          ...Array.from({ length: 16 }, (_, index) => ({
            description: `Secondary story ${index}`,
            id: `story-secondary-${index}`,
          })),
          {
            description: "Primary linked requirement that must survive compression.",
            id: "story-linked",
          },
        ],
      },
    });

    const compressed = compressAgentStepContext(context);

    expect(compressed.manifest.rawUserGoal).toBe("Build an online poker game.");
    expect(compressed.specContext?.acceptanceCriteria.map((item) => item.id))
      .toContain("criterion-linked");
    expect(compressed.specContext?.requirements.map((item) => item.id))
      .toContain("story-linked");
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
    manifest: createTaskManifestFromContract({
      contract: createRun().contract,
      conversationId: "conversation-1",
      projectId: "project-1",
      rawUserGoal: "Build an online poker game.",
    }),
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
