import type { AiProviderConfig } from "../../services/keyStore";
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

const AGENT_STEP_VALIDATION_RETRY_LIMIT = 2;

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

function createProjectChatClient(config: AiProviderConfig) {
  return new ChatCompletionClient({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
  });
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
      if (!isRepairableAgentStepValidationError(error) || attempt >= AGENT_STEP_VALIDATION_RETRY_LIMIT) {
        throw error;
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

function isRepairableAgentStepValidationError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.startsWith("Invalid model response:")
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
