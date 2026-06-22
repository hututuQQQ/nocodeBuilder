export const SUPPORTED_SUPABASE_COLUMN_TYPES = [
  "bigint",
  "boolean",
  "date",
  "integer",
  "jsonb",
  "numeric",
  "text",
  "timestamptz",
  "uuid",
] as const;

export const SUPPORTED_SUPABASE_DEFAULT_VALUES = [
  "false",
  "true",
  "CURRENT_DATE",
  "0",
  "'[]'::jsonb",
  "'{}'::jsonb",
  "''",
  "now()",
  "gen_random_uuid()",
] as const;

export type SupabaseColumnType = typeof SUPPORTED_SUPABASE_COLUMN_TYPES[number];

export type AgentSupabaseSchemaColumn = {
  dataType: SupabaseColumnType;
  defaultValue?: string;
  name: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
};

export type AgentSupabaseSchemaTable = {
  columns: AgentSupabaseSchemaColumn[];
  enableRls: boolean;
  name: string;
};

export type AgentSupabaseSchemaInput = {
  summary: string;
  tables: AgentSupabaseSchemaTable[];
};

const SUPPORTED_TYPE_SET = new Set<string>(SUPPORTED_SUPABASE_COLUMN_TYPES);
const SUPPORTED_DEFAULT_SET = new Set<string>(SUPPORTED_SUPABASE_DEFAULT_VALUES);

export function isValidSupabaseIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function isSupportedSupabaseColumnType(
  value: string,
): value is SupabaseColumnType {
  return SUPPORTED_TYPE_SET.has(value);
}

export function isSupportedSupabaseDefaultValue(value: string) {
  const trimmed = value.trim();
  return !trimmed || trimmed === "none" || SUPPORTED_DEFAULT_SET.has(trimmed);
}
