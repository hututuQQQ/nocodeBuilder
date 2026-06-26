import type { AiProviderConfig } from "../../services/keyStore";
import type {
  AgentRun,
  RunContextSummary,
} from "../../agent-core/types";
import { ChatCompletionClient } from "../llm/ChatCompletionClient";
import type { ChatMessage as LlmChatMessage } from "../llm/types";
import {
  buildAgentStepMessages,
  buildGenerateProjectMessages,
  buildModifyProjectMessages,
} from "./prompts";
import {
  DEFAULT_PROJECT_POLICY,
  type ProjectPolicy,
} from "./projectPolicy";
import type {
  AgentStepContext,
  ModificationContext,
} from "./types";
import {
  validateAgentStepResponse,
  validateGeneratedProjectResponse,
  validateModifyProjectResponse,
} from "./validators";
import { AGENT_COMMANDS } from "./toolRegistry";

const AGENT_STEP_VALIDATION_RETRY_LIMIT = 2;
const INVALID_RESPONSE_PREVIEW_CHAR_LIMIT = 4_000;

export class AgentStepValidationError extends Error {
  readonly attempts: number;
  readonly invalidResponsePreview: string;
  readonly validationError: string;

  constructor({
    attempts,
    invalidResponse,
    validationError,
  }: {
    attempts: number;
    invalidResponse: unknown;
    validationError: string;
  }) {
    super(
      `Invalid model response repair exhausted after ${attempts} attempt(s): ${validationError}`,
    );
    this.name = "AgentStepValidationError";
    this.attempts = attempts;
    this.invalidResponsePreview = compactResponseText(
      stringifyForPrompt(invalidResponse),
      INVALID_RESPONSE_PREVIEW_CHAR_LIMIT,
    );
    this.validationError = validationError;
  }
}

export async function requestProjectGeneration({
  backendContext,
  config,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  projectName,
  signal,
  userPrompt,
}: {
  backendContext?: AgentStepContext["backend"];
  config: AiProviderConfig;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  projectName: string;
  signal?: AbortSignal;
  userPrompt: string;
}) {
  const client = createProjectChatClient(config);

  const response = await client.chatJson<unknown>(
    buildGenerateProjectMessages(projectName, userPrompt, backendContext, policy),
    { onDelta, signal },
  );

  return validateGeneratedProjectResponse(response, policy);
}

export async function requestProjectModification({
  config,
  context,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  signal,
  userRequest,
}: {
  config: AiProviderConfig;
  context: ModificationContext;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  signal?: AbortSignal;
  userRequest: string;
}) {
  const client = createProjectChatClient(config);

  const response = await client.chatJson<unknown>(
    buildModifyProjectMessages(context, userRequest, policy),
    { onDelta, signal },
  );

  return validateModifyProjectResponse(response, policy);
}

export async function requestAgentStep({
  config,
  context,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  signal,
  userRequest,
}: {
  config: AiProviderConfig;
  context: AgentStepContext;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  signal?: AbortSignal;
  userRequest: string;
}) {
  const client = createProjectChatClient(config);
  const messages = buildAgentStepMessages(context, userRequest, policy);

  return requestValidatedAgentStep({
    client,
    messages,
    onDelta,
    policy,
    signal,
  });
}

export async function requestRunContextSummary({
  changedFiles,
  config,
  current,
  deletedFiles,
  observations,
  run,
  signal,
}: {
  changedFiles: string[];
  config: AiProviderConfig;
  current: RunContextSummary;
  deletedFiles: string[];
  observations: string[];
  run: AgentRun;
  signal?: AbortSignal;
}) {
  const client = createProjectChatClient(config);
  const response = await client.chatJson<unknown>(
    buildRunContextSummaryMessages({
      changedFiles,
      current,
      deletedFiles,
      observations,
      run,
    }),
    { signal },
  );

  return validateRunContextSummary(response, current, observations.length);
}

function createProjectChatClient(config: AiProviderConfig) {
  return new ChatCompletionClient({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

function buildRunContextSummaryMessages({
  changedFiles,
  current,
  deletedFiles,
  observations,
  run,
}: {
  changedFiles: string[];
  current: RunContextSummary;
  deletedFiles: string[];
  observations: string[];
  run: AgentRun;
}): LlmChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Summarize a long-running coding agent state for the next planning step.",
        "Return JSON only. Keep concise, factual state that helps the next agent step continue without rereading old logs.",
        "Do not invent completed work, file changes, requirements, approvals, or verification results.",
        "Preserve concrete error messages, important files, and the smallest useful next step.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Update the rolling run context summary.",
          requiredShape: {
            objective: "string",
            completed: ["string"],
            decisions: ["string"],
            latestFailures: ["string"],
            importantFiles: ["app/page.tsx"],
            changedFiles: ["app/page.tsx"],
            deletedFiles: ["components/Old.tsx"],
            nextStep: "string",
            summarizedObservationCount: observations.length,
          },
          run: {
            id: run.id,
            objective: run.contract.objective,
            status: run.status,
            taskType: run.contract.taskType,
          },
          changedFiles,
          current,
          deletedFiles,
          recentObservations: observations.slice(-24),
        },
        null,
        2,
      ),
    },
  ];
}

function validateRunContextSummary(
  value: unknown,
  fallback: RunContextSummary,
  observationCount: number,
): RunContextSummary {
  if (!isRecord(value)) {
    return {
      ...fallback,
      summarizedObservationCount: observationCount,
    };
  }

  return {
    changedFiles: readStringArray(value.changedFiles, fallback.changedFiles, 40),
    completed: readStringArray(value.completed, fallback.completed, 12),
    decisions: readStringArray(value.decisions, fallback.decisions, 12),
    deletedFiles: readStringArray(value.deletedFiles, fallback.deletedFiles, 40),
    importantFiles: readStringArray(value.importantFiles, fallback.importantFiles, 40),
    latestFailures: readStringArray(value.latestFailures, fallback.latestFailures, 8),
    nextStep: readString(value.nextStep, fallback.nextStep, 420),
    objective: readString(value.objective, fallback.objective, 600),
    summarizedObservationCount: observationCount,
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : fallback.updatedAt,
  };
}

function readString(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return compactResponseText(value, maxLength);
}

function readStringArray(value: unknown, fallback: string[], maxItems: number) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => compactResponseText(item, 500))
    .slice(-maxItems);
}

function compactResponseText(value: string, maxLength: number) {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function requestValidatedAgentStep({
  client,
  messages,
  onDelta,
  policy,
  signal,
}: {
  client: ChatCompletionClient;
  messages: LlmChatMessage[];
  onDelta?: (delta: string) => void;
  policy: ProjectPolicy;
  signal?: AbortSignal;
}) {
  let currentMessages = messages;
  let lastResponse: unknown = null;

  for (let attempt = 0; attempt <= AGENT_STEP_VALIDATION_RETRY_LIMIT; attempt += 1) {
    lastResponse = await client.chatJson<unknown>(currentMessages, {
      onDelta,
      signal,
    });

    try {
      return validateAgentStepResponse(lastResponse, policy);
    } catch (error) {
      if (!isRepairableAgentStepValidationError(error)) {
        throw error;
      }

      if (attempt >= AGENT_STEP_VALIDATION_RETRY_LIMIT) {
        throw new AgentStepValidationError({
          attempts: attempt + 1,
          invalidResponse: lastResponse,
          validationError: formatValidationError(error),
        });
      }

      currentMessages = buildAgentStepValidationRepairMessages(
        currentMessages,
        lastResponse,
        error,
      );
    }
  }

  return validateAgentStepResponse(lastResponse, policy);
}

function buildAgentStepValidationRepairMessages(
  messages: LlmChatMessage[],
  invalidResponse: unknown,
  error: unknown,
): LlmChatMessage[] {
  return [
    ...messages,
    {
      role: "assistant",
      content: stringifyForPrompt(invalidResponse),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Repair the previous agent response so it matches the response protocol. Return one complete replacement JSON object only.",
          validationError: formatValidationError(error),
          invalidResponse,
          instructions: [
            "If a write, edit, delete, command, schema, preview, or dev-server action is needed, return exactly one top-level tool_call object.",
            "Use top-level tool_calls only for batches made entirely of read-only tools: list_files, read_files, grep_files, or glob_files.",
            "Do not include write_files, edit_file, delete_files, run_command, apply_supabase_schema, refresh_preview, start_dev_server, or stop_dev_server inside tool_calls.",
            `If validationError mentions a forbidden command, replace it with exactly one allowed command string: ${AGENT_COMMANDS.join(", ")}.`,
            "For run_command, do not add shell pipes, redirects, output truncation, flags, package names, or operators like |, >, 2>&1, &&, or ;.",
            "If validationError mentions a forbidden path, choose a path under the allowed project paths or read/search the allowed paths first.",
            "Preserve the user's request, current plan, and language.",
            "Return JSON only. Do not output Markdown, prose, comments, or code fences.",
          ],
        },
        null,
        2,
      ),
    },
  ];
}

const REPAIRABLE_AGENT_STEP_VALIDATION_PREFIXES = [
  "Invalid model response:",
  "Invalid package.json generated by model:",
  "Model attempted to ",
  "Model did not return any writable files.",
];

function isRepairableAgentStepValidationError(error: unknown) {
  return (
    error instanceof Error &&
    REPAIRABLE_AGENT_STEP_VALIDATION_PREFIXES.some((prefix) =>
      error.message.startsWith(prefix),
    )
  );
}

function formatValidationError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function stringifyForPrompt(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
