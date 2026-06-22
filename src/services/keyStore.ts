import {
  AI_PROVIDER_IDS,
  DEFAULT_AI_PROVIDER,
  getAiProviderDefinition,
  getDefaultAiBaseUrl,
  getDefaultAiModel,
  isAiProviderId,
  isKnownProviderModel,
  type AiProviderId,
} from "./aiProviders";

export const VERCEL_DEPLOY_TARGETS = ["preview", "production"] as const;
export const DEFAULT_VERCEL_DEPLOY_TARGET = "preview";

export type AiProviderConfig = {
  provider: AiProviderId;
  apiKey: string;
  model: string;
  models: string[];
  baseUrl: string;
  updatedAt: string;
};

export type AiProviderConfigInput = {
  provider: AiProviderId;
  apiKey: string;
  model?: string;
  models: string[];
  baseUrl: string;
};

export type AiProviderConfigs = Partial<Record<AiProviderId, AiProviderConfig>>;

export type AiProviderState = {
  activeProvider: AiProviderId;
  configs: AiProviderConfigs;
  updatedAt: string;
};

export type VercelDeployTarget = (typeof VERCEL_DEPLOY_TARGETS)[number];

export interface KeyStore {
  getAiProviderState: () => Promise<AiProviderState>;
  getAiProviderConfig: () => Promise<AiProviderConfig | null>;
  saveAiProviderConfig: (
    config: AiProviderConfigInput,
  ) => Promise<AiProviderState>;
  saveAiProviderConfigs: (
    configs: AiProviderConfigInput[],
    activeProvider?: AiProviderId,
  ) => Promise<AiProviderState>;
}

const AI_PROVIDER_STORAGE_KEY = "ai-web-builder.ai-provider-config.v3";
const STALE_AI_PROVIDER_STORAGE_KEYS = [
  "ai-web-builder.ai-provider-config.v2",
  "ai-web-builder.ai-provider-config.v1",
  "ai-web-builder.deepseek-config.v1",
];

function createEmptyAiProviderState(): AiProviderState {
  return {
    activeProvider: DEFAULT_AI_PROVIDER,
    configs: {},
    updatedAt: "",
  };
}

export function getActiveAiProviderConfig(
  state: AiProviderState | null,
): AiProviderConfig | null {
  if (!state) {
    return null;
  }

  return state.configs[state.activeProvider] ?? null;
}

function normalizeAiProviderConfig(
  config: AiProviderConfigInput,
): AiProviderConfig {
  const provider = config.provider;
  const models = normalizeModelList(provider, config.models, config.model);
  const model =
    config.model && models.includes(config.model) ? config.model : models[0];

  return {
    provider,
    apiKey: config.apiKey.trim(),
    model,
    models,
    baseUrl: config.baseUrl.trim() || getDefaultAiBaseUrl(provider),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeModelList(
  provider: AiProviderId,
  models: string[],
  preferredModel?: string,
) {
  const knownModels = getAiProviderDefinition(provider).modelOptions.map(
    (option) => option.value,
  );
  const selectedModels = new Set(
    models
      .map((model) => model.trim())
      .filter((model) => isKnownProviderModel(provider, model)),
  );

  if (
    preferredModel &&
    isKnownProviderModel(provider, preferredModel) &&
    selectedModels.size === 0
  ) {
    selectedModels.add(preferredModel);
  }

  if (selectedModels.size === 0) {
    selectedModels.add(getDefaultAiModel(provider));
  }

  return knownModels.filter((model) => selectedModels.has(model));
}

function normalizeAiProviderState(
  state: Partial<AiProviderState>,
): AiProviderState {
  const configs: AiProviderConfigs = {};

  for (const provider of AI_PROVIDER_IDS) {
    const config = state.configs?.[provider];

    if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
      continue;
    }

    configs[provider] = normalizeAiProviderConfig({
      provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      models: Array.isArray(config.models) ? config.models : [config.model],
    });
  }

  const activeProvider =
    typeof state.activeProvider === "string" &&
    isAiProviderId(state.activeProvider) &&
    configs[state.activeProvider]
      ? state.activeProvider
      : (AI_PROVIDER_IDS.find((provider) => configs[provider]) ??
        DEFAULT_AI_PROVIDER);

  return {
    activeProvider,
    configs,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
  };
}

function readStoredAiProviderState(value: string | null): AiProviderState | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<AiProviderState>;

    if (!parsed.configs || typeof parsed.configs !== "object") {
      return null;
    }

    return normalizeAiProviderState(parsed);
  } catch {
    return null;
  }
}

function removeStaleAiProviderConfigs() {
  for (const storageKey of STALE_AI_PROVIDER_STORAGE_KEYS) {
    window.localStorage.removeItem(storageKey);
  }
}

class LocalStorageKeyStore implements KeyStore {
  async getAiProviderState() {
    removeStaleAiProviderConfigs();

    const currentState = readStoredAiProviderState(
      window.localStorage.getItem(AI_PROVIDER_STORAGE_KEY),
    );

    if (currentState) {
      return currentState;
    }

    return createEmptyAiProviderState();
  }

  async getAiProviderConfig() {
    return getActiveAiProviderConfig(await this.getAiProviderState());
  }

  async saveAiProviderConfig(config: AiProviderConfigInput) {
    return this.saveAiProviderConfigs([config], config.provider);
  }

  async saveAiProviderConfigs(
    configs: AiProviderConfigInput[],
    activeProvider?: AiProviderId,
  ) {
    const currentState = await this.getAiProviderState();
    const nextConfigs = configs.map(normalizeAiProviderConfig);
    const mergedConfigs: AiProviderConfigs = {
      ...currentState.configs,
    };

    for (const nextConfig of nextConfigs) {
      mergedConfigs[nextConfig.provider] = nextConfig;
    }

    const lastConfig = nextConfigs[nextConfigs.length - 1];
    const fallbackActiveProvider =
      AI_PROVIDER_IDS.find((provider) => mergedConfigs[provider]) ??
      DEFAULT_AI_PROVIDER;
    const nextActiveProvider =
      activeProvider && mergedConfigs[activeProvider]
        ? activeProvider
        : lastConfig
          ? lastConfig.provider
          : mergedConfigs[currentState.activeProvider]
            ? currentState.activeProvider
            : fallbackActiveProvider;
    const nextState: AiProviderState = {
      activeProvider: nextActiveProvider,
      configs: mergedConfigs,
      updatedAt: new Date().toISOString(),
    };

    window.localStorage.setItem(
      AI_PROVIDER_STORAGE_KEY,
      JSON.stringify(nextState),
    );

    return nextState;
  }
}

// TODO: Replace localStorage with the system Keychain / Credential Manager.
export const keyStore: KeyStore = new LocalStorageKeyStore();
