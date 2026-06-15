import type { DeepSeekConfig } from "../../services/keyStore";
import { DeepSeekClient } from "../llm/DeepSeekClient";
import {
  buildAgentStepMessages,
  buildGenerateProjectMessages,
  buildModifyProjectMessages,
} from "./prompts";
import type { AgentStepContext, ModificationContext } from "./types";
import {
  validateAgentStepResponse,
  validateGeneratedProjectResponse,
  validateModifyProjectResponse,
} from "./validators";

export async function requestProjectGeneration({
  config,
  onDelta,
  projectName,
  userPrompt,
}: {
  config: DeepSeekConfig;
  onDelta?: (delta: string) => void;
  projectName: string;
  userPrompt: string;
}) {
  const client = new DeepSeekClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });

  const response = await client.chatJson<unknown>(
    buildGenerateProjectMessages(projectName, userPrompt),
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
  config: DeepSeekConfig;
  context: ModificationContext;
  onDelta?: (delta: string) => void;
  userRequest: string;
}) {
  const client = new DeepSeekClient({
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
  config: DeepSeekConfig;
  context: AgentStepContext;
  onDelta?: (delta: string) => void;
  userRequest: string;
}) {
  const client = new DeepSeekClient({
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
