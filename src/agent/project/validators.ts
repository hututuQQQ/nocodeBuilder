import type { ProjectFileInput } from "../../services/projects";
import type {
  AgentCommand,
  AgentStepResponse,
  GenerateProjectResponse,
  ModifyProjectResponse,
} from "./types";
import {
  isAllowedProjectPath,
  normalizeProjectPath,
  uniquePaths,
} from "./pathRules";
import {
  validateGeneratedPackageJson,
  validatePackageJsonContent,
} from "./packageValidation";
import { isRecord } from "./records";

const REQUIRED_GENERATED_FILES = [
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
  "app/globals.css",
];

const AGENT_COMMANDS = new Set<AgentCommand>([
  "npm install",
  "npm run build",
  "pnpm install",
  "pnpm build",
]);

const AGENT_TOOLS = new Set([
  "list_files",
  "read_files",
  "write_files",
  "delete_files",
  "run_command",
  "start_dev_server",
  "stop_dev_server",
  "refresh_preview",
  "rollback_last_change",
]);

export function validateGeneratedProjectResponse(
  value: unknown,
): GenerateProjectResponse {
  const response = validateProjectFileResponse(value, "write_files");
  const paths = new Set(response.files.map((file) => file.path));

  for (const requiredPath of REQUIRED_GENERATED_FILES) {
    if (!paths.has(requiredPath)) {
      throw new Error(
        `Invalid DeepSeek response: generated project is missing ${requiredPath}.`,
      );
    }
  }

  validateGeneratedPackageJson(response.files);
  return response;
}

export function validateModifyProjectResponse(
  value: unknown,
): ModifyProjectResponse {
  const response = validateProjectFileResponse(value, "modify_files");
  const packageFile = response.files.find((file) => file.path === "package.json");

  if (packageFile) {
    validatePackageJsonContent(packageFile.content);
  }

  return response;
}

export function validateAgentStepResponse(value: unknown): AgentStepResponse {
  if (!isRecord(value)) {
    throw new Error("Invalid DeepSeek response: root value must be a JSON object.");
  }

  if (value.type === "answer") {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error("Invalid DeepSeek response: answer.message is required.");
    }

    return {
      type: "answer",
      message: value.message.trim(),
    };
  }

  if (value.type === "finish") {
    if (typeof value.summary !== "string" || !value.summary.trim()) {
      throw new Error("Invalid DeepSeek response: finish.summary is required.");
    }

    return {
      type: "finish",
      summary: value.summary.trim(),
      verification:
        typeof value.verification === "string" && value.verification.trim()
          ? value.verification.trim()
          : undefined,
    };
  }

  if (value.type !== "tool_call") {
    throw new Error(
      'Invalid DeepSeek response: type must be "answer", "tool_call", or "finish".',
    );
  }

  const tool = typeof value.tool === "string" ? value.tool : "";

  if (!AGENT_TOOLS.has(tool)) {
    throw new Error(`Invalid DeepSeek response: unknown tool "${tool}".`);
  }

  const rationale =
    typeof value.rationale === "string" && value.rationale.trim()
      ? value.rationale.trim()
      : "Next project action.";
  const args = isRecord(value.args) ? value.args : {};

  switch (tool) {
    case "list_files":
    case "start_dev_server":
    case "stop_dev_server":
    case "refresh_preview":
    case "rollback_last_change":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {},
      };
    case "read_files":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          paths: validatePathArray(args.paths, "read_files.paths"),
        },
      };
    case "write_files":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          files: validateProjectFiles(args.files, "write_files.files"),
          summary: validateSummaryArg(args.summary, "Updated project files."),
        },
      };
    case "delete_files":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          paths: validatePathArray(args.paths, "delete_files.paths"),
          summary: validateSummaryArg(args.summary, "Deleted project files."),
        },
      };
    case "run_command":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          command: validateAgentCommand(args.command),
        },
      };
  }

  throw new Error(`Invalid DeepSeek response: unknown tool "${tool}".`);
}

function validatePathArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid DeepSeek response: ${label} must be a non-empty array.`);
  }

  if (value.length > 12) {
    throw new Error(`Invalid DeepSeek response: ${label} may include at most 12 paths.`);
  }

  return uniquePaths(
    value.map((item) => {
      const path = normalizeProjectPath(item);

      if (!path || !isAllowedProjectPath(path)) {
        throw new Error(
          `DeepSeek attempted to use a forbidden path: ${String(item ?? "")}`,
        );
      }

      return path;
    }),
  );
}

function validateProjectFiles(value: unknown, label: string) {
  const response = validateProjectFileResponse(
    {
      type: "modify_files",
      summary: "Agent file write",
      files: value,
    },
    "modify_files",
  );

  if (response.files.length > 16) {
    throw new Error(`Invalid DeepSeek response: ${label} may include at most 16 files.`);
  }

  return response.files;
}

function validateSummaryArg(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function validateAgentCommand(value: unknown): AgentCommand {
  const command = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

  if (!AGENT_COMMANDS.has(command as AgentCommand)) {
    throw new Error(
      `DeepSeek attempted to run a forbidden command: ${String(value ?? "")}`,
    );
  }

  return command as AgentCommand;
}

function validateProjectFileResponse<TType extends "write_files" | "modify_files">(
  value: unknown,
  expectedType: TType,
): TType extends "write_files" ? GenerateProjectResponse : ModifyProjectResponse {
  if (!isRecord(value)) {
    throw new Error("Invalid DeepSeek response: root value must be a JSON object.");
  }

  if (value.type !== expectedType) {
    throw new Error(`Invalid DeepSeek response: type must be "${expectedType}".`);
  }

  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("Invalid DeepSeek response: summary is required.");
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("DeepSeek did not return any writable files.");
  }

  const filesByPath = new Map<string, ProjectFileInput>();

  for (const file of value.files) {
    if (!isRecord(file)) {
      throw new Error("Invalid DeepSeek response: every file entry must be an object.");
    }

    const path = normalizeProjectPath(file.path);

    if (!path || !isAllowedProjectPath(path)) {
      throw new Error(
        `DeepSeek attempted to write a forbidden path: ${String(file.path ?? "")}`,
      );
    }

    if (typeof file.content !== "string") {
      throw new Error(`Invalid DeepSeek response: ${path} content must be a string.`);
    }

    filesByPath.set(path, {
      path,
      content: file.content,
    });
  }

  return {
    type: expectedType,
    summary: value.summary.trim(),
    files: Array.from(filesByPath.values()),
  } as TType extends "write_files" ? GenerateProjectResponse : ModifyProjectResponse;
}
