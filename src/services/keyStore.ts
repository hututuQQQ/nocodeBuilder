export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const DEEPSEEK_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;
export const VERCEL_DEPLOY_TARGETS = ["preview", "production"] as const;
export const DEFAULT_VERCEL_DEPLOY_TARGET = "preview";

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

export type VercelDeployTarget = (typeof VERCEL_DEPLOY_TARGETS)[number];

export type VercelConfig = {
  provider: "vercel";
  token: string;
  scope: string;
  projectName: string;
  defaultTarget: VercelDeployTarget;
  updatedAt: string;
};

export type VercelConfigInput = {
  token: string;
  scope?: string;
  projectName?: string;
  defaultTarget?: VercelDeployTarget;
};

export interface KeyStore {
  getDeepSeekConfig: () => Promise<DeepSeekConfig | null>;
  getVercelConfig: () => Promise<VercelConfig | null>;
  saveDeepSeekConfig: (config: DeepSeekConfigInput) => Promise<DeepSeekConfig>;
  saveVercelConfig: (config: VercelConfigInput) => Promise<VercelConfig>;
}

const DEEPSEEK_STORAGE_KEY = "ai-web-builder.deepseek-config.v1";
const VERCEL_STORAGE_KEY = "ai-web-builder.vercel-config.v1";

function isDeepSeekModel(value: string): value is DeepSeekModel {
  return DEEPSEEK_MODELS.some((model) => model === value);
}

function isVercelDeployTarget(value: string): value is VercelDeployTarget {
  return VERCEL_DEPLOY_TARGETS.some((target) => target === value);
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

function normalizeVercelConfig(config: VercelConfigInput): VercelConfig {
  return {
    provider: "vercel",
    token: config.token.trim(),
    scope: config.scope?.trim() ?? "",
    projectName: config.projectName?.trim() ?? "",
    defaultTarget: config.defaultTarget ?? DEFAULT_VERCEL_DEPLOY_TARGET,
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

function readStoredVercelConfig(value: string | null): VercelConfig | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<VercelConfig>;

    if (parsed.provider !== "vercel" || typeof parsed.token !== "string") {
      return null;
    }

    const defaultTarget =
      typeof parsed.defaultTarget === "string" &&
      isVercelDeployTarget(parsed.defaultTarget)
        ? parsed.defaultTarget
        : DEFAULT_VERCEL_DEPLOY_TARGET;

    return {
      provider: "vercel",
      token: parsed.token.trim(),
      scope: typeof parsed.scope === "string" ? parsed.scope.trim() : "",
      projectName:
        typeof parsed.projectName === "string" ? parsed.projectName.trim() : "",
      defaultTarget,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

class LocalStorageKeyStore implements KeyStore {
  async getDeepSeekConfig() {
    return readStoredConfig(window.localStorage.getItem(DEEPSEEK_STORAGE_KEY));
  }

  async getVercelConfig() {
    return readStoredVercelConfig(
      window.localStorage.getItem(VERCEL_STORAGE_KEY),
    );
  }

  async saveDeepSeekConfig(config: DeepSeekConfigInput) {
    const nextConfig = normalizeConfig(config);
    window.localStorage.setItem(DEEPSEEK_STORAGE_KEY, JSON.stringify(nextConfig));
    return nextConfig;
  }

  async saveVercelConfig(config: VercelConfigInput) {
    const nextConfig = normalizeVercelConfig(config);
    window.localStorage.setItem(VERCEL_STORAGE_KEY, JSON.stringify(nextConfig));
    return nextConfig;
  }
}

// TODO: Replace localStorage with the system Keychain / Credential Manager.
export const keyStore: KeyStore = new LocalStorageKeyStore();
