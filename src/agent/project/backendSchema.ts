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
const INTEGER_DEFAULT_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const NUMERIC_DEFAULT_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SUPABASE_COLUMN_TYPE_ALIASES: Record<string, SupabaseColumnType> = {
  bool: "boolean",
  float4: "numeric",
  float8: "numeric",
  int: "integer",
  int2: "integer",
  int4: "integer",
  int8: "bigint",
  smallint: "integer",
  timestamp: "timestamptz",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamptz",
};

export function isValidSupabaseIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function isSupportedSupabaseColumnType(
  value: string,
): value is SupabaseColumnType {
  return SUPPORTED_TYPE_SET.has(value);
}

export function normalizeSupabaseColumnType(value: string): SupabaseColumnType | null {
  const normalized = value.trim().toLowerCase();

  if (isSupportedSupabaseColumnType(normalized)) {
    return normalized;
  }

  return SUPABASE_COLUMN_TYPE_ALIASES[normalized] ?? null;
}

export function isSupportedSupabaseDefaultValue(
  value: string,
  dataType?: SupabaseColumnType,
): boolean {
  const trimmed = value.trim();

  if (!trimmed || trimmed === "none") {
    return true;
  }

  if (dataType === "integer" || dataType === "bigint") {
    return INTEGER_DEFAULT_PATTERN.test(trimmed);
  }

  if (dataType === "numeric") {
    return NUMERIC_DEFAULT_PATTERN.test(trimmed);
  }

  if (dataType) {
    return isCompatibleStaticSupabaseDefault(trimmed, dataType);
  }

  return SUPPORTED_DEFAULT_SET.has(trimmed) || NUMERIC_DEFAULT_PATTERN.test(trimmed);
}

function isCompatibleStaticSupabaseDefault(
  value: string,
  dataType: SupabaseColumnType,
): boolean {
  switch (dataType) {
    case "boolean":
      return value === "false" || value === "true";
    case "date":
      return value === "CURRENT_DATE";
    case "jsonb":
      return value === "'[]'::jsonb" || value === "'{}'::jsonb";
    case "text":
      return value === "''";
    case "timestamptz":
      return value === "now()";
    case "uuid":
      return value === "gen_random_uuid()";
    case "integer":
    case "bigint":
    case "numeric":
      return isSupportedSupabaseDefaultValue(value, dataType);
  }
}
