import type { ProjectFileInput } from "../../services/projects";
import type {
  AgentCommand,
  AgentStepResponse,
  AgentToolCallStep,
  GenerateProjectResponse,
  ModifyProjectResponse,
} from "./types";
import {
  isAllowedProjectSearchPath,
  isAllowedProjectPath,
  normalizeProjectPath,
  uniquePaths,
} from "./pathRules";
import {
  validateGeneratedPackageJson,
  validatePackageJsonContent,
} from "./packageValidation";
import { isRecord } from "./records";
import {
  AGENT_COMMANDS,
  getAgentToolDefinition,
  isAgentToolName,
} from "./toolRegistry";

const REQUIRED_GENERATED_FILES = [
  "package.json",
  "app/layout.tsx",
  "app/page.tsx",
  "app/globals.css",
];

const AGENT_COMMAND_SET = new Set<AgentCommand>(AGENT_COMMANDS);

export function validateGeneratedProjectResponse(
  value: unknown,
): GenerateProjectResponse {
  const response = validateProjectFileResponse(value, "write_files");
  const paths = new Set(response.files.map((file) => file.path));

  for (const requiredPath of REQUIRED_GENERATED_FILES) {
    if (!paths.has(requiredPath)) {
      throw new Error(
        `Invalid model response: generated project is missing ${requiredPath}.`,
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
    throw new Error("Invalid model response: root value must be a JSON object.");
  }

  if (value.type === "answer") {
    if (typeof value.message !== "string" || !value.message.trim()) {
      throw new Error("Invalid model response: answer.message is required.");
    }

    return {
      type: "answer",
      message: value.message.trim(),
    };
  }

  if (value.type === "finish") {
    if (typeof value.summary !== "string" || !value.summary.trim()) {
      throw new Error("Invalid model response: finish.summary is required.");
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

  if (value.type === "tool_calls") {
    if (!Array.isArray(value.calls) || value.calls.length === 0) {
      throw new Error("Invalid model response: tool_calls.calls is required.");
    }

    if (value.calls.length > 6) {
      throw new Error("Invalid model response: tool_calls may include at most 6 calls.");
    }

    const calls = value.calls.map((call) => {
      if (!isRecord(call)) {
        throw new Error("Invalid model response: every tool call must be an object.");
      }

      return validateAgentToolCall(call);
    });
    const unsafeCall = calls.find((call) => {
      const definition = getAgentToolDefinition(call.tool);
      return !definition?.isReadOnly || !definition.isConcurrencySafe;
    });

    if (unsafeCall) {
      throw new Error(
        `Invalid model response: tool_calls may only include read-only tools, got ${unsafeCall.tool}.`,
      );
    }

    return {
      type: "tool_calls",
      rationale:
        typeof value.rationale === "string" && value.rationale.trim()
          ? value.rationale.trim()
          : undefined,
      calls,
    };
  }

  if (value.type !== "tool_call") {
    throw new Error(
      'Invalid model response: type must be "answer", "tool_call", "tool_calls", or "finish".',
    );
  }

  return validateAgentToolCall(value);
}

function validateAgentToolCall(value: Record<string, unknown>): AgentToolCallStep {
  const tool = typeof value.tool === "string" ? value.tool : "";

  if (!isAgentToolName(tool)) {
    throw new Error(`Invalid model response: unknown tool "${tool}".`);
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
          offset: validateOptionalInteger(args.offset, "read_files.offset", 1, 20_000),
          limit: validateOptionalInteger(args.limit, "read_files.limit", 1, 800),
        },
      };
    case "grep_files":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          query: validateTextArg(args.query, "grep_files.query", 240),
          paths: validateOptionalSearchPathArray(args.paths, "grep_files.paths"),
          maxResults: validateOptionalInteger(args.maxResults, "grep_files.maxResults", 1, 100),
          contextLines: validateOptionalInteger(args.contextLines, "grep_files.contextLines", 0, 3),
          caseSensitive:
            typeof args.caseSensitive === "boolean" ? args.caseSensitive : undefined,
        },
      };
    case "glob_files":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          pattern: validateGlobPattern(args.pattern),
          maxResults: validateOptionalInteger(args.maxResults, "glob_files.maxResults", 1, 200),
        },
      };
    case "edit_file":
      return {
        type: "tool_call",
        tool,
        rationale,
        args: {
          path: validateSinglePath(args.path, "edit_file.path"),
          old_string: validateTextArg(args.old_string, "edit_file.old_string", 80_000),
          new_string: validateStringArg(args.new_string, "edit_file.new_string", 100_000),
          replace_all:
            typeof args.replace_all === "boolean" ? args.replace_all : undefined,
          summary: validateSummaryArg(args.summary, "Edited project file."),
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

  throw new Error(`Invalid model response: unknown tool "${tool}".`);
}

function validateSinglePath(value: unknown, label: string) {
  const paths = validatePathArray([value], label);
  return paths[0];
}

function validatePathArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid model response: ${label} must be a non-empty array.`);
  }

  if (value.length > 12) {
    throw new Error(`Invalid model response: ${label} may include at most 12 paths.`);
  }

  return uniquePaths(
    value.map((item) => {
      const path = normalizeProjectPath(item);

      if (!path || !isAllowedProjectPath(path)) {
        throw new Error(
          `Model attempted to use a forbidden path: ${String(item ?? "")}`,
        );
      }

      return path;
    }),
  );
}

function validateOptionalSearchPathArray(value: unknown, label: string) {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid model response: ${label} must be a non-empty array when provided.`);
  }

  if (value.length > 12) {
    throw new Error(`Invalid model response: ${label} may include at most 12 paths.`);
  }

  return uniquePaths(
    value.map((item) => {
      const path = normalizeProjectPath(item);

      if (!path || !isAllowedProjectSearchPath(path)) {
        throw new Error(
          `Model attempted to search a forbidden path: ${String(item ?? "")}`,
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
    throw new Error(`Invalid model response: ${label} may include at most 16 files.`);
  }

  const packageFile = response.files.find((file) => file.path === "package.json");

  if (packageFile) {
    validatePackageJsonContent(packageFile.content);
  }

  return response.files;
}

function validateSummaryArg(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function validateAgentCommand(value: unknown): AgentCommand {
  const command = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

  if (!AGENT_COMMAND_SET.has(command as AgentCommand)) {
    throw new Error(
      `Model attempted to run a forbidden command: ${String(value ?? "")}`,
    );
  }

  return command as AgentCommand;
}

function validateTextArg(value: unknown, label: string, maxLength: number) {
  const text = validateStringArg(value, label, maxLength);

  if (!text.trim()) {
    throw new Error(`Invalid model response: ${label} must not be empty.`);
  }

  return text;
}

function validateStringArg(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new Error(`Invalid model response: ${label} must be a string.`);
  }

  if (value.length > maxLength) {
    throw new Error(
      `Invalid model response: ${label} may include at most ${maxLength} characters.`,
    );
  }

  return value;
}

function validateOptionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid model response: ${label} must be an integer from ${min} to ${max}.`,
    );
  }

  return value;
}

function validateGlobPattern(value: unknown) {
  const pattern = validateTextArg(value, "glob_files.pattern", 240)
    .trim()
    .replace(/\\/g, "/");

  if (
    pattern.startsWith("/") ||
    /^[A-Za-z]:/.test(pattern) ||
    pattern.includes("\0") ||
    pattern.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error("Invalid model response: glob_files.pattern is forbidden.");
  }

  return pattern;
}

function validateProjectFileResponse<TType extends "write_files" | "modify_files">(
  value: unknown,
  expectedType: TType,
): TType extends "write_files" ? GenerateProjectResponse : ModifyProjectResponse {
  if (!isRecord(value)) {
    throw new Error("Invalid model response: root value must be a JSON object.");
  }

  if (value.type !== expectedType) {
    throw new Error(`Invalid model response: type must be "${expectedType}".`);
  }

  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("Invalid model response: summary is required.");
  }

  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Model did not return any writable files.");
  }

  const filesByPath = new Map<string, ProjectFileInput>();

  for (const file of value.files) {
    if (!isRecord(file)) {
      throw new Error("Invalid model response: every file entry must be an object.");
    }

    const path = normalizeProjectPath(file.path);

    if (!path || !isAllowedProjectPath(path)) {
      throw new Error(
        `Model attempted to write a forbidden path: ${String(file.path ?? "")}`,
      );
    }

    if (typeof file.content !== "string") {
      throw new Error(`Invalid model response: ${path} content must be a string.`);
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
