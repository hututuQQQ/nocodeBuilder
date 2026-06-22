import { DEFAULT_VERCEL_DEPLOY_TARGET, type VercelDeployTarget } from "./keyStore";
import { getProjectErrorMessage, projectApi } from "./projects";

export const PROJECT_ENV_PATH = ".env";

export type ProjectSupabaseConfig = {
  provider: "supabase";
  url: string;
  anonKey: string;
  secretKey: string;
  dbUrl: string;
  schema: string;
  updatedAt: string;
};

export type ProjectSupabaseConfigInput = {
  anonKey: string;
  dbUrl?: string;
  schema?: string;
  secretKey: string;
  url: string;
};

export type ProjectVercelConfig = {
  provider: "vercel";
  token: string;
  scope: string;
  projectName: string;
  defaultTarget: VercelDeployTarget;
  updatedAt: string;
};

export type ProjectVercelConfigInput = {
  defaultTarget?: VercelDeployTarget;
  projectName?: string;
  scope?: string;
  token: string;
};

export type ProjectEnvConfig = {
  supabase: ProjectSupabaseConfig | null;
  vercel: ProjectVercelConfig | null;
};

type EnvEntry =
  | { kind: "line"; raw: string }
  | { kind: "var"; key: string; value: string };

const SUPABASE_URL_KEY = "NEXT_PUBLIC_SUPABASE_URL";
const SUPABASE_ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const SUPABASE_PUBLISHABLE_KEY = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const SUPABASE_SECRET_KEY = "SUPABASE_SECRET_KEY";
const SUPABASE_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY";
const SUPABASE_DB_URL_KEY = "SUPABASE_DB_URL";
const SUPABASE_SCHEMA_KEY = "SUPABASE_SCHEMA";
const VERCEL_TOKEN_KEY = "VERCEL_TOKEN";
const VERCEL_SCOPE_KEY = "VERCEL_SCOPE";
const VERCEL_PROJECT_NAME_KEY = "VERCEL_PROJECT_NAME";
const VERCEL_DEPLOY_TARGET_KEY = "VERCEL_DEPLOY_TARGET";

export async function loadProjectEnvConfig(projectId: string): Promise<ProjectEnvConfig> {
  const content = await readProjectEnvFile(projectId);
  const values = parseEnvValues(content);
  const supabaseUrl = values[SUPABASE_URL_KEY] ?? "";
  const supabaseAnonKey = values[SUPABASE_ANON_KEY] ?? values[SUPABASE_PUBLISHABLE_KEY] ?? "";
  const supabaseSecretKey = values[SUPABASE_SECRET_KEY] ?? values[SUPABASE_SERVICE_ROLE_KEY] ?? "";
  const supabaseDbUrl = values[SUPABASE_DB_URL_KEY] ?? "";
  const vercelToken = values[VERCEL_TOKEN_KEY] ?? "";

  return {
    supabase:
      supabaseUrl && (supabaseAnonKey || supabaseSecretKey)
        ? {
            provider: "supabase",
            url: normalizeUrl(supabaseUrl),
            anonKey: supabaseAnonKey,
            secretKey: supabaseSecretKey,
            dbUrl: supabaseDbUrl,
            schema: values[SUPABASE_SCHEMA_KEY] || "public",
            updatedAt: "",
          }
        : null,
    vercel: vercelToken
      ? {
          provider: "vercel",
          token: vercelToken,
          scope: values[VERCEL_SCOPE_KEY] ?? "",
          projectName: values[VERCEL_PROJECT_NAME_KEY] ?? "",
          defaultTarget: isVercelDeployTarget(values[VERCEL_DEPLOY_TARGET_KEY])
            ? values[VERCEL_DEPLOY_TARGET_KEY]
            : DEFAULT_VERCEL_DEPLOY_TARGET,
          updatedAt: "",
        }
      : null,
  };
}

export async function saveProjectSupabaseConfig(
  projectId: string,
  config: ProjectSupabaseConfigInput,
): Promise<ProjectSupabaseConfig> {
  const content = await readProjectEnvFile(projectId);
  const nextConfig: ProjectSupabaseConfig = {
    provider: "supabase",
    url: normalizeUrl(config.url),
    anonKey: config.anonKey.trim(),
    secretKey: config.secretKey.trim(),
    dbUrl: config.dbUrl?.trim() ?? "",
    schema: config.schema?.trim() || "public",
    updatedAt: new Date().toISOString(),
  };
  const nextContent = upsertEnvValues(content, {
    [SUPABASE_URL_KEY]: nextConfig.url,
    [SUPABASE_ANON_KEY]: nextConfig.anonKey,
    [SUPABASE_SECRET_KEY]: nextConfig.secretKey,
    [SUPABASE_DB_URL_KEY]: nextConfig.dbUrl,
    [SUPABASE_SCHEMA_KEY]: nextConfig.schema,
  });

  await projectApi.writeFile(projectId, PROJECT_ENV_PATH, nextContent);
  return nextConfig;
}

export async function saveProjectVercelConfig(
  projectId: string,
  config: ProjectVercelConfigInput,
): Promise<ProjectVercelConfig> {
  const content = await readProjectEnvFile(projectId);
  const nextConfig: ProjectVercelConfig = {
    provider: "vercel",
    token: config.token.trim(),
    scope: config.scope?.trim() ?? "",
    projectName: config.projectName?.trim() ?? "",
    defaultTarget: config.defaultTarget ?? DEFAULT_VERCEL_DEPLOY_TARGET,
    updatedAt: new Date().toISOString(),
  };
  const nextContent = upsertEnvValues(content, {
    [VERCEL_TOKEN_KEY]: nextConfig.token,
    [VERCEL_SCOPE_KEY]: nextConfig.scope,
    [VERCEL_PROJECT_NAME_KEY]: nextConfig.projectName,
    [VERCEL_DEPLOY_TARGET_KEY]: nextConfig.defaultTarget,
  });

  await projectApi.writeFile(projectId, PROJECT_ENV_PATH, nextContent);
  return nextConfig;
}

async function readProjectEnvFile(projectId: string) {
  try {
    return await projectApi.readFile(projectId, PROJECT_ENV_PATH);
  } catch (error) {
    if (getProjectErrorMessage(error).toLowerCase().includes("not found")) {
      return "";
    }

    throw error;
  }
}

function parseEnvValues(content: string) {
  const values: Record<string, string> = {};

  for (const entry of parseEnvEntries(content)) {
    if (entry.kind === "var") {
      values[entry.key] = entry.value;
    }
  }

  return values;
}

function upsertEnvValues(content: string, updates: Record<string, string>) {
  const entries = parseEnvEntries(content);
  const handledKeys = new Set<string>();
  const nextEntries = entries.map((entry) => {
    if (entry.kind !== "var" || !(entry.key in updates)) {
      return entryToLine(entry);
    }

    handledKeys.add(entry.key);
    return `${entry.key}=${formatEnvValue(updates[entry.key])}`;
  });
  const missingLines = Object.entries(updates)
    .filter(([key]) => !handledKeys.has(key))
    .map(([key, value]) => `${key}=${formatEnvValue(value)}`);

  if (missingLines.length > 0 && nextEntries.some((line) => line.trim())) {
    nextEntries.push("");
  }

  const nextContent = [...nextEntries, ...missingLines].join("\n").replace(/\n{3,}/g, "\n\n");
  return `${nextContent.trimEnd()}\n`;
}

function parseEnvEntries(content: string): EnvEntry[] {
  return content.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);

    if (!match) {
      return { kind: "line", raw: line };
    }

    return {
      kind: "var",
      key: match[1],
      value: parseEnvValue(match[2]),
    };
  });
}

function entryToLine(entry: EnvEntry) {
  return entry.kind === "line" ? entry.raw : `${entry.key}=${formatEnvValue(entry.value)}`;
}

function parseEnvValue(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function formatEnvValue(value: string) {
  const trimmed = value.trim();

  if (!trimmed || /\s|#|"|'/.test(trimmed)) {
    return JSON.stringify(trimmed);
  }

  return trimmed;
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

function isVercelDeployTarget(value: string | undefined): value is VercelDeployTarget {
  return value === "preview" || value === "production";
}


