import { loadProjectEnvConfig } from "../../services/projectEnv";
import { getProjectErrorMessage } from "../../services/projects";
import {
  SupabaseRestClient,
  type SupabaseCreateTableColumn,
  type SupabaseTable,
} from "../../services/supabaseRest";
import type { AgentSupabaseSchemaInput } from "./backendSchema";

const MAX_CONTEXT_TABLES = 20;
const MAX_CONTEXT_COLUMNS = 24;

const BACKEND_INTENT_PATTERN = new RegExp(
  [
    "backend",
    "back-end",
    "database",
    "db",
    "supabase",
    "api route",
    "route handler",
    "server action",
    "auth",
    "login",
    "sign in",
    "signup",
    "order",
    "admin",
    "crud",
    "persist",
    "save data",
    "\\u540e\\u7aef",
    "\\u6570\\u636e\\u5e93",
    "\\u6570\\u636e\\u8868",
    "\\u63a5\\u53e3",
    "\\u767b\\u5f55",
    "\\u6ce8\\u518c",
    "\\u8ba4\\u8bc1",
    "\\u6743\\u9650",
    "\\u8ba2\\u5355",
    "\\u540e\\u53f0",
    "\\u7ba1\\u7406",
    "\\u589e\\u5220\\u6539\\u67e5",
    "\\u6301\\u4e45\\u5316",
    "\\u4fdd\\u5b58\\u6570\\u636e",
  ].join("|"),
  "i",
);

export type ProjectBackendContext = {
  recommendedPatterns: string[];
  supabase: SupabaseBackendContext;
};

export type SupabaseBackendContext = {
  configured: boolean;
  env: {
    anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY";
    dbUrl: "SUPABASE_DB_URL";
    schema: "SUPABASE_SCHEMA";
    secretKey: "SUPABASE_SECRET_KEY";
    url: "NEXT_PUBLIC_SUPABASE_URL";
  };
  notes: string[];
  schema: string;
  schemaLoadError?: string;
  schemaLoadStatus: "loaded" | "not_configured" | "skipped" | "unavailable";
  status: {
    anonKeyConfigured: boolean;
    dbUrlConfigured: boolean;
    secretKeyConfigured: boolean;
    urlConfigured: boolean;
  };
  tables: SanitizedSupabaseTable[];
};

export type SanitizedSupabaseTable = {
  columns: Array<{
    format?: string;
    name: string;
    nullable: boolean;
    required: boolean;
    type: string;
  }>;
  name: string;
  primaryKeys: string[];
};

export type ApplySupabaseSchemaResult = {
  alteredTables: Array<{ addedColumns: string[]; name: string }>;
  createdTables: string[];
  finalSchema: SanitizedSupabaseTable[];
  skipped: string[];
};

export function hasBackendIntent(value: string) {
  return BACKEND_INTENT_PATTERN.test(value);
}

export async function buildProjectBackendContext(
  projectId: string,
  options: { includeSchema?: boolean } = {},
): Promise<ProjectBackendContext> {
  const config = (await loadProjectEnvConfig(projectId)).supabase;
  const supabase: SupabaseBackendContext = {
    configured: Boolean(config),
    env: {
      anonKey: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      dbUrl: "SUPABASE_DB_URL",
      schema: "SUPABASE_SCHEMA",
      secretKey: "SUPABASE_SECRET_KEY",
      url: "NEXT_PUBLIC_SUPABASE_URL",
    },
    notes: [
      "Use the env variable names only; secret values are intentionally not provided.",
      "Use SUPABASE_SECRET_KEY only in App Router route handlers, server actions, or server-only modules.",
      "Use client components through your own /api routes when writes or privileged reads are needed.",
    ],
    schema: config?.schema ?? "public",
    schemaLoadStatus: config ? "skipped" : "not_configured",
    status: {
      anonKeyConfigured: Boolean(config?.anonKey.trim()),
      dbUrlConfigured: Boolean(config?.dbUrl.trim()),
      secretKeyConfigured: Boolean(config?.secretKey.trim()),
      urlConfigured: Boolean(config?.url.trim()),
    },
    tables: [],
  };

  if (config && options.includeSchema) {
    if (!config.secretKey.trim()) {
      supabase.schemaLoadStatus = "unavailable";
      supabase.schemaLoadError =
        "SUPABASE_SECRET_KEY is not configured, so tables cannot be inspected.";
    } else {
      try {
        const tables = await new SupabaseRestClient(config).listTables();
        supabase.tables = sanitizeTables(tables);
        supabase.schemaLoadStatus = "loaded";
      } catch (error) {
        supabase.schemaLoadStatus = "unavailable";
        supabase.schemaLoadError = getProjectErrorMessage(error);
      }
    }
  }

  return {
    recommendedPatterns: [
      "For real backend work, prefer Next.js App Router route handlers under app/api/**/route.ts.",
      "Keep Supabase secret access on the server. Browser code should call app-owned API routes.",
      "If schema changes are needed, use apply_supabase_schema for non-destructive table/column creation when SUPABASE_DB_URL is configured.",
      "Do not create .env files or include credentials in generated files.",
    ],
    supabase,
  };
}

export async function applySupabaseSchema(
  projectId: string,
  input: AgentSupabaseSchemaInput,
): Promise<ApplySupabaseSchemaResult> {
  const config = (await loadProjectEnvConfig(projectId)).supabase;

  if (!config) {
    throw new Error("Supabase is not configured for this project.");
  }

  if (!config.secretKey.trim()) {
    throw new Error("SUPABASE_SECRET_KEY is required before applying schema.");
  }

  if (!config.dbUrl.trim()) {
    throw new Error("SUPABASE_DB_URL is required before applying schema.");
  }

  const client = new SupabaseRestClient(config);
  const existingTables = await client.listTables();
  const existingByName = new Map(existingTables.map((table) => [table.name, table]));
  const createdTables: string[] = [];
  const alteredTables: Array<{ addedColumns: string[]; name: string }> = [];
  const skipped: string[] = [];

  for (const table of input.tables) {
    const existingTable = existingByName.get(table.name);

    if (!existingTable) {
      await client.createTable({
        columns: table.columns.map(toCreateColumn),
        enableRls: table.enableRls,
        tableName: table.name,
      });
      createdTables.push(table.name);
      continue;
    }

    const existingColumnNames = new Set(
      existingTable.columns.map((column) => column.name),
    );
    const columnsToAdd = table.columns.filter(
      (column) => !existingColumnNames.has(column.name),
    );

    if (columnsToAdd.length === 0) {
      skipped.push(`${table.name}: all requested columns already exist`);
      continue;
    }

    await client.alterTable({
      operations: columnsToAdd.map((column) => ({
        column: toAlterColumn(column),
        kind: "addColumn" as const,
      })),
      tableName: table.name,
    });
    alteredTables.push({
      addedColumns: columnsToAdd.map((column) => column.name),
      name: table.name,
    });
  }

  const finalTables = await client.listTables();

  return {
    alteredTables,
    createdTables,
    finalSchema: sanitizeTables(finalTables),
    skipped,
  };
}

function sanitizeTables(tables: SupabaseTable[]): SanitizedSupabaseTable[] {
  return tables
    .slice(0, MAX_CONTEXT_TABLES)
    .map((table) => ({
      columns: table.columns.slice(0, MAX_CONTEXT_COLUMNS).map((column) => ({
        format: column.format,
        name: column.name,
        nullable: column.nullable,
        required: column.required,
        type: column.type,
      })),
      name: table.name,
      primaryKeys: table.primaryKeys,
    }));
}

function toCreateColumn(
  column: AgentSupabaseSchemaInput["tables"][number]["columns"][number],
): SupabaseCreateTableColumn {
  return {
    dataType: column.dataType,
    defaultValue: normalizeDefaultValue(column.defaultValue),
    name: column.name,
    nullable: column.primaryKey ? false : column.nullable,
    primaryKey: column.primaryKey,
    unique: column.primaryKey ? false : column.unique,
  };
}

function toAlterColumn(
  column: AgentSupabaseSchemaInput["tables"][number]["columns"][number],
) {
  return {
    dataType: column.dataType,
    defaultValue: normalizeDefaultValue(column.defaultValue),
    name: column.name,
    nullable: column.primaryKey ? false : column.nullable,
    unique: column.unique || column.primaryKey,
  };
}

function normalizeDefaultValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "none" ? trimmed : undefined;
}
