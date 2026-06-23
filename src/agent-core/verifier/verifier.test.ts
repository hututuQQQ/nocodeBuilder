import { describe, expect, it } from "vitest";
import { compileTaskContract } from "../contract/taskContract";
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
    expect(report.checks.find((check) => check.id === "preview")).toMatchObject({
      required: false,
      status: "skipped",
    });
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
    const run = createRun("Explain what changed", "answer");
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

  it("blocks dependency additions that are not approved by package change keys", async () => {
    const run = createRun("Explain dependency changes", "answer");
    const verifier = new AgentVerifier({
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
      changedFiles: [],
      packageChanged: true,
      run,
    });

    const packageCheck = report.checks.find((check) => check.id === "package");
    expect(report.status).toBe("failed");
    expect(packageCheck).toMatchObject({
      status: "failed",
      summary: "Dependency changes require approval: dependencies:add:framer-motion.",
    });
    expect(packageCheck?.details).toMatchObject({
      unapprovedPackageChangeKeys: ["dependencies:add:framer-motion"],
      dependencyChanges: [
        {
          after: "11.0.0",
          before: null,
          changeType: "add",
          key: "dependencies:add:framer-motion",
          name: "framer-motion",
          section: "dependencies",
        },
      ],
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

  it("passes approved dependency changes after comparing baseline package.json", async () => {
    const run = createRun("Explain dependency changes", "answer");
    const verifier = new AgentVerifier({
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
      answerMessage: "The dependency changes are approved.",
      approvedPackageChangeKeys: ["dependencies:add:framer-motion"],
      baselinePackageJson: JSON.stringify({
        scripts: { build: "next build" },
        dependencies: { next: "15.0.0" },
      }),
      changedFiles: [],
      packageChanged: true,
      run,
    });

    expect(report.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "package")).toMatchObject({
      status: "passed",
      summary:
        "package.json is valid. Package manager: npm. 1 dependency change(s) approved.",
    });
  });

  it("enforces allowed paths, project-relative paths, and mutation budget in scope checks", () => {
    const contract = compileTaskContract({ objective: "Change hero copy" });

    expect(verifyScope(contract, ["README.md"])).toMatchObject({
      status: "failed",
      summary: "Changed file README.md is outside allowed task scope.",
    });
    expect(verifyScope(contract, ["../outside.ts"])).toMatchObject({
      status: "failed",
      summary: "Changed file ../outside.ts is not a valid project-relative path.",
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

function createRun(objective: string, taskType: "answer" | "full_site") {
  return new RunStateMachine().createRun({
    contract: compileTaskContract({ objective, taskType }),
    conversationId: "conversation-1",
    projectId: "project-1",
    runId: `run-${taskType}`,
  });
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
