import type {
  AgentRun,
  PreviewDiagnostic,
  TaskContract,
  VerificationCheck,
  VerificationReport,
  VerificationStatus,
} from "../types";

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
  noOpReason?: string;
  packageChanged: boolean;
  approvedPackageChangeKeys?: string[];
  approvedDeletionPaths?: string[];
  previewDiagnostics?: PreviewDiagnostic[];
  previewUrl?: string | null;
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
    checks.push(await this.verifyPackage(input));
    checks.push(await this.verifyStatic(input));
    checks.push(await this.verifyBuild(input));
    checks.push(await this.verifyPreview(input));
    checks.push(...verifyAcceptanceCriteria(input.run.contract, input, checks));

    const status = summarizeStatus(checks);
    const failedChecks = checks.filter((check) => check.status === "failed");
    const inconclusiveChecks = checks.filter(
      (check) =>
        check.status === "inconclusive" ||
        (check.required === true && check.status === "skipped"),
    );

    return {
      id: createId("verification"),
      runId: input.run.id,
      status,
      checks,
      newlyIntroducedFailures: collectNewlyIntroducedFailures(failedChecks),
      missingEvidence: inconclusiveChecks.map((check) => check.summary),
      artifactIds: checks.flatMap((check) => check.artifactIds ?? []),
      repairFeedback: failedChecks.map((check) => `${check.title}: ${check.summary}`),
      createdAt: new Date().toISOString(),
    };
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
          ? `package.json is valid. Package manager: ${packageManager}. ${dependencyChanges.length} dependency change(s) approved.`
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
      return failedCheck(
        "static",
        "StaticVerifier",
        diagnostics[0] ?? "Static verification failed.",
        false,
        {
          commandFailures,
          diagnostics: diagnostics.slice(1),
        },
        artifactIds,
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
        return failedCheck(
          "build",
          "BuildVerifier",
          summary,
          true,
          {
            commandFailures: installResult
              ? [
                  this.describeCommandFailure(
                    "install",
                    installResult,
                    summary,
                    diagnostics,
                    input,
                  ),
                ]
              : [],
            diagnostics,
          },
          artifactIds,
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

    return failedCheck(
      "build",
      "BuildVerifier",
      `${buildCommand} failed with exit code ${buildResult.exitCode ?? "unknown"}.`,
      true,
      {
        commandFailures: [
          this.describeCommandFailure(
            "build",
            buildResult,
            `${buildCommand} failed with exit code ${buildResult.exitCode ?? "unknown"}.`,
            extractDiagnostics(buildResult.output),
            input,
          ),
        ],
        diagnostics: extractDiagnostics(buildResult.output),
      },
      artifactIds,
    );
  }

  private async verifyPreview(input: VerificationInput): Promise<VerificationCheck> {
    const previewUrl = input.previewUrl ?? null;
    const required = isPreviewRequired(input.run.contract);
    const initialDiagnostics = input.previewDiagnostics ?? [];

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

    return {
      baselineStatus,
      checkId,
      classification,
      command: result.command,
      diagnostics,
      exitCode: result.exitCode,
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
  const invalidPath = normalizedChangedFiles.find(
    (path) =>
      path.startsWith("/") ||
      path.startsWith("../") ||
      path.includes("/../") ||
      /^[A-Za-z]:\//.test(path),
  );

  if (invalidPath) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed file ${invalidPath} is not a valid project-relative path.`,
      true,
    );
  }

  const forbidden = normalizedChangedFiles.find((path) =>
    contract.scope.forbiddenPaths.some((pattern) => matchesPattern(path, pattern)),
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

  const outsideAllowed = normalizedChangedFiles.find(
    (path) => !contract.scope.allowedPaths.some((pattern) => matchesPattern(path, pattern)),
  );

  if (outsideAllowed) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed file ${outsideAllowed} is outside allowed task scope.`,
      true,
    );
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

  return passedCheck("scope", "ScopeVerifier", "Changed files stayed within scope.", true);
}

function verifyAcceptanceCriteria(
  contract: TaskContract,
  input: VerificationInput,
  technicalChecks: VerificationCheck[],
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
      const evidence = collectRequestAddressedEvidence(contract, input);

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
            "No non-model evidence shows that the request was addressed.",
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
) {
  const changedFiles = input.changedFiles.map(normalizeProjectPath);

  if (contract.taskType === "answer" && input.answerMessage?.trim()) {
    return "AnswerVerifier produced a non-empty answer for the read-only task.";
  }

  if (input.noOpReason?.trim()) {
    return `No-op conclusion supplied: ${input.noOpReason.trim()}`;
  }

  if (changedFiles.length === 0) {
    return null;
  }

  const scopeEvidence = changedFiles.some((path) =>
    contract.scope.allowedPaths.some((pattern) => matchesPattern(path, pattern)),
  );

  if (!scopeEvidence) {
    return null;
  }

  if (contract.scope.componentIds?.length) {
    return `Changed ${changedFiles.length} file(s) while scoped to component(s): ${contract.scope.componentIds.join(", ")}.`;
  }

  if (contract.scope.pages?.length) {
    return `Changed ${changedFiles.length} file(s) while scoped to page(s): ${contract.scope.pages.join(", ")}.`;
  }

  return `Changed ${changedFiles.length} task-scoped file(s).`;
}

function summarizeStatus(checks: VerificationCheck[]): VerificationStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  const requiredMissingEvidence = checks.filter(
    (check) =>
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
  approvedPackageChangeKeys: string[],
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

  if (contract.permissions.dependencyChange === "allow") {
    return null;
  }

  const approved = new Set(approvedPackageChangeKeys);
  if (approved.has("*")) {
    return null;
  }
  const unapprovedPackageChangeKeys = dependencyChanges
    .map((change) => change.key)
    .filter((key) => !approved.has(key));

  if (unapprovedPackageChangeKeys.length === 0) {
    return null;
  }

  return {
    summary: `Dependency changes require approval: ${unapprovedPackageChangeKeys.join(", ")}.`,
    unapprovedPackageChangeKeys,
  };
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
): VerificationCheck {
  return {
    id,
    required,
    title,
    status: "failed",
    summary,
    details,
    artifactIds,
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
  return ["full_site", "add_page", "component_edit", "style_edit", "copy_edit"].includes(
    contract.taskType,
  );
}

function matchesPattern(path: string, pattern: string) {
  const normalizedPattern = normalizeProjectPath(pattern);

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.endsWith(".*")) {
    const prefix = normalizedPattern.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}.`);
  }

  return path === normalizedPattern || path.startsWith(`${normalizedPattern}/`);
}

function normalizeProjectPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function extractDiagnostics(output: string) {
  return output
    .split(/\r?\n/)
    .filter((line) => /error|failed|exception|type/i.test(line))
    .slice(-20);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
