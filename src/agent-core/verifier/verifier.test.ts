import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
import type { SiteSpec, TaskType } from "../types";
import { RunStateMachine } from "../runtime/runStateMachine";
import { AgentVerifier, verifyScope } from "./verifier";

describe("AgentVerifier", () => {
  it("blocks website write tasks when required preview evidence is missing", async () => {
    const run = createRun("Build a complete landing page", "full_site");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("inconclusive");
    expect(report.checks.find((check) => check.id === "preview")).toMatchObject({
      required: true,
      status: "inconclusive",
    });
  });

  it("does not require preview evidence for answer runs", async () => {
    const run = createRun("What changed?", "answer");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
    });

    const report = await verifier.verify({
      answerMessage: "The project has no requested code changes.",
      changedFiles: [],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "answer")).toMatchObject({
      required: true,
      status: "passed",
    });
    expect(report.checks.find((check) => check.id === "preview")).toBeUndefined();
  });

  it("fails required preview checks when bridge diagnostics report runtime errors", async () => {
    const run = createRun("Build a complete landing page", "full_site");
    const artifacts: Array<{ content: string; mediaType: string; relativePath: string }> = [];
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      recordArtifact: async ({ content, mediaType, relativePath }) => {
        artifacts.push({ content, mediaType, relativePath });
        return `artifact-${artifacts.length}`;
      },
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      previewDiagnostics: [
        {
          id: "diagnostic-1",
          kind: "console-error",
          level: "error",
          message: "Hydration failed",
          runId: run.id,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    const previewCheck = report.checks.find((check) => check.id === "preview");
    expect(previewCheck).toMatchObject({
      required: true,
      status: "failed",
      summary: "Preview reported 1 error diagnostic(s).",
    });
    expect(previewCheck?.artifactIds).toEqual(["artifact-2"]);
    expect(previewCheck?.details).toEqual({ diagnosticCount: 1 });

    const previewArtifact = artifacts.find((artifact) =>
      artifact.relativePath.startsWith("verifier/preview-"),
    );
    expect(previewArtifact).toMatchObject({
      mediaType: "application/json",
    });
    expect(previewArtifact?.content).toContain("http://localhost:3000");
    expect(previewArtifact?.content).toContain("Hydration failed");
    expect(previewArtifact?.content).toContain('"errorDiagnosticCount": 1');
  });

  it("waits for the preview diagnostic window before passing preview checks", async () => {
    const run = createRun("Build a complete landing page", "full_site");
    const waits: Array<{ runId: string; url: string; windowMs: number }> = [];
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
      waitForPreviewDiagnostics: async (input) => {
        waits.push(input);
        return [
          {
            id: "diagnostic-after-probe",
            kind: "window-error",
            level: "error",
            message: "Client render crashed after load",
            runId: run.id,
            sessionId: input.sessionId,
            timestamp: input.startedAt,
            url: input.url,
          },
        ];
      },
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(waits).toEqual([
      expect.objectContaining({
        runId: run.id,
        url: "http://localhost:3000",
        windowMs: 750,
      }),
    ]);
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "preview")).toMatchObject({
      status: "failed",
      summary: "Preview reported 1 error diagnostic(s).",
    });
  });

  it("ignores stale preview diagnostics from an earlier verification session", async () => {
    const run = createRun("Build a complete landing page", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
      waitForPreviewDiagnostics: async () => [],
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      previewDiagnostics: [
        {
          id: "old-diagnostic",
          kind: "console-error",
          level: "error",
          message: "Old crash",
          runId: run.id,
          sessionId: "old-session",
          timestamp: "2026-01-01T00:00:00.000Z",
          url: "http://localhost:3000",
        },
      ],
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "preview")).toMatchObject({
      status: "passed",
      summary: "Preview probe returned HTTP 200.",
    });
  });

  it("uses pnpm commands when a pnpm lockfile is present and stores command artifacts", async () => {
    const run = createRun("Build a complete landing page", "full_site");
    const commands: string[] = [];
    const artifacts: Array<{ content: string; relativePath: string }> = [];
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: {
            build: "next build",
            lint: "eslint .",
            test: "vitest run",
          },
          dependencies: { next: "15.0.0" },
        }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      }),
      recordArtifact: async ({ content, relativePath }) => {
        artifacts.push({ content, relativePath });
        return `artifact-${artifacts.length}`;
      },
      runCommand: async (command) => {
        commands.push(command);
        return { command, exitCode: 0, output: `${command} ok`, success: true };
      },
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: true,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(commands).toEqual(["pnpm lint", "pnpm test", "pnpm install", "pnpm build"]);
    expect(report.artifactIds).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
      "artifact-4",
      "artifact-5",
    ]);
    expect(artifacts.map((artifact) => artifact.relativePath)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^verifier\/lint-/),
        expect.stringMatching(/^verifier\/test-/),
        expect.stringMatching(/^verifier\/install-/),
        expect.stringMatching(/^verifier\/build-/),
        expect.stringMatching(/^verifier\/preview-/),
      ]),
    );
    expect(artifacts[3]?.content).toContain("$ pnpm build");
    expect(artifacts[4]?.content).toContain("Preview probe returned HTTP 200.");
    expect(artifacts[4]?.content).toContain("http://localhost:3000");
  });

  it("distinguishes pre-existing command failures from newly introduced failures", async () => {
    const run = createRun("Build the site", "full_site");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: {
            build: "next build",
            lint: "eslint .",
          },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => {
        if (command === "npm run lint") {
          return {
            command,
            exitCode: 1,
            output: "Error: legacy lint failure",
            success: false,
          };
        }

        if (command === "npm run build") {
          return {
            command,
            exitCode: 1,
            output: "Error: new build failure",
            success: false,
          };
        }

        return null;
      },
    });

    const report = await verifier.verify({
      baselineCommandResults: {
        build: {
          command: "npm run build",
          exitCode: 0,
          output: "ok",
          success: true,
        },
        lint: {
          command: "npm run lint",
          exitCode: 1,
          output: "Error: legacy lint failure",
          success: false,
        },
      },
      changedFiles: [],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.newlyIntroducedFailures).toEqual([
      "build: npm run build failed with exit code 1. (baseline passed)",
    ]);

    const staticCheck = report.checks.find((check) => check.id === "static");
    const buildCheck = report.checks.find((check) => check.id === "build");
    expect(staticCheck?.details).toMatchObject({
      commandFailures: [
        {
          baselineStatus: "failed",
          checkId: "lint",
          classification: "pre_existing",
        },
      ],
    });
    expect(buildCheck?.details).toMatchObject({
      commandFailures: [
        {
          baselineStatus: "passed",
          checkId: "build",
          classification: "newly_introduced",
        },
      ],
    });
  });

  it("does not block on pre-existing unrelated build failures", async () => {
    const run = createRun("Change hero copy", "copy_edit");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? {
              command,
              exitCode: 1,
              output: "./lib/legacy.ts:10:2\nType error: legacy failure",
              success: false,
            }
          : null,
    });

    const report = await verifier.verify({
      baselineCommandResults: {
        build: {
          command: "npm run build",
          exitCode: 1,
          output: "./lib/legacy.ts:10:2\nType error: legacy failure",
          success: false,
        },
      },
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "build")).toMatchObject({
      classification: "pre_existing",
      severity: "warning",
      status: "inconclusive",
    });
  });

  it("blocks pre-existing failures that overlap changed files", async () => {
    const run = createRun("Change hero copy", "copy_edit");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? {
              command,
              exitCode: 1,
              output: "./app/page.tsx:12:3\nType error: changed file failure",
              success: false,
            }
          : null,
    });

    const report = await verifier.verify({
      baselineCommandResults: {
        build: {
          command: "npm run build",
          exitCode: 1,
          output: "./app/page.tsx:12:3\nType error: changed file failure",
          success: false,
        },
      },
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "build")).toMatchObject({
      classification: "pre_existing",
      relatedToChangedFiles: true,
      severity: "blocking",
    });
  });

  it("skips preview startup for small edit tasks when no preview is running", async () => {
    const run = createRun("Change hero copy", "copy_edit");
    let startedPreview = false;
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? { command, exitCode: 0, output: "ok", success: true }
          : null,
      startPreview: async () => {
        startedPreview = true;
        return "http://localhost:3000";
      },
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      run,
    });

    expect(startedPreview).toBe(false);
    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "preview")).toMatchObject({
      status: "skipped",
      required: false,
    });
  });

  it("includes concise command diagnostics in repair feedback", async () => {
    const run = createRun("Build the site", "full_site");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: {
            build: "next build",
          },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) =>
        command === "npm run build"
          ? {
              command,
              exitCode: 1,
              output: [
                "Creating an optimized production build ...",
                "Failed to compile.",
                "./lib/game/controller.ts:118:46",
                "Type error: Argument of type 'HandEvaluation' is not assignable to parameter of type 'HandRank'.",
                "  116 |",
                "  117 |   const handDescriptions = playerEvaluations.map(",
                "> 118 |     (e) => `${e.player.name}: ${describeHand(e.hand)}`",
                "      |                                              ^",
              ].join("\n"),
              success: false,
            }
          : null,
    });

    const report = await verifier.verify({
      baselineCommandResults: {
        build: {
          command: "npm run build",
          exitCode: 0,
          output: "ok",
          success: true,
        },
      },
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.repairFeedback.join("\n")).toContain("Diagnostics:");
    expect(report.repairFeedback.join("\n")).toContain(
      "./lib/game/controller.ts:118:46",
    );
    expect(report.repairFeedback.join("\n")).toContain(
      "Type error: Argument of type 'HandEvaluation' is not assignable to parameter of type 'HandRank'.",
    );
    expect(report.repairFeedback.join("\n")).toContain(
      "describeHand(e.hand)",
    );
  });

  it("verifies dependency additions without package approval keys", async () => {
    const baseRun = createRun("Change dependency setup", "full_site");
    const run = {
      ...baseRun,
      contract: {
        ...baseRun.contract,
        permissions: {
          ...baseRun.contract.permissions,
          dependencyChange: "ask" as const,
        },
      },
    };
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: {
            "framer-motion": "11.0.0",
            next: "15.0.0",
          },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      baselinePackageJson: JSON.stringify({
        scripts: { build: "next build" },
        dependencies: { next: "15.0.0" },
      }),
      changedFiles: ["package.json"],
      packageChanged: true,
      previewUrl: "http://localhost:3000",
      run,
    });

    const packageCheck = report.checks.find((check) => check.id === "package");
    expect(report.status).toBe("passed");
    expect(packageCheck).toMatchObject({
      status: "passed",
      summary:
        "package.json is valid. Package manager: npm. 1 dependency change(s) verified.",
    });
  });

  it("does not pass a write task when no task-scoped file changed", async () => {
    const run = createRun("Change the hero copy", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: [],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("inconclusive");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        required: true,
        status: "inconclusive",
      });
  });

  it("passes a spec task with no new mutations when expected files were inspected and technical checks pass", async () => {
    const run = createRun("实现首页Lobby组件，通过API与Supabase交互存储房间信息。", "backend_feature");
    run.contract = {
      ...run.contract,
      source: {
        acceptanceCriteriaIds: ["criterion-2", "criterion-3"],
        expectedFiles: ["components/Lobby.tsx", "app/api/rooms/route.ts"],
        mode: "spec",
        requirementIds: ["story-2"],
        revisionId: "rev-1",
        specId: "spec-1",
        taskId: "task-6",
      },
    };
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: [],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      readSnapshots: [
        {
          contentHash: "hash-1",
          path: "components/Lobby.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
        {
          contentHash: "hash-2",
          path: "app/api/rooms/route.ts",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        status: "passed",
        summary: expect.stringContaining("Existing workspace evidence inspected expected file(s)"),
      });
  });

  it("does not pass a no-mutation spec task when inspected files miss expected files", async () => {
    const run = createRun("实现首页Lobby组件，通过API与Supabase交互存储房间信息。", "backend_feature");
    run.contract = {
      ...run.contract,
      source: {
        acceptanceCriteriaIds: ["criterion-2"],
        expectedFiles: ["components/Lobby.tsx", "app/api/rooms/route.ts"],
        mode: "spec",
        requirementIds: ["story-2"],
        revisionId: "rev-1",
        specId: "spec-1",
        taskId: "task-6",
      },
    };
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: [],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      readSnapshots: [
        {
          contentHash: "hash-1",
          path: "app/page.tsx",
          readAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      run,
    });

    expect(report.status).toBe("inconclusive");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        status: "inconclusive",
      });
  });

  it("passes a database task when a schema tool produced external evidence", async () => {
    const run = createRun("Create Supabase tables", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: [],
      externalEffects: [
        "Supabase schema applied for table(s): profiles, rooms, game_states.",
      ],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        status: "passed",
        summary: expect.stringContaining("Supabase schema applied"),
      });
  });

  it("passes an answer task with AnswerVerifier evidence", async () => {
    const run = createRun("What changed?", "answer");
    const verifier = new AgentVerifier({
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      answerMessage: "Only tests were changed.",
      changedFiles: [],
      packageChanged: false,
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        status: "passed",
        summary: "AnswerVerifier produced a non-empty answer for the read-only task.",
      });
  });

  it("requires changed files to match scoped SiteSpec component sources", async () => {
    const run = createScopedRun({
      componentIds: ["hero.cta"],
    });
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      readSiteSpec: async () => createSiteSpec(),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["components/Footer.tsx"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("inconclusive");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        required: true,
        status: "inconclusive",
      });
  });

  it("accepts changed files that match scoped SiteSpec component sources", async () => {
    const run = createScopedRun({
      componentIds: ["hero.cta"],
    });
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      readSiteSpec: async () => createSiteSpec(),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["components/Hero.tsx"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "acceptance:request-addressed"))
      .toMatchObject({
        status: "passed",
        summary: "Changed components/Hero.tsx for scoped component(s): hero.cta.",
      });
  });

  it("fails when controlled CSS tokens differ from SiteSpec designSystem", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "  --ncb-colors-primary: #dc2626;",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: { primary: "#0f766e" },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "failed",
        summary:
          "Design token mismatch: 1 value mismatch(es), 0 missing in CSS, 0 missing in SiteSpec.",
        details: {
          valueMismatches: [
            {
              cssName: "colors-primary",
              cssValue: "#dc2626",
              siteValue: "#0f766e",
            },
          ],
        },
      });
  });

  it("fails when SiteSpec tokens are missing from controlled CSS", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "  --ncb-colors-primary: #0f766e;",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: {
            primary: "#0f766e",
            secondary: "#164e63",
          },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "failed",
        summary:
          "Design token mismatch: 0 value mismatch(es), 1 missing in CSS, 0 missing in SiteSpec.",
        details: {
          missingInCss: ["colors-secondary"],
        },
      });
  });

  it("fails when controlled CSS tokens are missing from SiteSpec", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "  --ncb-colors-primary: #0f766e;",
          "  --ncb-colors-legacy-extra: #f97316;",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: { primary: "#0f766e" },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "failed",
        summary:
          "Design token mismatch: 0 value mismatch(es), 0 missing in CSS, 1 missing in SiteSpec.",
        details: {
          missingInSiteSpec: ["colors-legacy-extra"],
        },
      });
  });

  it("passes when controlled CSS tokens match SiteSpec designSystem", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "  --ncb-colors-primary: #0f766e;",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: { primary: "#0f766e" },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "passed",
        summary: "1 controlled CSS design token(s) match SiteSpec designSystem.",
      });
  });

  it("fails when a controlled CSS token block is empty but SiteSpec has tokens", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: {
            primary: "#0f766e",
            secondary: "#164e63",
          },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "failed",
        summary:
          "Design token mismatch: 0 value mismatch(es), 2 missing in CSS, 0 missing in SiteSpec.",
        details: {
          missingInCss: ["colors-primary", "colors-secondary"],
        },
      });
  });

  it("passes when a controlled CSS token block and SiteSpec tokens are both empty", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => createSiteSpec(),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "passed",
        summary: "0 controlled CSS design token(s) match SiteSpec designSystem.",
      });
  });

  it("skips design token checks only when the controlled CSS token block is absent", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
      }),
      readSiteSpec: async () => ({
        ...createSiteSpec(),
        designSystem: {
          ...createSiteSpec().designSystem,
          colors: { primary: "#0f766e" },
        },
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["app/page.tsx"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "skipped",
        summary: "No controlled design token CSS block was found.",
      });
  });

  it("fails when controlled CSS has tokens but SiteSpec tokens are empty", async () => {
    const run = createRun("Change the theme color", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: { next: "15.0.0" },
        }),
        "styles/nocode-tokens.css": [
          "/* nocode-builder-design-tokens:start */",
          ":root {",
          "  --ncb-colors-primary: #0f766e;",
          "}",
          "/* nocode-builder-design-tokens:end */",
        ].join("\n"),
      }),
      readSiteSpec: async () => createSiteSpec(),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      changedFiles: ["styles/nocode-tokens.css"],
      packageChanged: false,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => check.id === "design-tokens"))
      .toMatchObject({
        status: "failed",
        summary:
          "Design token mismatch: 0 value mismatch(es), 0 missing in CSS, 1 missing in SiteSpec.",
        details: {
          missingInSiteSpec: ["colors-primary"],
        },
      });
  });

  it("passes dependency changes after comparing baseline package.json", async () => {
    const run = createRun("Change dependency setup", "full_site");
    const verifier = new AgentVerifier({
      httpProbe: async () => ({
        ok: true,
        status: 200,
        summary: "ok",
      }),
      readFile: createReadFile({
        "package.json": JSON.stringify({
          scripts: { build: "next build" },
          dependencies: {
            "framer-motion": "11.0.0",
            next: "15.0.0",
          },
        }),
      }),
      runCommand: async (command) => ({
        command,
        exitCode: 0,
        output: "ok",
        success: true,
      }),
    });

    const report = await verifier.verify({
      answerMessage: "The dependency changes are verified.",
      baselinePackageJson: JSON.stringify({
        scripts: { build: "next build" },
        dependencies: { next: "15.0.0" },
      }),
      changedFiles: ["package.json"],
      packageChanged: true,
      previewUrl: "http://localhost:3000",
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "package")).toMatchObject({
      status: "passed",
      summary:
        "package.json is valid. Package manager: npm. 1 dependency change(s) verified.",
    });
  });

  it("treats allowed paths as soft guidance while enforcing path safety and mutation budget", () => {
    const contract = compileTaskContract({ objective: "Change hero copy" });

    expect(verifyScope(contract, ["README.md"])).toMatchObject({
      status: "passed",
      summary: "Changed files passed safety scope checks.",
    });
    expect(verifyScope(contract, ["../outside.ts"])).toMatchObject({
      status: "failed",
      summary: "Changed file ../outside.ts is not a valid project-relative path.",
    });
    expect(verifyScope(contract, [".env.local"])).toMatchObject({
      status: "failed",
      summary: "Changed file .env.local is forbidden by task scope.",
    });
    expect(
      verifyScope(
        {
          ...contract,
          budget: {
            ...contract.budget,
            maxMutations: 1,
          },
        },
        ["app/page.tsx", "components/Hero.tsx"],
      ),
    ).toMatchObject({
      status: "failed",
      summary: "Changed 2 file(s), exceeding mutation budget 1.",
    });
  });

  it("requires approval evidence for file deletions when the contract asks", () => {
    const contract = compileTaskContract({ objective: "Remove obsolete component" });

    expect(
      verifyScope(contract, ["components/Old.tsx"], {
        deletedFiles: ["components/Old.tsx"],
      }),
    ).toMatchObject({
      status: "failed",
      summary: "Deleted file components/Old.tsx requires approval evidence.",
    });

    expect(
      verifyScope(contract, ["components/Old.tsx"], {
        approvedDeletionPaths: ["components/Old.tsx"],
        deletedFiles: ["components/Old.tsx"],
      }),
    ).toMatchObject({
      status: "passed",
    });
  });

  it("blocks file deletions when the contract denies them", () => {
    const contract = compileTaskContract({ objective: "Remove obsolete component" });

    expect(
      verifyScope(
        {
          ...contract,
          permissions: {
            ...contract.permissions,
            fileDelete: "deny",
          },
        },
        ["components/Old.tsx"],
        {
          deletedFiles: ["components/Old.tsx"],
        },
      ),
    ).toMatchObject({
      status: "failed",
      summary: "Deleted file components/Old.tsx is denied by the task contract.",
    });
  });
});

function createRun(objective: string, taskType: TaskType) {
  return new RunStateMachine().createRun({
    contract: compileTaskContract({ objective, taskType }),
    conversationId: "conversation-1",
    projectId: "project-1",
    runId: `run-${taskType}`,
  });
}

function createScopedRun(scope: { componentIds?: string[]; pages?: string[] }) {
  const contract = compileTaskContract({
    objective: "Change selected SiteSpec node",
    taskType: "component_edit",
  });

  return new RunStateMachine().createRun({
    contract: {
      ...contract,
      scope: {
        ...contract.scope,
        ...scope,
      },
    },
    conversationId: "conversation-1",
    projectId: "project-1",
    runId: "run-scoped",
  });
}

function createSiteSpec(): SiteSpec {
  return {
    designSystem: {
      colors: {},
      radii: {},
      spacing: {},
      typography: {},
    },
    pages: [
      {
        id: "home",
        nodes: [
          {
            id: "hero",
            source: { path: "components/Hero.tsx" },
            type: "section",
            children: [
              {
                id: "hero.cta",
                source: { path: "components/Hero.tsx" },
                type: "button",
              },
            ],
          },
        ],
        route: "/",
        title: "Home",
      },
    ],
    product: {
      description: "",
      language: "en",
      name: "Project",
    },
    projectId: "project-1",
    reusableComponents: [
      {
        id: "hero.cta",
        name: "Hero CTA",
        source: { path: "components/Hero.tsx" },
      },
    ],
    version: 1,
  };
}

function createReadFile(files: Record<string, string>) {
  return async (path: string) => {
    const content = files[path];

    if (content === undefined) {
      throw new Error(`Missing file: ${path}`);
    }

    return content;
  };
}
