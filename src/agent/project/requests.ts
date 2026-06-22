import type { AiProviderConfig } from "../../services/keyStore";
import { ChatCompletionClient } from "../llm/ChatCompletionClient";
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

export async function requestProjectGeneration({
  backendContext,
  config,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  projectName,
  userPrompt,
}: {
  backendContext?: AgentStepContext["backend"];
  config: AiProviderConfig;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  projectName: string;
  userPrompt: string;
}) {
  const client = createProjectChatClient(config);

  const response = await client.chatJson<unknown>(
    buildGenerateProjectMessages(projectName, userPrompt, backendContext, policy),
    { onDelta },
  );

  return validateGeneratedProjectResponse(response, policy);
}

export async function requestProjectModification({
  config,
  context,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  userRequest,
}: {
  config: AiProviderConfig;
  context: ModificationContext;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  userRequest: string;
}) {
  const client = createProjectChatClient(config);

  const response = await client.chatJson<unknown>(
    buildModifyProjectMessages(context, userRequest, policy),
    { onDelta },
  );

  return validateModifyProjectResponse(response, policy);
}

export async function requestAgentStep({
  config,
  context,
  onDelta,
  policy = DEFAULT_PROJECT_POLICY,
  userRequest,
}: {
  config: AiProviderConfig;
  context: AgentStepContext;
  onDelta?: (delta: string) => void;
  policy?: ProjectPolicy;
  userRequest: string;
}) {
  const client = createProjectChatClient(config);

  const response = await client.chatJson<unknown>(
    buildAgentStepMessages(context, userRequest, policy),
    { onDelta },
  );

  return validateAgentStepResponse(response, policy);
}

function createProjectChatClient(config: AiProviderConfig) {
  return new ChatCompletionClient({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}
