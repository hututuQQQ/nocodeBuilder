import type { AiProviderConfig } from "../services/keyStore";
import { ChatCompletionClient } from "../agent/llm/ChatCompletionClient";
import type { ChatMessage as LlmChatMessage } from "../agent/llm/types";
import {
  buildFeatureSpecMessages,
  buildInitialSpecMessages,
  buildSpecRevisionMessages,
} from "./prompts";
import { validateGeneratedSpecRevisionPayload } from "../spec-core/validators";
import type { GeneratedSpecRevisionPayload } from "../spec-core/types";

const SPEC_VALIDATION_RETRY_LIMIT = 1;

export async function requestInitialSpec({
  config,
  onDelta,
  projectBrief,
  projectName,
  signal,
}: {
  config: AiProviderConfig;
  onDelta?: (delta: string) => void;
  projectBrief: string;
  projectName: string;
  signal?: AbortSignal;
}) {
  const client = createSpecChatClient(config);
  return requestValidatedSpecPayload({
    client,
    messages: buildInitialSpecMessages({ projectBrief, projectName }),
    onDelta,
    signal,
  });
}

export async function requestFeatureSpec({
  brief,
  config,
  context,
  onDelta,
  signal,
}: {
  brief: string;
  config: AiProviderConfig;
  context: unknown;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}) {
  const client = createSpecChatClient(config);
  return requestValidatedSpecPayload({
    client,
    messages: buildFeatureSpecMessages({ brief, context }),
    onDelta,
    signal,
  });
}

export async function requestSpecRevision({
  config,
  currentRevision,
  feedback,
  onDelta,
  signal,
}: {
  config: AiProviderConfig;
  currentRevision: unknown;
  feedback: string;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}) {
  const client = createSpecChatClient(config);
  return requestValidatedSpecPayload({
    client,
    messages: buildSpecRevisionMessages({ currentRevision, feedback }),
    onDelta,
    signal,
  });
}

function createSpecChatClient(config: AiProviderConfig) {
  return new ChatCompletionClient({
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
  });
}

async function requestValidatedSpecPayload({
  client,
  messages,
  onDelta,
  signal,
}: {
  client: ChatCompletionClient;
  messages: LlmChatMessage[];
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}): Promise<GeneratedSpecRevisionPayload> {
  let currentMessages = messages;
  let lastResponse: unknown = null;

  for (let attempt = 0; attempt <= SPEC_VALIDATION_RETRY_LIMIT; attempt += 1) {
    lastResponse = await client.chatJson<unknown>(currentMessages, {
      onDelta,
      signal,
    });

    try {
      return validateGeneratedSpecRevisionPayload(lastResponse);
    } catch (error) {
      if (attempt >= SPEC_VALIDATION_RETRY_LIMIT) {
        throw error;
      }

      currentMessages = buildSpecValidationRepairMessages(
        currentMessages,
        lastResponse,
        error,
      );
    }
  }

  return validateGeneratedSpecRevisionPayload(lastResponse);
}

function buildSpecValidationRepairMessages(
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
          task: "Repair the Spec JSON so it passes validation. Return the complete replacement Spec JSON only.",
          validationError: formatValidationError(error),
          invalidResponse,
          instructions: [
            "Preserve the user's requested product scope and language.",
            "Every task.acceptanceCriteriaIds array must contain at least one existing acceptance criterion id.",
            "Do not invent requirementIds or acceptanceCriteriaIds that are not declared in requirements.",
            "Every required acceptance criterion must still be covered by at least one task.",
            "Return JSON only. Do not output Markdown, prose, comments, or code fences.",
          ],
        },
        null,
        2,
      ),
    },
  ];
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
