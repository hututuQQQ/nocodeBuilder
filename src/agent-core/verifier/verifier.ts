import type {
  AgentReadSnapshot,
  AgentRun,
  PreviewDiagnostic,
  SiteSpec,
  TaskContract,
  VerificationCheck,
  VerificationReport,
  VerificationStatus,
} from "../types";
import {
  isInvalidProjectPath,
  isPathForbidden,
  matchesProjectPathPattern,
  normalizeProjectPath,
} from "../pathScope";

export type VerifierCommandResult = {
  command: string;
  exitCode: number | null;
  output: string;
  success: boolean;
};

export type BaselineCommandResults = Partial<
  Record<BaselineCommandCheckId, VerifierCommandResult | null>
>;

type BaselineCommandCheckId = "lint" | "test" | "build" | "install";

type CommandFailureClassification =
  | "newly_introduced"
  | "pre_existing"
  | "unknown_baseline";

type CommandFailureDetail = {
  baselineStatus: "passed" | "failed" | "missing" | "not_run";
  checkId: BaselineCommandCheckId;
  classification: CommandFailureClassification;
  command: string;
  diagnostics: string[];
  exitCode: number | null;
  relatedToChangedFiles: boolean;
  summary: string;
};

type DependencyChange = {
  after: string | null;
  before: string | null;
  changeType: "add" | "remove" | "update";
  key: string;
  name: string;
  section: "dependencies" | "devDependencies";
};

const DEFAULT_PREVIEW_DIAGNOSTIC_WINDOW_MS = 750;

export type VerifierPorts = {
  readFile?: (path: string) => Promise<string>;
  recordArtifact?: (input: {
    content: string;
    mediaType: string;
    relativePath: string;
    runId: string;
    title: string;
  }) => Promise<string>;
  runCommand?: (command: string) => Promise<VerifierCommandResult | null>;
  readSiteSpec?: () => Promise<SiteSpec | null>;
  startPreview?: () => Promise<string | null>;
  stopPreview?: () => Promise<void>;
  httpProbe?: (url: string) => Promise<{ ok: boolean; status: number; summary: string }>;
  waitForPreviewDiagnostics?: (input: {
    runId: string;
    sessionId: string;
    startedAt: string;
    url: string;
    windowMs: number;
  }) => Promise<PreviewDiagnostic[]>;
};

export type VerificationInput = {
  answerMessage?: string;
  baselineCommandResults?: BaselineCommandResults;
  baselinePackageJson?: string | null;
  changedFiles: string[];
  deletedFiles?: string[];
  externalEffects?: string[];
  noOpReason?: string;
  packageChanged: boolean;
  approvedPackageChangeKeys?: string[];
  approvedDeletionPaths?: string[];
  previewDiagnostics?: PreviewDiagnostic[];
  previewUrl?: string | null;
  readSnapshots?: AgentReadSnapshot[];
  run: AgentRun;
};

export class AgentVerifier {
  private readonly ports: VerifierPorts;

  constructor(ports: VerifierPorts = {}) {
    this.ports = ports;
  }

  async verify(input: VerificationInput): Promise<VerificationReport> {
    const checks: VerificationCheck[] = [];

    checks.push(
      verifyScope(input.run.contract, input.changedFiles, {
        approvedDeletionPaths: input.approvedDeletionPaths ?? [],
        deletedFiles: input.deletedFiles ?? [],
      }),
    );

    if (input.run.contract.taskType === "answer") {
      checks.push(verifyAnswerTask(input));
      checks.push(...verifyAcceptanceCriteria(input.run.contract, input, checks, null));
      return buildVerificationReport(input.run.id, checks);
    }

    checks.push(await this.verifyPackage(input));
    checks.push(await this.verifyStatic(input));
    checks.push(await this.verifyBuild(input));
    checks.push(await this.verifyPreview(input));
    const siteSpec = await this.readSiteSpec();
    checks.push(await this.verifyDesignTokens(siteSpec));
    checks.push(...verifyAcceptanceCriteria(input.run.contract, input, checks, siteSpec));

    return buildVerificationReport(input.run.id, checks);
  }

  private async verifyPackage(input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.readFile) {
      return skippedCheck(
        "package",
        "PackageVerifier",
        "No file reader is available in this environment.",
        true,
      );
    }

    try {
      const parsed = await this.readPackageJson();
      const missingScripts = ["build"].filter(
        (script) => typeof parsed.scripts?.[script] !== "string",
      );
      const packageManager = await this.detectPackageManager(parsed);
      const dependencyChanges = this.diffPackageDependencies(input, parsed);

      if (missingScripts.length > 0) {
        return failedCheck(
          "package",
          "PackageVerifier",
          `package.json is missing script(s): ${missingScripts.join(", ")}.`,
          true,
        );
      }

      const rangeDependency = [
        ...Object.entries(parsed.dependencies ?? {}),
        ...Object.entries(parsed.devDependencies ?? {}),
      ].find(([, version]) => typeof version === "string" && /^[~^*]|latest|x/i.test(version));

      if (rangeDependency) {
        return failedCheck(
          "package",
          "PackageVerifier",
          `Dependency ${rangeDependency[0]} must use an exact pinned version.`,
          true,
        );
      }

      const dependencyApprovalFailure = validateDependencyApprovals(
        input.run.contract,
        dependencyChanges,
        input.approvedPackageChangeKeys ?? [],
      );

      if (dependencyApprovalFailure) {
        return failedCheck(
          "package",
          "PackageVerifier",
          dependencyApprovalFailure.summary,
          true,
          {
            dependencyChanges,
            unapprovedPackageChangeKeys:
              dependencyApprovalFailure.unapprovedPackageChangeKeys,
          },
        );
      }

      return passedCheck(
        "package",
        "PackageVerifier",
        dependencyChanges.length > 0
          ? `package.json is valid. Package manager: ${packageManager}. ${dependencyChanges.length} dependency change(s) verified.`
          : `package.json is valid. Package manager: ${packageManager}.`,
        true,
      );
    } catch (error) {
      return failedCheck(
        "package",
        "PackageVerifier",
        `package.json could not be validated: ${getErrorMessage(error)}`,
        true,
      );
    }
  }

  private async verifyStatic(input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.runCommand) {
      return skippedCheck(
        "static",
        "StaticVerifier",
        "No command runner is available in this environment.",
      );
    }

    const packageJson = await this.tryReadPackageJson();
    const packageManager = await this.detectPackageManager(packageJson);
    const scripts = packageJson?.scripts ?? {};
    const artifactIds: string[] = [];
    const summaries: string[] = [];
    const diagnostics: string[] = [];
    const commandFailures: CommandFailureDetail[] = [];

    for (const script of ["lint", "test"] as const) {
      if (typeof scripts[script] !== "string") {
        summaries.push(`${script}: skipped; no ${script} script is defined.`);
        continue;
      }

      const command = packageManager === "pnpm" ? `pnpm ${script}` : `npm run ${script}`;
      const result = await this.ports.runCommand(command);

      if (!result) {
        summaries.push(`${script}: skipped; command was not run.`);
        continue;
      }

      artifactIds.push(
        await this.recordCommandArtifact(input.run.id, script, result),
      );

      if (!result.success) {
        const extractedDiagnostics = extractDiagnostics(result.output);
        const summary = `${command} failed with exit code ${result.exitCode ?? "unknown"}.`;
        commandFailures.push(
          this.describeCommandFailure(script, result, summary, extractedDiagnostics, input),
        );
        diagnostics.push(
          summary,
          ...extractedDiagnostics,
        );
      } else {
        summaries.push(`${script}: passed.`);
      }
    }

    if (diagnostics.length > 0) {
      return commandFailureCheck(
        "static",
        "StaticVerifier",
        diagnostics[0] ?? "Static verification failed.",
        false,
        {
          commandFailures,
          diagnostics: diagnostics.slice(1),
        },
        artifactIds,
        commandFailures,
      );
    }

    if (artifactIds.length === 0) {
      return skippedCheck(
        "static",
        "StaticVerifier",
        summaries.join(" ") || "No static verification scripts are defined.",
        false,
        artifactIds,
      );
    }

    return passedCheck(
      "static",
      "StaticVerifier",
      summaries.join(" "),
      false,
      artifactIds,
    );
  }

  private async verifyBuild(input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.runCommand) {
      return skippedCheck(
        "build",
        "BuildVerifier",
        "No command runner is available in this environment.",
        true,
      );
    }

    const packageJson = await this.tryReadPackageJson();
    const packageManager = await this.detectPackageManager(packageJson);
    const artifactIds: string[] = [];

    if (input.packageChanged) {
      const installCommand = packageManager === "pnpm" ? "pnpm install" : "npm install";
      const installResult = await this.ports.runCommand(installCommand);

      if (installResult) {
        artifactIds.push(
          await this.recordCommandArtifact(input.run.id, "install", installResult),
        );
      }

      if (!installResult?.success) {
        const summary = `${installCommand} failed with exit code ${
          installResult?.exitCode ?? "unknown"
        }.`;
        const diagnostics = extractDiagnostics(installResult?.output ?? "");

        if (!installResult) {
          return failedCheck(
            "build",
            "BuildVerifier",
            summary,
            true,
            { commandFailures: [], diagnostics },
            artifactIds,
          );
        }

        const commandFailure = this.describeCommandFailure(
          "install",
          installResult,
          summary,
          diagnostics,
          input,
        );
        return commandFailureCheck(
          "build",
          "BuildVerifier",
          summary,
          true,
          {
            commandFailures: [commandFailure],
            diagnostics,
          },
          artifactIds,
          [commandFailure],
        );
      }
    }

    const buildCommand = packageManager === "pnpm" ? "pnpm build" : "npm run build";
    const buildResult = await this.ports.runCommand(buildCommand);

    if (!buildResult) {
      return skippedCheck(
        "build",
        "BuildVerifier",
        "build command was not run.",
        true,
        artifactIds,
      );
    }

    artifactIds.push(await this.recordCommandArtifact(input.run.id, "build", buildResult));

    if (buildResult.success) {
      return passedCheck(
        "build",
        "BuildVerifier",
        `${buildCommand} passed.`,
        true,
        artifactIds,
      );
    }

    const commandFailure = this.describeCommandFailure(
      "build",
      buildResult,
      `${buildCommand} failed with exit code ${buildResult.exitCode ?? "unknown"}.`,
      extractDiagnostics(buildResult.output),
      input,
    );

    return commandFailureCheck(
      "build",
      "BuildVerifier",
      `${buildCommand} failed with exit code ${buildResult.exitCode ?? "unknown"}.`,
      true,
      {
        commandFailures: [commandFailure],
        diagnostics: extractDiagnostics(buildResult.output),
      },
      artifactIds,
      [commandFailure],
    );
  }

  private async verifyPreview(input: VerificationInput): Promise<VerificationCheck> {
    const previewUrl = input.previewUrl ?? null;
    const required = isPreviewRequired(input.run.contract);
    const initialDiagnostics = input.previewDiagnostics ?? [];

    if (!required && !previewUrl) {
      return skippedCheck(
        "preview",
        "PreviewVerifier",
        "Preview was not required for this task and no running preview URL was available.",
        false,
      );
    }

    if (!previewUrl && !this.ports.startPreview) {
      const summary = "No running preview URL or preview starter is available.";
      const artifactIds = [
        await this.recordPreviewArtifact(input.run.id, {
          diagnostics: initialDiagnostics,
          required,
          summary,
          url: null,
        }),
      ];

      return unavailableEvidenceCheck(
        "preview",
        "PreviewVerifier",
        summary,
        required,
        artifactIds,
      );
    }

    const url = previewUrl ?? (await this.ports.startPreview?.()) ?? null;

    if (!url) {
      const summary = "Preview did not produce a URL.";
      const artifactIds = [
        await this.recordPreviewArtifact(input.run.id, {
          diagnostics: initialDiagnostics,
          required,
          summary,
          url: null,
        }),
      ];

      return unavailableEvidenceCheck(
        "preview",
        "PreviewVerifier",
        summary,
        required,
        artifactIds,
      );
    }

    const previewEvidence = await this.collectPreviewDiagnostics(input, url);
    const diagnostics = previewEvidence.diagnostics;

    if (!this.ports.httpProbe) {
      const summary = `Preview URL is available at ${url}; HTTP probe unavailable.`;
      const artifactIds = [
        await this.recordPreviewArtifact(input.run.id, {
          diagnostics,
          required,
          sessionId: previewEvidence.sessionId,
          summary,
          url,
        }),
      ];

      return unavailableEvidenceCheck(
        "preview",
        "PreviewVerifier",
        summary,
        required,
        artifactIds,
      );
    }

    const probe = await this.ports.httpProbe(url);
    const errorDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.level === "error",
    );

    if (probe.ok && errorDiagnostics.length === 0) {
      const summary = `Preview probe returned HTTP ${probe.status}.`;
      const artifactIds = [
        await this.recordPreviewArtifact(input.run.id, {
          diagnostics,
          probe,
          required,
          sessionId: previewEvidence.sessionId,
          summary,
          url,
        }),
      ];

      return passedCheck(
        "preview",
        "PreviewVerifier",
        summary,
        required,
        artifactIds,
      );
    }

    if (errorDiagnostics.length > 0) {
      const summary = `Preview reported ${errorDiagnostics.length} error diagnostic(s).`;
      const artifactIds = [
        await this.recordPreviewArtifact(input.run.id, {
          diagnostics,
          probe,
          required,
          sessionId: previewEvidence.sessionId,
          summary,
          url,
        }),
      ];

      return failedCheck(
        "preview",
        "PreviewVerifier",
        summary,
        required,
        { diagnosticCount: errorDiagnostics.length },
        artifactIds,
      );
    }

    const summary = `Preview probe failed: ${probe.summary}`;
    const artifactIds = [
      await this.recordPreviewArtifact(input.run.id, {
        diagnostics,
        probe,
        required,
        sessionId: previewEvidence.sessionId,
        summary,
        url,
      }),
    ];

    return failedCheck(
      "preview",
      "PreviewVerifier",
      summary,
      required,
      undefined,
      artifactIds,
    );
  }

  private async readPackageJson() {
    if (!this.ports.readFile) {
      throw new Error("No file reader is available.");
    }

    const packageJson = await this.ports.readFile("package.json");
    return JSON.parse(packageJson) as PackageJson;
  }

  private async readSiteSpec() {
    if (!this.ports.readSiteSpec) {
      return null;
    }

    try {
      return await this.ports.readSiteSpec();
    } catch {
      return null;
    }
  }

  private async verifyDesignTokens(siteSpec: SiteSpec | null): Promise<VerificationCheck> {
    if (!this.ports.readFile) {
      return skippedCheck(
        "design-tokens",
        "DesignTokenVerifier",
        "No file reader is available in this environment.",
      );
    }

    if (!siteSpec) {
      return skippedCheck(
        "design-tokens",
        "DesignTokenVerifier",
        "No SiteSpec is available for design token consistency checks.",
      );
    }

    const tokenFile = await this.readDesignTokenFile();

    if (!tokenFile) {
      return skippedCheck(
        "design-tokens",
        "DesignTokenVerifier",
        "No controlled design token CSS block was found.",
      );
    }

    const cssTokens = parseControlledCssTokens(tokenFile.content);
    const siteTokens = flattenSiteDesignTokens(siteSpec);
    const valueMismatches = [...cssTokens.entries()]
      .filter(([cssName]) => siteTokens.has(cssName))
      .map(([cssName, cssValue]) => {
        const siteValue = siteTokens.get(cssName) ?? "";

        if (siteValue === cssValue) {
          return null;
        }

        return {
          cssName,
          cssValue,
          siteValue,
        };
      })
      .filter((mismatch): mismatch is {
        cssName: string;
        cssValue: string;
        siteValue: string;
      } => mismatch !== null);
    const missingInCss = [...siteTokens.keys()]
      .filter((tokenName) => !cssTokens.has(tokenName))
      .sort();
    const missingInSiteSpec = [...cssTokens.keys()]
      .filter((tokenName) => !siteTokens.has(tokenName))
      .sort();

    if (
      valueMismatches.length > 0 ||
      missingInCss.length > 0 ||
      missingInSiteSpec.length > 0
    ) {
      return failedCheck(
        "design-tokens",
        "DesignTokenVerifier",
        `Design token mismatch: ${valueMismatches.length} value mismatch(es), ${missingInCss.length} missing in CSS, ${missingInSiteSpec.length} missing in SiteSpec.`,
        false,
        {
          missingInCss,
          missingInSiteSpec,
          tokenPath: tokenFile.path,
          valueMismatches,
        },
      );
    }

    return passedCheck(
      "design-tokens",
      "DesignTokenVerifier",
      `${cssTokens.size} controlled CSS design token(s) match SiteSpec designSystem.`,
      false,
    );
  }

  private async readDesignTokenFile() {
    const candidatePaths = [
      "app/globals.css",
      "styles/globals.css",
      "styles/tokens.css",
      "styles/nocode-tokens.css",
    ];

    for (const path of candidatePaths) {
      try {
        const content = await this.ports.readFile?.(path);

        if (content?.includes("nocode-builder-design-tokens:start")) {
          return { content, path };
        }
      } catch {
        // Try the next conventional token file path.
      }
    }

    return null;
  }

  private async tryReadPackageJson() {
    try {
      return await this.readPackageJson();
    } catch {
      return null;
    }
  }

  private async detectPackageManager(packageJson: PackageJson | null): Promise<PackageManager> {
    if (packageJson?.packageManager?.startsWith("pnpm@")) {
      return "pnpm";
    }

    if (packageJson?.packageManager?.startsWith("npm@")) {
      return "npm";
    }

    if (await this.canReadFile("pnpm-lock.yaml")) {
      return "pnpm";
    }

    return "npm";
  }

  private async canReadFile(path: string) {
    if (!this.ports.readFile) {
      return false;
    }

    try {
      await this.ports.readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  private async recordCommandArtifact(
    runId: string,
    label: string,
    result: VerifierCommandResult,
  ) {
    const relativePath = `verifier/${label}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.log`;
    const content = [
      `$ ${result.command}`,
      `exitCode=${result.exitCode ?? "unknown"}`,
      "",
      result.output,
    ].join("\n");

    if (this.ports.recordArtifact) {
      return this.ports.recordArtifact({
        content,
        mediaType: "text/plain",
        relativePath,
        runId,
        title: `${label} log`,
      });
    }

    return `artifact:${runId}:${relativePath}`;
  }

  private async collectPreviewDiagnostics(input: VerificationInput, url: string): Promise<{
    diagnostics: PreviewDiagnostic[];
    sessionId: string | null;
  }> {
    const initialDiagnostics = input.previewDiagnostics ?? [];

    if (!this.ports.waitForPreviewDiagnostics) {
      return {
        diagnostics: initialDiagnostics,
        sessionId: initialDiagnostics.find((diagnostic) => diagnostic.sessionId)?.sessionId ?? null,
      };
    }

    const sessionId = createId("preview-session");
    const startedAt = new Date().toISOString();
    const settledDiagnostics = await this.ports.waitForPreviewDiagnostics({
      runId: input.run.id,
      sessionId,
      startedAt,
      url,
      windowMs: DEFAULT_PREVIEW_DIAGNOSTIC_WINDOW_MS,
    });

    return {
      diagnostics: mergePreviewDiagnostics(initialDiagnostics, settledDiagnostics).filter(
        (diagnostic) =>
          diagnostic.runId === input.run.id &&
          diagnostic.sessionId === sessionId &&
          diagnostic.timestamp >= startedAt &&
          (!diagnostic.url || diagnostic.url === url),
      ),
      sessionId,
    };
  }

  private diffPackageDependencies(
    input: VerificationInput,
    currentPackageJson: PackageJson,
  ): DependencyChange[] {
    if (input.baselinePackageJson === undefined || input.baselinePackageJson === null) {
      return [];
    }

    const baselinePackageJson = JSON.parse(input.baselinePackageJson) as PackageJson;
    return diffDependencySections(baselinePackageJson, currentPackageJson);
  }

  private describeCommandFailure(
    checkId: BaselineCommandCheckId,
    result: VerifierCommandResult,
    summary: string,
    diagnostics: string[],
    input: VerificationInput,
  ): CommandFailureDetail {
    const baseline = input.baselineCommandResults?.[checkId];
    const baselineStatus =
      baseline === undefined
        ? "missing"
        : baseline === null
          ? "not_run"
          : baseline.success
            ? "passed"
            : "failed";

    const classification: CommandFailureClassification =
      baselineStatus === "passed"
        ? "newly_introduced"
        : baselineStatus === "failed"
          ? "pre_existing"
          : "unknown_baseline";
    const relatedToChangedFiles = diagnosticsOverlapChangedFiles(
      diagnostics,
      input,
    );

    return {
      baselineStatus,
      checkId,
      classification,
      command: result.command,
      diagnostics,
      exitCode: result.exitCode,
      relatedToChangedFiles,
      summary,
    };
  }

  private async recordPreviewArtifact(
    runId: string,
    evidence: {
      diagnostics: PreviewDiagnostic[];
      probe?: { ok: boolean; status: number; summary: string };
      required: boolean;
      sessionId?: string | null;
      summary: string;
      url: string | null;
    },
  ) {
    const relativePath = `verifier/preview-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.json`;
    const content = JSON.stringify(
      {
        ...evidence,
        createdAt: new Date().toISOString(),
        errorDiagnosticCount: evidence.diagnostics.filter(
          (diagnostic) => diagnostic.level === "error",
        ).length,
      },
      null,
      2,
    );

    if (this.ports.recordArtifact) {
      return this.ports.recordArtifact({
        content,
        mediaType: "application/json",
        relativePath,
        runId,
        title: "preview evidence",
      });
    }

    return `artifact:${runId}:${relativePath}`;
  }
}

type PackageManager = "npm" | "pnpm";

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function verifyScope(
  contract: TaskContract,
  changedFiles: string[],
  options: {
    approvedDeletionPaths?: string[];
    deletedFiles?: string[];
  } = {},
): VerificationCheck {
  const normalizedChangedFiles = changedFiles.map(normalizeProjectPath);
  const normalizedDeletedFiles = (options.deletedFiles ?? []).map(normalizeProjectPath);
  const approvedDeletionPaths = new Set(
    (options.approvedDeletionPaths ?? []).map(normalizeProjectPath),
  );
  const invalidPath = normalizedChangedFiles.find(isInvalidProjectPath);

  if (invalidPath) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed file ${invalidPath} is not a valid project-relative path.`,
      true,
    );
  }

  const forbidden = normalizedChangedFiles.find((path) =>
    isPathForbidden(path, contract.scope.forbiddenPaths),
  );

  if (forbidden) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed file ${forbidden} is forbidden by task scope.`,
      true,
    );
  }

  if (
    normalizedChangedFiles.some(
      (path) =>
        path === ".aibuilder" ||
        path.startsWith(".aibuilder/") ||
        path.startsWith(".env") ||
        path.includes("/.env"),
    )
  ) {
    return failedCheck("scope", "ScopeVerifier", "Changed files include .env content.", true);
  }

  if (normalizedChangedFiles.length > contract.budget.maxMutations) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed ${normalizedChangedFiles.length} file(s), exceeding mutation budget ${contract.budget.maxMutations}.`,
      true,
    );
  }

  const unapprovedDeletion = normalizedDeletedFiles.find(
    (path) => !approvedDeletionPaths.has(path),
  );

  if (unapprovedDeletion && contract.permissions.fileDelete === "deny") {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Deleted file ${unapprovedDeletion} is denied by the task contract.`,
      true,
    );
  }

  if (unapprovedDeletion && contract.permissions.fileDelete === "ask") {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Deleted file ${unapprovedDeletion} requires approval evidence.`,
      true,
      {
        approvedDeletionPaths: [...approvedDeletionPaths],
        deletedFiles: normalizedDeletedFiles,
      },
    );
  }

  return passedCheck("scope", "ScopeVerifier", "Changed files passed safety scope checks.", true);
}

function verifyAnswerTask(input: VerificationInput): VerificationCheck {
  const sideEffects = [
    input.changedFiles.length > 0 ? `changedFiles=${input.changedFiles.length}` : null,
    (input.deletedFiles?.length ?? 0) > 0 ? `deletedFiles=${input.deletedFiles?.length}` : null,
    input.packageChanged ? "packageChanged=true" : null,
    input.run.mutationCount > 0 ? `mutationCount=${input.run.mutationCount}` : null,
  ].filter(Boolean);

  if (sideEffects.length > 0) {
    return failedCheck(
      "answer",
      "AnswerVerifier",
      `Read-only answer task produced side effects: ${sideEffects.join(", ")}.`,
      true,
    );
  }

  if (!input.answerMessage?.trim()) {
    return unavailableEvidenceCheck(
      "answer",
      "AnswerVerifier",
      "Answer task did not produce a non-empty answer message.",
      true,
    );
  }

  return passedCheck(
    "answer",
    "AnswerVerifier",
    "Answer task produced a non-empty answer without workspace side effects.",
    true,
  );
}

function buildVerificationReport(
  runId: string,
  checks: VerificationCheck[],
): VerificationReport {
  const status = summarizeStatus(checks);
  const failedChecks = checks.filter(
    (check) => check.status === "failed" && check.severity !== "warning",
  );
  const inconclusiveChecks = checks.filter(
    (check) =>
      check.severity !== "warning" &&
      (
        check.status === "inconclusive" ||
        (check.required === true && check.status === "skipped")
      ),
  );

  return {
    id: createId("verification"),
    runId,
    status,
    checks,
    newlyIntroducedFailures: collectNewlyIntroducedFailures(failedChecks),
    missingEvidence: inconclusiveChecks.map((check) => check.summary),
    artifactIds: checks.flatMap((check) => check.artifactIds ?? []),
    repairFeedback: failedChecks.map(buildRepairFeedbackForCheck),
    createdAt: new Date().toISOString(),
  };
}

function verifyAcceptanceCriteria(
  contract: TaskContract,
  input: VerificationInput,
  technicalChecks: VerificationCheck[],
  siteSpec: SiteSpec | null,
): VerificationCheck[] {
  return contract.acceptanceCriteria.map((criterion) => {
    if (criterion.id === "verifier-passed") {
      const technicalStatus = summarizeStatus(technicalChecks);

      return technicalStatus === "passed"
        ? passedCheck(
            `acceptance:${criterion.id}`,
            `Acceptance: ${criterion.id}`,
            "Required technical verification checks passed.",
            criterion.required,
          )
        : unavailableEvidenceCheck(
            `acceptance:${criterion.id}`,
            `Acceptance: ${criterion.id}`,
            `Technical verification is ${technicalStatus}.`,
            criterion.required,
          );
    }

    if (criterion.id === "request-addressed") {
      const technicalPassed = summarizeStatus(technicalChecks) === "passed";
      const evidence = collectRequestAddressedEvidence(
        contract,
        input,
        siteSpec,
        technicalPassed,
      );
      const missingEvidence =
        describeMissingRequestAddressedEvidence(contract, input, technicalPassed) ??
        "No non-model evidence shows that the request was addressed.";

      return evidence
        ? passedCheck(
            `acceptance:${criterion.id}`,
            `Acceptance: ${criterion.id}`,
            evidence,
            criterion.required,
          )
        : unavailableEvidenceCheck(
            `acceptance:${criterion.id}`,
            `Acceptance: ${criterion.id}`,
            missingEvidence,
            criterion.required,
          );
    }

    return unavailableEvidenceCheck(
      `acceptance:${criterion.id}`,
      `Acceptance: ${criterion.id}`,
      `No verifier mapping is implemented for acceptance criterion "${criterion.id}".`,
      criterion.required,
    );
  });
}

function collectRequestAddressedEvidence(
  contract: TaskContract,
  input: VerificationInput,
  siteSpec: SiteSpec | null,
  allowExistingWorkspaceEvidence: boolean,
) {
  const changedFiles = input.changedFiles.map(normalizeProjectPath);
  const expectedFiles = getExpectedFiles(contract);
  if (expectedFiles.length > 0) {
    const evidencePaths = collectTaskEvidencePaths(contract, input);
    const missingExpectedFiles = findMissingExpectedFiles(expectedFiles, evidencePaths);

    if (missingExpectedFiles.length > 0) {
      return null;
    }
  }

  if (contract.taskType === "answer" && input.answerMessage?.trim()) {
    return "AnswerVerifier produced a non-empty answer for the read-only task.";
  }

  if (input.noOpReason?.trim()) {
    return `No-op conclusion supplied: ${input.noOpReason.trim()}`;
  }

  const externalEffects = (input.externalEffects ?? [])
    .map((effect) => effect.trim())
    .filter(Boolean);
  if (externalEffects.length > 0) {
    return `External tool evidence: ${externalEffects.slice(-3).join(" ")}`;
  }

  if (changedFiles.length === 0) {
    return allowExistingWorkspaceEvidence
      ? collectExistingWorkspaceEvidence(contract, input.readSnapshots ?? [], siteSpec)
      : null;
  }

  const scopeEvidence = changedFiles.some((path) =>
    contract.scope.allowedPaths.some((pattern) =>
      matchesProjectPathPattern(path, pattern),
    ),
  );

  if (!scopeEvidence) {
    return null;
  }

  const componentIds = contract.scope.componentIds ?? [];
  if (componentIds.length > 0) {
    const componentSourcePaths = siteSpec
      ? collectComponentSourcePaths(siteSpec, componentIds)
      : new Set<string>();
    const matchingChangedFile = changedFiles.find((path) => componentSourcePaths.has(path));

    return matchingChangedFile
      ? `Changed ${matchingChangedFile} for scoped component(s): ${componentIds.join(", ")}.`
      : null;
  }

  const pages = contract.scope.pages ?? [];
  if (pages.length > 0) {
    const pageSourcePaths = siteSpec
      ? collectPageSourcePaths(siteSpec, pages)
      : new Set<string>();
    const matchingChangedFile = changedFiles.find((path) => pageSourcePaths.has(path));

    return matchingChangedFile
      ? `Changed ${matchingChangedFile} for scoped page(s): ${pages.join(", ")}.`
      : null;
  }

  return `Changed ${changedFiles.length} task-scoped file(s).`;
}

function describeMissingRequestAddressedEvidence(
  contract: TaskContract,
  input: VerificationInput,
  technicalPassed: boolean,
) {
  const expectedFiles = getExpectedFiles(contract);

  if (expectedFiles.length === 0) {
    return null;
  }

  if (!technicalPassed) {
    return null;
  }

  const missingExpectedFiles = findMissingExpectedFiles(
    expectedFiles,
    collectTaskEvidencePaths(contract, input),
  );

  return missingExpectedFiles.length > 0
    ? `Expected file evidence is missing for: ${missingExpectedFiles.slice(0, 8).join(", ")}.`
    : null;
}

function getExpectedFiles(contract: TaskContract) {
  return contract.source?.mode === "spec"
    ? (contract.source.expectedFiles ?? []).map(normalizeProjectPath)
    : [];
}

function collectTaskEvidencePaths(
  contract: TaskContract,
  input: VerificationInput,
) {
  return uniqueStrings([
    ...input.changedFiles.map(normalizeProjectPath),
    ...(input.readSnapshots ?? []).map((snapshot) => normalizeProjectPath(snapshot.path)),
  ]).filter((path) =>
    path &&
    !isInvalidProjectPath(path) &&
    contract.scope.allowedPaths.some((pattern) =>
      matchesProjectPathPattern(path, pattern),
    ) &&
    !isPathForbidden(path, contract.scope.forbiddenPaths),
  );
}

function findMissingExpectedFiles(expectedFiles: string[], evidencePaths: string[]) {
  return expectedFiles.filter(
    (expected) =>
      !evidencePaths.some((path) =>
        path === expected || matchesProjectPathPattern(path, expected),
      ),
  );
}

function collectExistingWorkspaceEvidence(
  contract: TaskContract,
  readSnapshots: AgentReadSnapshot[],
  siteSpec: SiteSpec | null,
) {
  const readPaths = uniqueStrings(
    readSnapshots
      .map((snapshot) => normalizeProjectPath(snapshot.path))
      .filter((path) => path && !isInvalidProjectPath(path))
      .filter((path) =>
        contract.scope.allowedPaths.some((pattern) =>
          matchesProjectPathPattern(path, pattern),
        ),
      )
      .filter((path) =>
        !isPathForbidden(path, contract.scope.forbiddenPaths),
      ),
  );

  if (readPaths.length === 0) {
    return null;
  }

  const expectedFiles =
    contract.source?.mode === "spec"
      ? (contract.source.expectedFiles ?? []).map(normalizeProjectPath)
      : [];
  if (expectedFiles.length > 0) {
    const matchingExpectedFiles = readPaths.filter((path) =>
      expectedFiles.some((expected) =>
        expected === path || matchesProjectPathPattern(path, expected),
      ),
    );

    return matchingExpectedFiles.length > 0
      ? `Existing workspace evidence inspected expected file(s): ${matchingExpectedFiles.slice(-6).join(", ")}.`
      : null;
  }

  const componentIds = contract.scope.componentIds ?? [];
  if (componentIds.length > 0 && siteSpec) {
    const componentSourcePaths = collectComponentSourcePaths(siteSpec, componentIds);
    const matchingReadFile = readPaths.find((path) => componentSourcePaths.has(path));

    return matchingReadFile
      ? `Existing workspace evidence inspected ${matchingReadFile} for scoped component(s): ${componentIds.join(", ")}.`
      : null;
  }

  const pages = contract.scope.pages ?? [];
  if (pages.length > 0 && siteSpec) {
    const pageSourcePaths = collectPageSourcePaths(siteSpec, pages);
    const matchingReadFile = readPaths.find((path) => pageSourcePaths.has(path));

    return matchingReadFile
      ? `Existing workspace evidence inspected ${matchingReadFile} for scoped page(s): ${pages.join(", ")}.`
      : null;
  }

  return null;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function collectComponentSourcePaths(siteSpec: SiteSpec, componentIds: string[]) {
  const componentIdSet = new Set(componentIds);
  const paths = new Set<string>();

  for (const component of siteSpec.reusableComponents) {
    if (componentIdSet.has(component.id) && component.source?.path) {
      paths.add(normalizeProjectPath(component.source.path));
    }
  }

  for (const page of siteSpec.pages) {
    for (const node of flattenSiteNodes(page.nodes)) {
      if (componentIdSet.has(node.id) && node.source?.path) {
        paths.add(normalizeProjectPath(node.source.path));
      }
    }
  }

  return paths;
}

function collectPageSourcePaths(siteSpec: SiteSpec, pages: string[]) {
  const pageSet = new Set(pages);
  const paths = new Set<string>();

  for (const page of siteSpec.pages) {
    if (!pageSet.has(page.id) && !pageSet.has(page.route) && !pageSet.has(page.title)) {
      continue;
    }

    for (const node of flattenSiteNodes(page.nodes)) {
      if (node.source?.path) {
        paths.add(normalizeProjectPath(node.source.path));
      }
    }
  }

  return paths;
}

function flattenSiteNodes(nodes: SiteSpec["pages"][number]["nodes"]): SiteSpec["pages"][number]["nodes"] {
  return nodes.flatMap((node) => [
    node,
    ...flattenSiteNodes(node.children ?? []),
  ]);
}

function parseControlledCssTokens(content: string) {
  const tokens = new Map<string, string>();
  const blockMatch = content.match(
    /\/\* nocode-builder-design-tokens:start \*\/([\s\S]*?)\/\* nocode-builder-design-tokens:end \*\//,
  );

  if (!blockMatch) {
    return tokens;
  }

  const declarationPattern = /--ncb-([a-z0-9_-]+-[a-z0-9_-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null = null;

  while ((match = declarationPattern.exec(blockMatch[1] ?? "")) !== null) {
    tokens.set(match[1].toLowerCase(), normalizeCssTokenValue(match[2]));
  }

  return tokens;
}

function flattenSiteDesignTokens(siteSpec: SiteSpec) {
  const tokens = new Map<string, string>();
  const groups = {
    colors: siteSpec.designSystem.colors,
    radii: siteSpec.designSystem.radii,
    spacing: siteSpec.designSystem.spacing,
    typography: siteSpec.designSystem.typography,
  };

  for (const [group, values] of Object.entries(groups)) {
    for (const [key, value] of Object.entries(values)) {
      tokens.set(
        `${toCssTokenName(group)}-${toCssTokenName(key)}`,
        normalizeCssTokenValue(value),
      );
    }
  }

  return tokens;
}

function normalizeCssTokenValue(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function toCssTokenName(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function summarizeStatus(checks: VerificationCheck[]): VerificationStatus {
  if (checks.some((check) => check.status === "failed" && check.severity !== "warning")) {
    return "failed";
  }

  const requiredMissingEvidence = checks.filter(
    (check) =>
      check.severity !== "warning" &&
      check.required === true &&
      (check.status === "inconclusive" || check.status === "skipped"),
  );

  if (requiredMissingEvidence.length > 0) {
    return "inconclusive";
  }

  return "passed";
}

function collectNewlyIntroducedFailures(failedChecks: VerificationCheck[]) {
  return failedChecks.flatMap((check) =>
    extractCommandFailures(check.details)
      .filter((failure) => failure.classification === "newly_introduced")
      .map(
        (failure) =>
          `${failure.checkId}: ${failure.summary} (baseline ${failure.baselineStatus})`,
      ),
  );
}

function commandFailureCheck(
  id: string,
  title: string,
  summary: string,
  required: boolean,
  details: unknown,
  artifactIds: string[],
  commandFailures: CommandFailureDetail[],
): VerificationCheck {
  const blockingFailures = commandFailures.filter(isBlockingCommandFailure);

  if (blockingFailures.length > 0) {
    const classification = blockingFailures.some(
      (failure) => failure.classification === "newly_introduced",
    )
      ? "newly_introduced"
      : blockingFailures.some((failure) => failure.classification === "unknown_baseline")
        ? "unknown_baseline"
        : "pre_existing";

    return failedCheck(
      id,
      title,
      summary,
      required,
      details,
      artifactIds,
      {
        classification,
        relatedToChangedFiles: blockingFailures.some((failure) => failure.relatedToChangedFiles),
        severity: "blocking",
      },
    );
  }

  return {
    id,
    title,
    status: "inconclusive",
    summary: `${summary} This appears to be a pre-existing unrelated failure.`,
    required,
    artifactIds,
    details,
    severity: "warning",
    classification: "pre_existing",
    relatedToChangedFiles: false,
  };
}

function isBlockingCommandFailure(failure: CommandFailureDetail) {
  return (
    failure.classification === "newly_introduced" ||
    failure.classification === "unknown_baseline" ||
    failure.relatedToChangedFiles
  );
}

function buildRepairFeedbackForCheck(check: VerificationCheck) {
  const diagnostics = extractCheckDiagnostics(check.details).slice(0, 10);

  if (diagnostics.length === 0) {
    return `${check.title}: ${check.summary}`;
  }

  return [
    `${check.title}: ${check.summary}`,
    "Diagnostics:",
    ...diagnostics.map((diagnostic) => `- ${compactDiagnostic(diagnostic, 320)}`),
  ].join("\n");
}

function extractCheckDiagnostics(details: unknown) {
  if (!isRecord(details)) {
    return [];
  }

  const diagnostics: string[] = [];

  for (const failure of extractCommandFailures(details)) {
    diagnostics.push(...failure.diagnostics);
  }

  const detailDiagnostics = details.diagnostics;
  if (Array.isArray(detailDiagnostics)) {
    for (const diagnostic of detailDiagnostics) {
      if (typeof diagnostic === "string") {
        diagnostics.push(diagnostic);
        continue;
      }

      if (isRecord(diagnostic)) {
        const summary = readDiagnosticRecordSummary(diagnostic);
        if (summary) {
          diagnostics.push(summary);
        }
      }
    }
  }

  return uniqueStrings(diagnostics.map((diagnostic) => diagnostic.trim()).filter(Boolean));
}

function readDiagnosticRecordSummary(record: Record<string, unknown>) {
  const parts = ["kind", "message", "text", "summary"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return parts.join(": ");
}

function compactDiagnostic(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, " ").trim();

  return compacted.length <= maxLength
    ? compacted
    : `${compacted.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractCommandFailures(details: unknown): CommandFailureDetail[] {
  if (!details || typeof details !== "object" || !("commandFailures" in details)) {
    return [];
  }

  const commandFailures = (details as { commandFailures?: unknown }).commandFailures;
  if (!Array.isArray(commandFailures)) {
    return [];
  }

  return commandFailures.filter(isCommandFailureDetail);
}

function isCommandFailureDetail(value: unknown): value is CommandFailureDetail {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<Record<keyof CommandFailureDetail, unknown>>;
  return (
    typeof record.summary === "string" &&
    typeof record.command === "string" &&
    typeof record.checkId === "string" &&
    typeof record.classification === "string"
  );
}

function mergePreviewDiagnostics(
  ...diagnosticSets: PreviewDiagnostic[][]
): PreviewDiagnostic[] {
  const diagnosticsById = new Map<string, PreviewDiagnostic>();

  for (const diagnostics of diagnosticSets) {
    for (const diagnostic of diagnostics) {
      diagnosticsById.set(diagnostic.id, diagnostic);
    }
  }

  return [...diagnosticsById.values()];
}

function diffDependencySections(
  baselinePackageJson: PackageJson,
  currentPackageJson: PackageJson,
): DependencyChange[] {
  return (["dependencies", "devDependencies"] as const).flatMap((section) =>
    diffDependencies(
      section,
      normalizeDependencyRecord(baselinePackageJson[section]),
      normalizeDependencyRecord(currentPackageJson[section]),
    ),
  );
}

function diffDependencies(
  section: DependencyChange["section"],
  baselineDependencies: Record<string, string>,
  currentDependencies: Record<string, string>,
): DependencyChange[] {
  const dependencyNames = new Set([
    ...Object.keys(baselineDependencies),
    ...Object.keys(currentDependencies),
  ]);
  const changes: DependencyChange[] = [];

  for (const name of [...dependencyNames].sort()) {
    const before = baselineDependencies[name] ?? null;
    const after = currentDependencies[name] ?? null;

    if (before === after) {
      continue;
    }

    const changeType: DependencyChange["changeType"] =
      before === null ? "add" : after === null ? "remove" : "update";
    changes.push({
      after,
      before,
      changeType,
      key: `${section}:${changeType}:${name}`,
      name,
      section,
    });
  }

  return changes;
}

function normalizeDependencyRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function validateDependencyApprovals(
  contract: TaskContract,
  dependencyChanges: DependencyChange[],
  _approvedPackageChangeKeys: string[],
): { summary: string; unapprovedPackageChangeKeys: string[] } | null {
  if (dependencyChanges.length === 0) {
    return null;
  }

  if (contract.permissions.dependencyChange === "deny") {
    return {
      summary: `package.json changed ${dependencyChanges.length} dependency item(s), but dependency changes are denied by the task contract.`,
      unapprovedPackageChangeKeys: dependencyChanges.map((change) => change.key),
    };
  }

  return null;
}

function passedCheck(
  id: string,
  title: string,
  summary: string,
  required = false,
  artifactIds?: string[],
): VerificationCheck {
  return {
    id,
    required,
    title,
    status: "passed",
    summary,
    artifactIds,
  };
}

function failedCheck(
  id: string,
  title: string,
  summary: string,
  required = false,
  details?: unknown,
  artifactIds?: string[],
  metadata: Pick<
    VerificationCheck,
    "classification" | "relatedToChangedFiles" | "severity"
  > = {},
): VerificationCheck {
  return {
    id,
    required,
    title,
    status: "failed",
    summary,
    details,
    artifactIds,
    ...metadata,
  };
}

function skippedCheck(
  id: string,
  title: string,
  summary: string,
  required = false,
  artifactIds?: string[],
): VerificationCheck {
  return {
    id,
    required,
    title,
    status: "skipped",
    summary,
    artifactIds,
  };
}

function unavailableEvidenceCheck(
  id: string,
  title: string,
  summary: string,
  required: boolean,
  artifactIds?: string[],
): VerificationCheck {
  return required
    ? {
        id,
        required,
        artifactIds,
        status: "inconclusive",
        summary,
        title,
      }
    : skippedCheck(id, title, summary, required, artifactIds);
}

function isPreviewRequired(contract: TaskContract) {
  return ["full_site", "add_page"].includes(contract.taskType);
}

function extractDiagnostics(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trimEnd());
  const diagnostics: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!isDiagnosticAnchor(line)) {
      continue;
    }

    const previousIndex = findPreviousNonEmptyLineIndex(lines, index);
    const startIndex =
      /type error/i.test(line) &&
      previousIndex !== null &&
      isDiagnosticLocation(lines[previousIndex] ?? "")
        ? previousIndex
        : index;

    for (
      let windowIndex = startIndex;
      windowIndex < Math.min(lines.length, startIndex + 10);
      windowIndex += 1
    ) {
      const diagnosticLine = lines[windowIndex]?.trim();

      if (!diagnosticLine) {
        if (windowIndex > index) {
          break;
        }
        continue;
      }

      diagnostics.push(diagnosticLine);
    }
  }

  return uniqueStrings(diagnostics).slice(-40);
}

export function extractDiagnosticPaths(outputOrDiagnostics: string | string[]) {
  const lines = Array.isArray(outputOrDiagnostics)
    ? outputOrDiagnostics
    : outputOrDiagnostics.split(/\r?\n/);
  const paths = new Set<string>();
  const pathPattern =
    /(?:^|\s)(?:\.\/)?([A-Za-z]:[\\/])?([A-Za-z0-9_./@\\-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?|\(\d+,\d+\))/g;

  for (const line of lines) {
    let match: RegExpExecArray | null = null;

    while ((match = pathPattern.exec(line)) !== null) {
      const rawPath = `${match[1] ?? ""}${match[2] ?? ""}`
        .replace(/\\/g, "/")
        .replace(/^[A-Za-z]:\//, "")
        .replace(/^\.\//, "");
      const projectPath = rawPath.replace(/^.*?(?=(app|components|lib|data|public|styles|pages|src|middleware|package\.json|tsconfig\.json|next\.config))/i, "");

      if (projectPath && !isInvalidProjectPath(projectPath)) {
        paths.add(normalizeProjectPath(projectPath));
      }
    }
  }

  return [...paths];
}

export function diagnosticsOverlapChangedFiles(
  diagnostics: string[],
  input: Pick<VerificationInput, "changedFiles" | "deletedFiles" | "run">,
) {
  const diagnosticPaths = extractDiagnosticPaths(diagnostics);

  if (diagnosticPaths.length === 0) {
    return false;
  }

  const relevantPaths = uniqueStrings([
    ...input.changedFiles,
    ...(input.deletedFiles ?? []),
    ...(input.run.contract.source?.expectedFiles ?? []),
  ].map(normalizeProjectPath));

  return diagnosticPaths.some((diagnosticPath) =>
    relevantPaths.some(
      (path) =>
        diagnosticPath === path ||
        path === diagnosticPath ||
        matchesProjectPathPattern(diagnosticPath, path) ||
        matchesProjectPathPattern(path, diagnosticPath),
    ),
  );
}

function isDiagnosticAnchor(line: string) {
  return (
    isDiagnosticLocation(line) ||
    /\b(error|failed|failure|exception|type error)\b/i.test(line)
  );
}

function isDiagnosticLocation(line: string) {
  return /(?:^|\s)(?:\.\/)?[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+:\d+:\d+\b/.test(line);
}

function findPreviousNonEmptyLineIndex(lines: string[], index: number) {
  for (let current = index - 1; current >= 0; current -= 1) {
    if ((lines[current] ?? "").trim().length > 0) {
      return current;
    }
  }

  return null;
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
