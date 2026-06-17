export const AI_PROVIDER_IDS = ["deepseek", "glm"] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiModelOption = {
  value: string;
  label: string;
  description: string;
};

export type AiProviderDefinition = {
  id: AiProviderId;
  label: string;
  apiKeyPlaceholder: string;
  defaultBaseUrl: string;
  defaultModel: string;
  modelOptions: AiModelOption[];
  requestBodyDefaults?: Record<string, unknown>;
};

export const AI_PROVIDER_DEFINITIONS: Record<
  AiProviderId,
  AiProviderDefinition
> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    apiKeyPlaceholder: "sk-...",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    modelOptions: [
      {
        value: "deepseek-v4-pro",
        label: "Pro",
        description: "Higher quality edits",
      },
      {
        value: "deepseek-v4-flash",
        label: "Flash",
        description: "Faster and lighter",
      },
    ],
    requestBodyDefaults: {
      thinking: { type: "disabled" },
    },
  },
  glm: {
    id: "glm",
    label: "GLM",
    apiKeyPlaceholder: "Your GLM API key",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
    modelOptions: [
      {
        value: "glm-5.2",
        label: "GLM 5.2",
        description: "Latest GLM flagship model",
      },
      {
        value: "glm-5.1",
        label: "GLM 5.1",
        description: "Strong coding and reasoning model",
      },
      {
        value: "glm-4.7",
        label: "GLM 4.7",
        description: "Stable high-context GLM model",
      },
      {
        value: "glm-4.6",
        label: "GLM 4.6",
        description: "Balanced GLM model",
      },
    ],
  },
};

export const DEFAULT_AI_PROVIDER: AiProviderId = "deepseek";

export function isAiProviderId(value: string): value is AiProviderId {
  return AI_PROVIDER_IDS.some((provider) => provider === value);
}

export function getAiProviderDefinition(
  provider: AiProviderId,
): AiProviderDefinition {
  return AI_PROVIDER_DEFINITIONS[provider];
}

export function getDefaultAiModel(provider: AiProviderId) {
  return getAiProviderDefinition(provider).defaultModel;
}

export function getDefaultAiBaseUrl(provider: AiProviderId) {
  return getAiProviderDefinition(provider).defaultBaseUrl;
}

export function isKnownProviderModel(provider: AiProviderId, model: string) {
  return getAiProviderDefinition(provider).modelOptions.some(
    (option) => option.value === model,
  );
}
