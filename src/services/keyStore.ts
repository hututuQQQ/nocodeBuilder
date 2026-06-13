export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const DEEPSEEK_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

export const DEEPSEEK_MODEL_OPTIONS: Array<{
  value: DeepSeekModel;
  label: string;
  description: string;
}> = [
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
];

export type DeepSeekConfig = {
  provider: "deepseek";
  apiKey: string;
  model: DeepSeekModel;
  baseUrl: string;
  updatedAt: string;
};

export type DeepSeekConfigInput = {
  apiKey: string;
  model: DeepSeekModel;
  baseUrl: string;
};

export interface KeyStore {
  getDeepSeekConfig: () => Promise<DeepSeekConfig | null>;
  saveDeepSeekConfig: (config: DeepSeekConfigInput) => Promise<DeepSeekConfig>;
}

const STORAGE_KEY = "ai-web-builder.deepseek-config.v1";

function isDeepSeekModel(value: string): value is DeepSeekModel {
  return DEEPSEEK_MODELS.some((model) => model === value);
}

function normalizeConfig(config: DeepSeekConfigInput): DeepSeekConfig {
  return {
    provider: "deepseek",
    apiKey: config.apiKey.trim(),
    model: config.model,
    baseUrl: config.baseUrl.trim() || DEFAULT_DEEPSEEK_BASE_URL,
    updatedAt: new Date().toISOString(),
  };
}

function readStoredConfig(value: string | null): DeepSeekConfig | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<DeepSeekConfig>;

    if (
      parsed.provider !== "deepseek" ||
      typeof parsed.apiKey !== "string" ||
      !parsed.apiKey.trim() ||
      typeof parsed.model !== "string" ||
      !isDeepSeekModel(parsed.model)
    ) {
      return null;
    }

    return {
      provider: "deepseek",
      apiKey: parsed.apiKey.trim(),
      model: parsed.model,
      baseUrl:
        typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
          ? parsed.baseUrl.trim()
          : DEFAULT_DEEPSEEK_BASE_URL,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

class LocalStorageKeyStore implements KeyStore {
  async getDeepSeekConfig() {
    return readStoredConfig(window.localStorage.getItem(STORAGE_KEY));
  }

  async saveDeepSeekConfig(config: DeepSeekConfigInput) {
    const nextConfig = normalizeConfig(config);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
    return nextConfig;
  }
}

// TODO: Replace localStorage with the system Keychain / Credential Manager.
export const keyStore: KeyStore = new LocalStorageKeyStore();
