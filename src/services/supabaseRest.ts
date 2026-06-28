import { invoke } from "@tauri-apps/api/core";
import type { ProjectSupabaseConfig } from "./projectEnv";

export type SupabaseColumn = {
  format?: string;
  name: string;
  nullable: boolean;
  required: boolean;
  type: string;
};

export type SupabaseTable = {
  columns: SupabaseColumn[];
  name: string;
  primaryKeys: string[];
};

export type SupabaseRow = Record<string, unknown>;

export type SupabaseRowPage = {
  count: number | null;
  rows: SupabaseRow[];
};

export type SupabaseListRowsOptions = {
  page: number;
  pageSize: number;
  search?: string;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  table: SupabaseTable;
};

export type SupabaseCreateTableColumn = {
  dataType: string;
  defaultValue?: string;
  name: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
};

export type SupabaseCreateTableInput = {
  columns: SupabaseCreateTableColumn[];
  enableRls: boolean;
  tableName: string;
};

export type SupabaseAlterTableOperation =
  | { kind: "addColumn"; column: Omit<SupabaseCreateTableColumn, "primaryKey"> }
  | { kind: "dropColumn"; name: string }
  | { kind: "renameColumn"; oldName: string; newName: string }
  | { kind: "setColumnType"; dataType: string; name: string }
  | { kind: "setColumnNullable"; name: string; nullable: boolean }
  | { kind: "setColumnDefault"; dataType: string; defaultValue?: string | null; name: string };

export type SupabaseAlterTableInput = {
  operations: SupabaseAlterTableOperation[];
  tableName: string;
};

type OpenApiDocument = {
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
  definitions?: Record<string, OpenApiSchema>;
  paths?: Record<string, unknown>;
};

type OpenApiSchema = {
  properties?: Record<string, OpenApiProperty>;
  required?: string[];
};

type OpenApiProperty = {
  format?: string;
  nullable?: boolean;
  readOnly?: boolean;
  type?: string | string[];
};

type SupabaseResponseLike = {
  headers: Headers;
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
};

type SupabaseProxyHeader = {
  name: string;
  value: string;
};

type SupabaseProxyResponse = {
  body: string;
  headers: SupabaseProxyHeader[];
  status: number;
};

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORWARDED_HEADERS = new Set(["accept", "content-type", "prefer", "range"]);

export class SupabaseRestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseRestError";
    this.status = status;
  }
}

export class SupabaseRestClient {
  private config: ProjectSupabaseConfig;

  constructor(config: ProjectSupabaseConfig) {
    this.config = config;
  }

  async testConnection() {
    await this.fetchOpenApi();
    return true;
  }

  async testDatabaseConnection() {
    if (!this.config.dbUrl.trim()) {
      return true;
    }

    await invoke<void>("test_supabase_database_url", {
      request: {
        dbUrl: this.config.dbUrl,
      },
    });

    return true;
  }

  async listTables(): Promise<SupabaseTable[]> {
    const document = await this.fetchOpenApi();
    const pathNames = new Set(
      Object.keys(document.paths ?? {})
        .map((path) => path.replace(/^\//, ""))
        .filter((path) => TABLE_NAME_PATTERN.test(path)),
    );
    const schemas = document.definitions ?? document.components?.schemas ?? {};
    const tables = Object.entries(schemas)
      .filter(([name, schema]) => pathNames.has(name) && schema.properties)
      .map(([name, schema]) => createTableFromSchema(name, schema));

    return tables.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listRows(options: SupabaseListRowsOptions): Promise<SupabaseRowPage> {
    const url = this.createTableUrl(options.table.name);
    url.searchParams.set("select", "*");

    if (options.search?.trim()) {
      const search = escapePostgrestPattern(options.search.trim());
      const searchableColumns = options.table.columns.filter(isSearchableColumn);

      if (searchableColumns.length > 0) {
        url.searchParams.set(
          "or",
          `(${searchableColumns
            .slice(0, 8)
            .map((column) => `${column.name}.ilike.*${search}*`)
            .join(",")})`,
        );
      }
    }

    if (options.sortColumn) {
      url.searchParams.set(
        "order",
        `${options.sortColumn}.${options.sortDirection ?? "asc"}.nullslast`,
      );
    }

    const start = Math.max(options.page, 0) * options.pageSize;
    const end = start + options.pageSize - 1;
    const response = await this.request(url, {
      headers: {
        Prefer: "count=exact",
        Range: `${start}-${end}`,
      },
    });
    const rows = (await response.json()) as SupabaseRow[];

    return {
      count: parseContentRangeCount(response.headers.get("content-range")),
      rows,
    };
  }

  async insertRow(table: SupabaseTable, row: SupabaseRow) {
    const url = this.createTableUrl(table.name);
    const response = await this.request(url, {
      body: JSON.stringify(row),
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      method: "POST",
    });

    return (await response.json()) as SupabaseRow[];
  }

  async updateRow(table: SupabaseTable, originalRow: SupabaseRow, nextRow: SupabaseRow) {
    const url = this.createTableUrl(table.name);
    applyRowIdentityFilters(url, table, originalRow);

    const response = await this.request(url, {
      body: JSON.stringify(nextRow),
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      method: "PATCH",
    });

    return (await response.json()) as SupabaseRow[];
  }

  async deleteRow(table: SupabaseTable, row: SupabaseRow) {
    const url = this.createTableUrl(table.name);
    applyRowIdentityFilters(url, table, row);

    await this.request(url, {
      method: "DELETE",
    });
  }

  async createTable(input: SupabaseCreateTableInput) {
    if (!this.config.dbUrl.trim()) {
      throw new SupabaseRestError(
        "Enter SUPABASE_DB_URL in Supabase settings before creating tables.",
        400,
      );
    }

    await invoke<void>("create_supabase_table", {
      request: {
        columns: input.columns,
        dbUrl: this.config.dbUrl,
        enableRls: input.enableRls,
        schema: this.config.schema,
        tableName: input.tableName,
      },
    });
  }

  async dropTable(tableName: string) {
    this.requireDatabaseUrl("deleting tables");

    await invoke<void>("drop_supabase_table", {
      request: {
        dbUrl: this.config.dbUrl,
        schema: this.config.schema,
        tableName,
      },
    });
  }

  async alterTable(input: SupabaseAlterTableInput) {
    this.requireDatabaseUrl("editing table columns");

    if (input.operations.length === 0) {
      return;
    }

    await invoke<void>("alter_supabase_table", {
      request: {
        dbUrl: this.config.dbUrl,
        operations: input.operations,
        schema: this.config.schema,
        tableName: input.tableName,
      },
    });
  }

  private async fetchOpenApi() {
    const url = new URL("rest/v1/", `${this.config.url}/`);
    const response = await this.request(url, {
      headers: {
        Accept: "application/openapi+json",
      },
    });

    return (await response.json()) as OpenApiDocument;
  }

  private createTableUrl(tableName: string) {
    return new URL(`rest/v1/${encodeURIComponent(tableName)}`, `${this.config.url}/`);
  }

  private async request(url: URL, init: RequestInit = {}): Promise<SupabaseResponseLike> {
    const apiKey = this.getDashboardApiKey();
    const headers = new Headers(init.headers);
    const response = await invoke<SupabaseProxyResponse>("supabase_proxy_request", {
      request: {
        apiKey,
        baseUrl: this.config.url,
        body: parseRequestBody(init.body),
        headers: forwardedHeaders(headers),
        method: init.method ?? "GET",
        path: url.pathname.replace(/^\/+/, ""),
        query: Array.from(url.searchParams.entries()).map(([key, value]) => ({ key, value })),
        schema: this.config.schema,
      },
    });
    const proxiedResponse = createProxyResponse(response);

    if (!proxiedResponse.ok) {
      throw new SupabaseRestError(
        await readSupabaseError(proxiedResponse),
        proxiedResponse.status,
      );
    }

    return proxiedResponse;
  }

  private getDashboardApiKey() {
    const apiKey = this.config.secretKey.trim();

    if (!apiKey) {
      throw new SupabaseRestError(
        "Enter SUPABASE_SECRET_KEY for the database dashboard. The publishable key is only for generated apps.",
        401,
      );
    }

    return apiKey;
  }

  private requireDatabaseUrl(action: string) {
    if (!this.config.dbUrl.trim()) {
      throw new SupabaseRestError(
        `Enter SUPABASE_DB_URL in Supabase settings before ${action}.`,
        400,
      );
    }
  }
}

function forwardedHeaders(headers: Headers) {
  return Array.from(headers.entries())
    .filter(([name]) => FORWARDED_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
}

function parseRequestBody(body: BodyInit | null | undefined) {
  if (typeof body === "undefined" || body === null) {
    return undefined;
  }

  if (typeof body !== "string") {
    throw new SupabaseRestError("Supabase request body must be JSON.", 400);
  }

  if (!body.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SupabaseRestError("Supabase request body must be valid JSON.", 400);
  }
}

function createProxyResponse(response: SupabaseProxyResponse): SupabaseResponseLike {
  return {
    headers: new Headers(
      response.headers.map((header): [string, string] => [
        header.name,
        header.value,
      ]),
    ),
    json: async () => {
      if (!response.body.trim()) {
        return null;
      }

      return JSON.parse(response.body) as unknown;
    },
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
  };
}

function createTableFromSchema(name: string, schema: OpenApiSchema): SupabaseTable {
  const required = new Set(schema.required ?? []);
  const columns = Object.entries(schema.properties ?? {}).map(([columnName, property]) => ({
    format: property.format,
    name: columnName,
    nullable: Boolean(property.nullable),
    required: required.has(columnName),
    type: normalizeOpenApiType(property.type),
  }));

  return {
    columns,
    name,
    primaryKeys: inferPrimaryKeys(name, columns),
  };
}

function normalizeOpenApiType(type: string | string[] | undefined) {
  if (Array.isArray(type)) {
    return type.filter((item) => item !== "null").join(" | ") || "unknown";
  }

  return type ?? "unknown";
}

function inferPrimaryKeys(tableName: string, columns: SupabaseColumn[]) {
  const names = columns.map((column) => column.name);
  const candidates = ["id", `${tableName}_id`, "uuid"];
  const primaryKey = candidates.find((candidate) => names.includes(candidate));

  return primaryKey ? [primaryKey] : [];
}

function isSearchableColumn(column: SupabaseColumn) {
  return column.type === "string" || column.format === "text" || column.format === "uuid";
}

function escapePostgrestPattern(value: string) {
  return value.replace(/[,*]/g, " ").trim();
}

function parseContentRangeCount(value: string | null) {
  if (!value) {
    return null;
  }

  const countText = value.split("/")[1];
  const count = Number(countText);

  return Number.isFinite(count) ? count : null;
}

function applyRowIdentityFilters(url: URL, table: SupabaseTable, row: SupabaseRow) {
  const identityColumns = table.primaryKeys.length > 0
    ? table.primaryKeys
    : table.columns
        .map((column) => column.name)
        .filter((name) => isFilterableValue(row[name]))
        .slice(0, 8);

  for (const columnName of identityColumns) {
    const value = row[columnName];

    if (value === null) {
      url.searchParams.set(columnName, "is.null");
    } else if (typeof value !== "undefined") {
      url.searchParams.set(columnName, `eq.${String(value)}`);
    }
  }
}

function isFilterableValue(value: unknown) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

async function readSupabaseError(response: SupabaseResponseLike) {
  try {
    const body = (await response.json()) as { message?: string; details?: string };
    return body.message || body.details || `Supabase request failed with ${response.status}`;
  } catch {
    return `Supabase request failed with ${response.status}`;
  }
}

