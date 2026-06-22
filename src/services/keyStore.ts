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
import {
  hasAiProviderSecret,
  readAppStorageValue,
  saveAiProviderSecret,
  writeAppStorageValue,
} from "./appStorage";

export const VERCEL_DEPLOY_TARGETS = ["preview", "production"] as const;
export const DEFAULT_VERCEL_DEPLOY_TARGET = "preview";

export type AiProviderConfig = {
  provider: AiProviderId;
  apiKeyConfigured: boolean;
  model: string;
  models: string[];
  baseUrl: string;
  updatedAt: string;
};

export type AiProviderConfigInput = {
  provider: AiProviderId;
  apiKey?: string;
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

type StoredAiProviderConfig = Omit<AiProviderConfig, "apiKeyConfigured">;
type StoredAiProviderConfigs = Partial<
  Record<AiProviderId, StoredAiProviderConfig>
>;
type StoredAiProviderState = {
  activeProvider: AiProviderId;
  configs: StoredAiProviderConfigs;
  updatedAt: string;
};

const AI_PROVIDER_STORAGE_ID = "ai-provider-config";

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

function createStoredConfig(
  config: AiProviderConfigInput,
): StoredAiProviderConfig {
  const provider = config.provider;
  const models = normalizeModelList(provider, config.models, config.model);
  const model =
    config.model && models.includes(config.model) ? config.model : models[0];

  return {
    provider,
    model,
    models,
    baseUrl: config.baseUrl.trim() || getDefaultAiBaseUrl(provider),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeStoredConfig(
  provider: AiProviderId,
  config: Partial<StoredAiProviderConfig> | undefined,
): StoredAiProviderConfig | null {
  if (!config) {
    return null;
  }

  const models = normalizeModelList(
    provider,
    Array.isArray(config.models) ? config.models : [],
    config.model,
  );
  const model =
    typeof config.model === "string" && models.includes(config.model)
      ? config.model
      : models[0];

  return {
    provider,
    model,
    models,
    baseUrl:
      typeof config.baseUrl === "string" && config.baseUrl.trim()
        ? config.baseUrl.trim()
        : getDefaultAiBaseUrl(provider),
    updatedAt:
      typeof config.updatedAt === "string" ? config.updatedAt : "",
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

async function hydrateStoredAiProviderState(
  state: Partial<StoredAiProviderState> | null,
): Promise<AiProviderState | null> {
  if (!state?.configs || typeof state.configs !== "object") {
    return null;
  }

  const configs: AiProviderConfigs = {};

  for (const provider of AI_PROVIDER_IDS) {
    const storedConfig = normalizeStoredConfig(provider, state.configs[provider]);

    if (!storedConfig) {
      continue;
    }

    let apiKeyConfigured = false;

    try {
      apiKeyConfigured = await hasAiProviderSecret(provider);
    } catch {
      apiKeyConfigured = false;
    }

    if (apiKeyConfigured) {
      configs[provider] = {
        ...storedConfig,
        apiKeyConfigured,
      };
    }
  }

  const fallbackActiveProvider =
    AI_PROVIDER_IDS.find((provider) => configs[provider]) ??
    DEFAULT_AI_PROVIDER;
  const activeProvider =
    typeof state.activeProvider === "string" &&
    isAiProviderId(state.activeProvider) &&
    configs[state.activeProvider]
      ? state.activeProvider
      : fallbackActiveProvider;

  if (!configs[activeProvider]) {
    return null;
  }

  return {
    activeProvider,
    configs,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
  };
}

function readStoredAiProviderState(value: unknown): StoredAiProviderState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = value as Partial<StoredAiProviderState>;

  if (!parsed.configs || typeof parsed.configs !== "object") {
    return null;
  }

  const configs: StoredAiProviderConfigs = {};

  for (const provider of AI_PROVIDER_IDS) {
    const storedConfig = normalizeStoredConfig(provider, parsed.configs[provider]);

    if (storedConfig) {
      configs[provider] = storedConfig;
    }
  }

  const activeProvider =
    typeof parsed.activeProvider === "string" &&
    isAiProviderId(parsed.activeProvider)
      ? parsed.activeProvider
      : DEFAULT_AI_PROVIDER;

  return {
    activeProvider,
    configs,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  };
}

async function readPersistedAiProviderState() {
  const storedState = readStoredAiProviderState(
    await readAppStorageValue<unknown>(AI_PROVIDER_STORAGE_ID),
  );
  return hydrateStoredAiProviderState(storedState);
}

function createStoredStateFromHydrated(
  state: AiProviderState,
): StoredAiProviderState {
  const configs: StoredAiProviderConfigs = {};

  for (const provider of AI_PROVIDER_IDS) {
    const config = state.configs[provider];

    if (!config) {
      continue;
    }

    configs[provider] = {
      provider: config.provider,
      model: config.model,
      models: config.models,
      baseUrl: config.baseUrl,
      updatedAt: config.updatedAt,
    };
  }

  return {
    activeProvider: state.activeProvider,
    configs,
    updatedAt: state.updatedAt,
  };
}

async function ensureProviderHasSecret(
  provider: AiProviderId,
  config: AiProviderConfigInput,
  currentState: AiProviderState,
) {
  const apiKey = config.apiKey?.trim();

  if (apiKey) {
    await saveAiProviderSecret(provider, apiKey);
    return;
  }

  if (currentState.configs[provider]?.apiKeyConfigured) {
    return;
  }

  if (await hasAiProviderSecret(provider)) {
    return;
  }

  throw new Error(`API key is required for ${getAiProviderDefinition(provider).label}.`);
}

class RustKeyStore implements KeyStore {
  async getAiProviderState() {
    const currentState = await readPersistedAiProviderState();

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

    for (const config of configs) {
      await ensureProviderHasSecret(config.provider, config, currentState);
    }

    const currentStoredState = createStoredStateFromHydrated(currentState);
    const mergedConfigs: StoredAiProviderConfigs = {
      ...currentStoredState.configs,
    };

    for (const config of configs) {
      mergedConfigs[config.provider] = createStoredConfig(config);
    }

    const lastConfig = configs[configs.length - 1];
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
    const nextState: StoredAiProviderState = {
      activeProvider: nextActiveProvider,
      configs: mergedConfigs,
      updatedAt: new Date().toISOString(),
    };

    await writeAppStorageValue(AI_PROVIDER_STORAGE_ID, nextState);

    return (await hydrateStoredAiProviderState(nextState)) ??
      createEmptyAiProviderState();
  }
}

export const keyStore: KeyStore = new RustKeyStore();
