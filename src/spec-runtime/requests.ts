import type { AiProviderConfig } from "../services/keyStore";
import { ChatCompletionClient } from "../agent/llm/ChatCompletionClient";
import {
  buildFeatureSpecMessages,
  buildInitialSpecMessages,
  buildSpecRevisionMessages,
} from "./prompts";
import { validateGeneratedSpecRevisionPayload } from "../spec-core/validators";

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
  const response = await client.chatJson<unknown>(
    buildInitialSpecMessages({ projectBrief, projectName }),
    { onDelta, signal },
  );

  return validateGeneratedSpecRevisionPayload(response);
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
  const response = await client.chatJson<unknown>(
    buildFeatureSpecMessages({ brief, context }),
    { onDelta, signal },
  );

  return validateGeneratedSpecRevisionPayload(response);
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
  const response = await client.chatJson<unknown>(
    buildSpecRevisionMessages({ currentRevision, feedback }),
    { onDelta, signal },
  );

  return validateGeneratedSpecRevisionPayload(response);
}

function createSpecChatClient(config: AiProviderConfig) {
  return new ChatCompletionClient({
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
  });
}
