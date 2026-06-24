import type { AgentRun, TaskContract, ToolDefinition } from "../types";
import {
  isPathAllowed,
  isPathForbidden,
  normalizeProjectPath,
} from "../pathScope";

export type PolicyDecision =
  | {
      allowed: true;
      approvalRequired: false;
      reason: string;
    }
  | {
      allowed: true;
      approvalRequired: true;
      approvalHash: string;
      reason: string;
    }
  | {
      allowed: false;
      reason: string;
    };

export type PolicyEvaluationInput = {
  approvedHashes?: Set<string>;
  args: unknown;
  run: AgentRun;
  tool: ToolDefinition;
};

export class PolicyEngine {
  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const hardDeny = this.evaluateHardDenies(input.run.contract, input.tool, input.args);

    if (hardDeny) {
      return hardDeny;
    }

    const approvalHash = normalizeApprovalHash(
      input.run.id,
      input.tool.name,
      input.args,
    );

    if (
      input.tool.approvalPolicy === "always" &&
      !input.approvedHashes?.has(approvalHash)
    ) {
      return {
        allowed: true,
        approvalRequired: true,
        approvalHash,
        reason: `${input.tool.name} requires explicit approval.`,
      };
    }

    if (
      input.tool.approvalPolicy === "conditional" &&
      this.requiresConditionalApproval(input.run.contract, input.tool, input.args) &&
      !input.approvedHashes?.has(approvalHash)
    ) {
      return {
        allowed: true,
        approvalRequired: true,
        approvalHash,
        reason: `${input.tool.name} changes resources that require approval.`,
      };
    }

    return {
      allowed: true,
      approvalRequired: false,
      reason: `${input.tool.name} allowed by task policy.`,
    };
  }

  private evaluateHardDenies(
    contract: TaskContract,
    tool: ToolDefinition,
    args: unknown,
  ): Extract<PolicyDecision, { allowed: false }> | null {
    const paths = collectPaths(args);

    if (
      tool.sideEffect !== "none" &&
      paths.some((path) => isPathForbidden(path, contract.scope.forbiddenPaths))
    ) {
      return {
        allowed: false,
        reason: "Tool target is inside a forbidden path such as .aibuilder or .env.",
      };
    }

    if (
      (tool.sideEffect === "workspace_write" || tool.sideEffect === "destructive") &&
      paths.length > 0 &&
      paths.some((path) => !isPathAllowed(path, contract.scope.allowedPaths))
    ) {
      return {
        allowed: false,
        reason: "Tool target is outside the task's allowed paths.",
      };
    }

    if (tool.sideEffect === "workspace_write" && !contract.permissions.fileWrite) {
      return {
        allowed: false,
        reason: "This task contract does not permit file writes.",
      };
    }

    if (tool.sideEffect === "database_write" && contract.permissions.databaseChange === "deny") {
      return {
        allowed: false,
        reason: "This task contract does not permit database changes.",
      };
    }

    if (tool.name === "delete_files" && contract.permissions.fileDelete === "deny") {
      return {
        allowed: false,
        reason: "This task contract denies file deletion.",
      };
    }

    if (
      tool.sideEffect === "workspace_write" &&
      paths.includes("package.json") &&
      contract.permissions.dependencyChange === "deny"
    ) {
      return {
        allowed: false,
        reason: "This task contract denies dependency changes.",
      };
    }

    return null;
  }

  private requiresConditionalApproval(
    contract: TaskContract,
    tool: ToolDefinition,
    args: unknown,
  ) {
    if (tool.name === "update_design_tokens") {
      return false;
    }

    if (
      tool.sideEffect === "workspace_write" &&
      collectPaths(args).includes("package.json")
    ) {
      return contract.permissions.dependencyChange === "ask";
    }

    if (tool.name === "run_command") {
      const command = extractCommand(args);
      return command === "npm install" || command === "pnpm install";
    }

    if (tool.name === "apply_supabase_schema") {
      return contract.permissions.databaseChange === "ask";
    }

    return false;
  }
}

export function normalizeApprovalHash(
  runId: string,
  toolName: string,
  args: unknown,
) {
  return hashText(stableStringify({ runId, toolName, args }));
}

function collectPaths(value: unknown, parentKey = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string" && isPathField(parentKey)) {
        return [normalizeProjectPath(item)];
      }

      return collectPaths(item, parentKey);
    });
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];

  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && isPathField(key)) {
      paths.push(normalizeProjectPath(item));
    } else {
      paths.push(...collectPaths(item, key));
    }
  }

  return paths;
}

function isPathField(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized === "file" ||
    normalized === "files" ||
    normalized === "path" ||
    normalized === "paths" ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths")
  );
}

function extractCommand(args: unknown) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return null;
  }

  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function hashText(content: string) {
  let hash = 2166136261;

  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `${content.length}:${(hash >>> 0).toString(16)}`;
}
