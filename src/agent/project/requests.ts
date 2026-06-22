import type { AiProviderConfig } from "../../services/keyStore";
import { ChatCompletionClient } from "../llm/ChatCompletionClient";
import {
  buildAgentStepMessages,
  buildGenerateProjectMessages,
  buildModifyProjectMessages,
} from "./prompts";
import type {
  AgentStepContext,
  ModificationContext,
} from "./types";
import {
  validateAgentStepResponse,
  validateGeneratedProjectResponse,
  validateModifyProjectResponse,
} from "./validators";

export async function requestProjectGeneration({
  backendContext,
  config,
  onDelta,
  projectName,
  userPrompt,
}: {
  backendContext?: AgentStepContext["backend"];
  config: AiProviderConfig;
  onDelta?: (delta: string) => void;
  projectName: string;
  userPrompt: string;
}) {
  const client = new ChatCompletionClient({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildGenerateProjectMessages(projectName, userPrompt, backendContext),
    { onDelta },
  );

  return validateGeneratedProjectResponse(response);
}

export async function requestProjectModification({
  config,
  context,
  onDelta,
  userRequest,
}: {
  config: AiProviderConfig;
  context: ModificationContext;
  onDelta?: (delta: string) => void;
  userRequest: string;
}) {
  const client = new ChatCompletionClient({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildModifyProjectMessages(context, userRequest),
    { onDelta },
  );

  return validateModifyProjectResponse(response);
}

export async function requestAgentStep({
  config,
  context,
  onDelta,
  userRequest,
}: {
  config: AiProviderConfig;
  context: AgentStepContext;
  onDelta?: (delta: string) => void;
  userRequest: string;
}) {
  const client = new ChatCompletionClient({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildAgentStepMessages(context, userRequest),
    { onDelta },
  );

  return validateAgentStepResponse(response);
}
