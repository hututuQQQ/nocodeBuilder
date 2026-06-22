import type {
  AgentRun,
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

export type VerifierPorts = {
  readFile?: (path: string) => Promise<string>;
  runCommand?: (command: string) => Promise<VerifierCommandResult | null>;
  startPreview?: () => Promise<string | null>;
  stopPreview?: () => Promise<void>;
  httpProbe?: (url: string) => Promise<{ ok: boolean; status: number; summary: string }>;
};

export type VerificationInput = {
  changedFiles: string[];
  packageChanged: boolean;
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

    checks.push(verifyScope(input.run.contract, input.changedFiles));
    checks.push(await this.verifyPackage(input));
    checks.push(await this.verifyStatic(input));
    checks.push(await this.verifyBuild(input));
    checks.push(await this.verifyPreview(input));

    const status = summarizeStatus(checks, input.run.contract);
    const failedChecks = checks.filter((check) => check.status === "failed");
    const inconclusiveChecks = checks.filter((check) => check.status === "inconclusive");

    return {
      id: createId("verification"),
      runId: input.run.id,
      status,
      checks,
      newlyIntroducedFailures: failedChecks.map((check) => check.summary),
      missingEvidence: inconclusiveChecks.map((check) => check.summary),
      artifactIds: checks.flatMap((check) => check.artifactIds ?? []),
      repairFeedback: failedChecks.map((check) => `${check.title}: ${check.summary}`),
      createdAt: new Date().toISOString(),
    };
  }

  private async verifyPackage(_input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.readFile) {
      return skippedCheck(
        "package",
        "PackageVerifier",
        "No file reader is available in this environment.",
      );
    }

    try {
      const packageJson = await this.ports.readFile("package.json");
      const parsed = JSON.parse(packageJson) as {
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const missingScripts = ["build"].filter(
        (script) => typeof parsed.scripts?.[script] !== "string",
      );

      if (missingScripts.length > 0) {
        return failedCheck(
          "package",
          "PackageVerifier",
          `package.json is missing script(s): ${missingScripts.join(", ")}.`,
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
        );
      }

      return passedCheck("package", "PackageVerifier", "package.json is valid.");
    } catch (error) {
      return failedCheck(
        "package",
        "PackageVerifier",
        `package.json could not be validated: ${getErrorMessage(error)}`,
      );
    }
  }

  private async verifyStatic(_input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.runCommand) {
      return skippedCheck(
        "static",
        "StaticVerifier",
        "No command runner is available in this environment.",
      );
    }

    const lintResult = await this.ports.runCommand("npm run lint");

    if (!lintResult) {
      return skippedCheck("static", "StaticVerifier", "lint command was not run.");
    }

    if (lintResult.success) {
      return passedCheck("static", "StaticVerifier", "npm run lint passed.");
    }

    if (/missing script:?\s*lint|script\s+\"lint\"\s+not found/i.test(lintResult.output)) {
      return skippedCheck("static", "StaticVerifier", "No lint script is defined.");
    }

    return failedCheck(
      "static",
      "StaticVerifier",
      `npm run lint failed with exit code ${lintResult.exitCode ?? "unknown"}.`,
      extractDiagnostics(lintResult.output),
    );
  }

  private async verifyBuild(input: VerificationInput): Promise<VerificationCheck> {
    if (!this.ports.runCommand) {
      return skippedCheck(
        "build",
        "BuildVerifier",
        "No command runner is available in this environment.",
      );
    }

    if (input.packageChanged) {
      const installResult = await this.ports.runCommand("npm install");

      if (!installResult?.success) {
        return failedCheck(
          "build",
          "BuildVerifier",
          `npm install failed with exit code ${installResult?.exitCode ?? "unknown"}.`,
          extractDiagnostics(installResult?.output ?? ""),
        );
      }
    }

    const buildResult = await this.ports.runCommand("npm run build");

    if (!buildResult) {
      return skippedCheck("build", "BuildVerifier", "build command was not run.");
    }

    if (buildResult.success) {
      return passedCheck("build", "BuildVerifier", "npm run build passed.");
    }

    return failedCheck(
      "build",
      "BuildVerifier",
      `npm run build failed with exit code ${buildResult.exitCode ?? "unknown"}.`,
      extractDiagnostics(buildResult.output),
    );
  }

  private async verifyPreview(input: VerificationInput): Promise<VerificationCheck> {
    const previewUrl = input.previewUrl ?? null;

    if (!previewUrl && !this.ports.startPreview) {
      return skippedCheck(
        "preview",
        "PreviewVerifier",
        "No running preview URL or preview starter is available.",
      );
    }

    const url = previewUrl ?? (await this.ports.startPreview?.()) ?? null;

    if (!url) {
      return skippedCheck("preview", "PreviewVerifier", "Preview did not produce a URL.");
    }

    if (!this.ports.httpProbe) {
      return passedCheck(
        "preview",
        "PreviewVerifier",
        `Preview URL is available at ${url}; HTTP probe unavailable.`,
      );
    }

    const probe = await this.ports.httpProbe(url);

    if (probe.ok) {
      return passedCheck(
        "preview",
        "PreviewVerifier",
        `Preview probe returned HTTP ${probe.status}.`,
      );
    }

    return failedCheck(
      "preview",
      "PreviewVerifier",
      `Preview probe failed: ${probe.summary}`,
    );
  }
}

export function verifyScope(
  contract: TaskContract,
  changedFiles: string[],
): VerificationCheck {
  const forbidden = changedFiles.find((path) =>
    contract.scope.forbiddenPaths.some((pattern) => matchesPattern(path, pattern)),
  );

  if (forbidden) {
    return failedCheck(
      "scope",
      "ScopeVerifier",
      `Changed file ${forbidden} is forbidden by task scope.`,
    );
  }

  if (changedFiles.some((path) => path.startsWith(".env") || path.includes("/.env"))) {
    return failedCheck("scope", "ScopeVerifier", "Changed files include .env content.");
  }

  return passedCheck("scope", "ScopeVerifier", "Changed files stayed within scope.");
}

function summarizeStatus(
  checks: VerificationCheck[],
  contract: TaskContract,
): VerificationStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  const inconclusiveChecks = checks.filter((check) => check.status === "inconclusive");

  if (
    inconclusiveChecks.length > 0 &&
    contract.acceptanceCriteria.some((criterion) => criterion.required)
  ) {
    return "inconclusive";
  }

  return "passed";
}

function passedCheck(id: string, title: string, summary: string): VerificationCheck {
  return {
    id,
    title,
    status: "passed",
    summary,
  };
}

function failedCheck(
  id: string,
  title: string,
  summary: string,
  details?: unknown,
): VerificationCheck {
  return {
    id,
    title,
    status: "failed",
    summary,
    details,
  };
}

function skippedCheck(id: string, title: string, summary: string): VerificationCheck {
  return {
    id,
    title,
    status: "skipped",
    summary,
  };
}

function matchesPattern(path: string, pattern: string) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(`${prefix}.`);
  }

  return path === pattern || path.startsWith(`${pattern}/`);
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
