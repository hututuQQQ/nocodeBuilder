use std::time::Duration;

use reqwest::{header::HeaderName, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, Executor};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseProxyRequest {
    pub base_url: String,
    pub api_key: String,
    pub schema: String,
    pub method: String,
    pub path: String,
    pub query: Vec<SupabaseProxyQueryParam>,
    pub headers: Vec<SupabaseProxyHeader>,
    pub body: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseProxyQueryParam {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseProxyHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<SupabaseProxyHeader>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseCreateTableRequest {
    pub db_url: String,
    pub schema: String,
    pub table_name: String,
    pub columns: Vec<SupabaseCreateTableColumn>,
    pub enable_rls: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseCreateTableColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseDropTableRequest {
    pub db_url: String,
    pub schema: String,
    pub table_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseAlterTableRequest {
    pub db_url: String,
    pub schema: String,
    pub table_name: String,
    pub operations: Vec<SupabaseAlterTableOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SupabaseAlterTableOperation {
    AddColumn {
        column: SupabaseAlterTableColumn,
    },
    DropColumn {
        name: String,
    },
    RenameColumn {
        #[serde(rename = "oldName")]
        old_name: String,
        #[serde(rename = "newName")]
        new_name: String,
    },
    SetColumnType {
        name: String,
        #[serde(rename = "dataType")]
        data_type: String,
    },
    SetColumnNullable {
        name: String,
        nullable: bool,
    },
    SetColumnDefault {
        name: String,
        #[serde(rename = "dataType")]
        data_type: String,
        #[serde(rename = "defaultValue")]
        default_value: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseAlterTableColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub unique: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseDatabaseUrlRequest {
    pub db_url: String,
}

pub async fn supabase_proxy_request(
    request: SupabaseProxyRequest,
) -> Result<SupabaseProxyResponse, String> {
    let api_key = normalize_required(&request.api_key, "supabase: secret key is required")?;
    let schema = normalize_required(&request.schema, "supabase: schema is required")?;
    let method = parse_method(&request.method)?;
    let url = build_supabase_url(&request.base_url, &request.path, &request.query)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "supabase: failed to create HTTP client".to_string())?;
    let mut builder = client
        .request(method, url)
        .header("apikey", api_key.as_str())
        .header("Accept-Profile", schema.as_str())
        .header("Content-Profile", schema.as_str());

    if is_legacy_jwt_key(&api_key) {
        builder = builder.bearer_auth(api_key.as_str());
    }

    for header in request.headers {
        if is_allowed_forward_header(&header.name) {
            builder = builder.header(header.name.as_str(), header.value.as_str());
        }
    }

    if let Some(body) = request.body {
        builder = builder.json(&body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("supabase: network request failed: {error}"))?;
    let status = response.status().as_u16();
    let headers = response_headers(response.headers());
    let body = response
        .text()
        .await
        .map_err(|error| format!("supabase: failed to read response: {error}"))?;

    Ok(SupabaseProxyResponse {
        status,
        body,
        headers,
    })
}

pub async fn create_supabase_table(request: SupabaseCreateTableRequest) -> Result<(), String> {
    let db_url = normalize_required(&request.db_url, "supabase: database URL is required")?;
    let schema = validate_identifier(&request.schema, "schema")?;
    let table_name = validate_identifier(&request.table_name, "table name")?;

    if request.columns.is_empty() {
        return Err("supabase: table needs at least one column".to_string());
    }

    let create_schema_sql = format!("create schema if not exists {}", quote_ident(&schema));
    let create_table_sql = build_create_table_sql(&schema, &table_name, &request.columns)?;
    let qualified_table = format!("{}.{}", quote_ident(&schema), quote_ident(&table_name));
    let pool = connect_database(&db_url).await?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("supabase: failed to start database transaction: {error}"))?;

    tx.execute(create_schema_sql.as_str())
        .await
        .map_err(|error| format!("supabase: failed to create schema: {error}"))?;
    tx.execute(create_table_sql.as_str())
        .await
        .map_err(|error| format!("supabase: failed to create table: {error}"))?;

    if request.enable_rls {
        let enable_rls_sql = format!("alter table {qualified_table} enable row level security");
        tx.execute(enable_rls_sql.as_str())
            .await
            .map_err(|error| format!("supabase: failed to enable RLS: {error}"))?;
    }

    tx.execute("notify pgrst, 'reload schema'")
        .await
        .map_err(|error| format!("supabase: failed to reload PostgREST schema cache: {error}"))?;
    tx.commit()
        .await
        .map_err(|error| format!("supabase: failed to commit table creation: {error}"))?;

    Ok(())
}

pub async fn test_supabase_database_url(request: SupabaseDatabaseUrlRequest) -> Result<(), String> {
    let db_url = normalize_required(&request.db_url, "supabase: database URL is required")?;
    let pool = connect_database(&db_url).await?;

    sqlx::query("select 1")
        .execute(&pool)
        .await
        .map_err(|error| format!("supabase: database test query failed: {error}"))?;

    Ok(())
}

pub async fn drop_supabase_table(request: SupabaseDropTableRequest) -> Result<(), String> {
    let db_url = normalize_required(&request.db_url, "supabase: database URL is required")?;
    let schema = validate_identifier(&request.schema, "schema")?;
    let table_name = validate_identifier(&request.table_name, "table name")?;
    let pool = connect_database(&db_url).await?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("supabase: failed to start database transaction: {error}"))?;
    let drop_sql = format!(
        "drop table {}.{}",
        quote_ident(&schema),
        quote_ident(&table_name)
    );

    tx.execute(drop_sql.as_str())
        .await
        .map_err(|error| format!("supabase: failed to drop table: {error}"))?;
    tx.execute("notify pgrst, 'reload schema'")
        .await
        .map_err(|error| format!("supabase: failed to reload PostgREST schema cache: {error}"))?;
    tx.commit()
        .await
        .map_err(|error| format!("supabase: failed to commit table deletion: {error}"))?;

    Ok(())
}

pub async fn alter_supabase_table(request: SupabaseAlterTableRequest) -> Result<(), String> {
    let db_url = normalize_required(&request.db_url, "supabase: database URL is required")?;
    let schema = validate_identifier(&request.schema, "schema")?;
    let table_name = validate_identifier(&request.table_name, "table name")?;

    if request.operations.is_empty() {
        return Ok(());
    }

    let mut statements = Vec::new();
    for operation in &request.operations {
        statements.extend(build_alter_table_sql(&schema, &table_name, operation)?);
    }

    if statements.is_empty() {
        return Ok(());
    }

    let pool = connect_database(&db_url).await?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| format!("supabase: failed to start database transaction: {error}"))?;

    for statement in statements {
        tx.execute(statement.as_str())
            .await
            .map_err(|error| format!("supabase: failed to alter table: {error}"))?;
    }

    tx.execute("notify pgrst, 'reload schema'")
        .await
        .map_err(|error| format!("supabase: failed to reload PostgREST schema cache: {error}"))?;
    tx.commit()
        .await
        .map_err(|error| format!("supabase: failed to commit table changes: {error}"))?;

    Ok(())
}

fn normalize_required(value: &str, message: &str) -> Result<String, String> {
    let trimmed = value.trim();

    if trimmed.is_empty() {
        return Err(message.to_string());
    }

    Ok(trimmed.to_string())
}

async fn connect_database(db_url: &str) -> Result<sqlx::Pool<sqlx::Postgres>, String> {
    PgPoolOptions::new()
        .max_connections(1)
        .connect(db_url)
        .await
        .map_err(|error| {
            format!(
                "supabase: failed to connect to the database. Check SUPABASE_DB_URL, password, SSL mode, and network access. ({error})"
            )
        })
}

fn parse_method(method: &str) -> Result<Method, String> {
    let normalized = method.trim().to_uppercase();

    match normalized.as_str() {
        "DELETE" => Ok(Method::DELETE),
        "GET" => Ok(Method::GET),
        "PATCH" => Ok(Method::PATCH),
        "POST" => Ok(Method::POST),
        _ => Err("supabase: unsupported request method".to_string()),
    }
}

fn build_supabase_url(
    base_url: &str,
    path: &str,
    query: &[SupabaseProxyQueryParam],
) -> Result<Url, String> {
    let mut base = Url::parse(base_url.trim())
        .map_err(|_| "supabase: project URL must be a valid URL".to_string())?;

    if base.scheme() != "https" && !is_local_http_url(&base) {
        return Err("supabase: project URL must use https or local http".to_string());
    }

    base.set_path("");
    base.set_query(None);
    base.set_fragment(None);

    let normalized_path = path.trim_start_matches('/');
    let mut url = base
        .join(normalized_path)
        .map_err(|_| "supabase: failed to build request URL".to_string())?;

    {
        let mut query_pairs = url.query_pairs_mut();
        for item in query {
            query_pairs.append_pair(&item.key, &item.value);
        }
    }

    Ok(url)
}

fn is_allowed_forward_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "prefer" | "range"
    )
}

fn is_local_http_url(url: &Url) -> bool {
    if url.scheme() != "http" {
        return false;
    }

    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn is_legacy_jwt_key(api_key: &str) -> bool {
    api_key.starts_with("eyJ")
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> Vec<SupabaseProxyHeader> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| SupabaseProxyHeader {
                name: header_name_to_string(name),
                value: value.to_string(),
            })
        })
        .collect()
}

fn header_name_to_string(name: &HeaderName) -> String {
    name.as_str().to_string()
}

fn build_create_table_sql(
    schema: &str,
    table_name: &str,
    columns: &[SupabaseCreateTableColumn],
) -> Result<String, String> {
    let mut column_sql = Vec::new();
    let mut seen_columns = std::collections::HashSet::new();

    for column in columns {
        let name = validate_identifier(&column.name, "column name")?;
        if !seen_columns.insert(name.clone()) {
            return Err(format!("supabase: duplicate column name `{name}`"));
        }

        let data_type = sql_data_type(&column.data_type)?;
        let default_value = sql_default_value(column.default_value.as_deref(), data_type)?;
        let mut parts = vec![quote_ident(&name), data_type.to_string()];

        if let Some(default_value) = default_value {
            parts.push(format!("default {default_value}"));
        }

        if !column.nullable || column.primary_key {
            parts.push("not null".to_string());
        }

        if column.primary_key {
            parts.push("primary key".to_string());
        } else if column.unique {
            parts.push("unique".to_string());
        }

        column_sql.push(format!("  {}", parts.join(" ")));
    }

    Ok(format!(
        "create table {}.{} (\n{}\n)",
        quote_ident(schema),
        quote_ident(table_name),
        column_sql.join(",\n")
    ))
}

fn build_alter_table_sql(
    schema: &str,
    table_name: &str,
    operation: &SupabaseAlterTableOperation,
) -> Result<Vec<String>, String> {
    let qualified_table = format!("{}.{}", quote_ident(schema), quote_ident(table_name));

    match operation {
        SupabaseAlterTableOperation::AddColumn { column } => {
            Ok(vec![build_add_column_sql(&qualified_table, column)?])
        }
        SupabaseAlterTableOperation::DropColumn { name } => {
            let name = validate_identifier(name, "column name")?;
            Ok(vec![format!(
                "alter table {qualified_table} drop column {}",
                quote_ident(&name)
            )])
        }
        SupabaseAlterTableOperation::RenameColumn { old_name, new_name } => {
            let old_name = validate_identifier(old_name, "old column name")?;
            let new_name = validate_identifier(new_name, "new column name")?;

            if old_name == new_name {
                return Ok(Vec::new());
            }

            Ok(vec![format!(
                "alter table {qualified_table} rename column {} to {}",
                quote_ident(&old_name),
                quote_ident(&new_name)
            )])
        }
        SupabaseAlterTableOperation::SetColumnType { name, data_type } => {
            let name = validate_identifier(name, "column name")?;
            let data_type = sql_data_type(data_type)?;
            Ok(vec![format!(
                "alter table {qualified_table} alter column {} type {data_type} using {}::{data_type}",
                quote_ident(&name),
                quote_ident(&name)
            )])
        }
        SupabaseAlterTableOperation::SetColumnNullable { name, nullable } => {
            let name = validate_identifier(name, "column name")?;
            let action = if *nullable {
                "drop not null"
            } else {
                "set not null"
            };
            Ok(vec![format!(
                "alter table {qualified_table} alter column {} {action}",
                quote_ident(&name)
            )])
        }
        SupabaseAlterTableOperation::SetColumnDefault {
            name,
            data_type,
            default_value,
        } => {
            let name = validate_identifier(name, "column name")?;
            let data_type = sql_data_type(data_type)?;
            let default_sql = sql_default_value(default_value.as_deref(), data_type)?;

            if let Some(default_sql) = default_sql {
                Ok(vec![format!(
                    "alter table {qualified_table} alter column {} set default {default_sql}",
                    quote_ident(&name)
                )])
            } else {
                Ok(vec![format!(
                    "alter table {qualified_table} alter column {} drop default",
                    quote_ident(&name)
                )])
            }
        }
    }
}

fn build_add_column_sql(
    qualified_table: &str,
    column: &SupabaseAlterTableColumn,
) -> Result<String, String> {
    let name = validate_identifier(&column.name, "column name")?;
    let data_type = sql_data_type(&column.data_type)?;
    let default_value = sql_default_value(column.default_value.as_deref(), data_type)?;
    let mut parts = vec![
        "alter table".to_string(),
        qualified_table.to_string(),
        "add column".to_string(),
        quote_ident(&name),
        data_type.to_string(),
    ];

    if let Some(default_value) = default_value {
        parts.push(format!("default {default_value}"));
    }

    if !column.nullable {
        parts.push("not null".to_string());
    }

    if column.unique {
        parts.push("unique".to_string());
    }

    Ok(parts.join(" "))
}

fn validate_identifier(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err(format!("supabase: {label} is required"));
    };

    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "supabase: {label} must start with a letter or underscore"
        ));
    }

    if !chars.all(|character| character.is_ascii_alphanumeric() || character == '_') {
        return Err(format!(
            "supabase: {label} can only contain letters, numbers, and underscores"
        ));
    }

    Ok(trimmed.to_string())
}

fn quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sql_data_type(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "bigint" => Ok("bigint"),
        "bool" => Ok("boolean"),
        "boolean" => Ok("boolean"),
        "date" => Ok("date"),
        "float4" | "float8" => Ok("numeric"),
        "int" | "int2" | "int4" | "smallint" => Ok("integer"),
        "int8" => Ok("bigint"),
        "integer" => Ok("integer"),
        "jsonb" => Ok("jsonb"),
        "numeric" => Ok("numeric"),
        "text" => Ok("text"),
        "timestamp" | "timestamp with time zone" | "timestamp without time zone" => {
            Ok("timestamptz")
        }
        "timestamptz" => Ok("timestamptz"),
        "uuid" => Ok("uuid"),
        _ => Err("supabase: unsupported column type".to_string()),
    }
}

fn sql_default_value(value: Option<&str>, data_type: &str) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if value == "none" {
        return Ok(None);
    }

    if value == "''" && data_type != "text" {
        return Ok(None);
    }

    match (data_type, value) {
        ("boolean", "false") => Ok(Some("false".to_string())),
        ("boolean", "true") => Ok(Some("true".to_string())),
        ("date", "CURRENT_DATE") => Ok(Some("CURRENT_DATE".to_string())),
        ("integer" | "bigint", value) if is_integer_default(value) => Ok(Some(value.to_string())),
        ("numeric", value) if is_numeric_default(value) => Ok(Some(value.to_string())),
        ("jsonb", "'[]'::jsonb") => Ok(Some("'[]'::jsonb".to_string())),
        ("jsonb", "'{}'::jsonb") => Ok(Some("'{}'::jsonb".to_string())),
        ("text", "''") => Ok(Some("''".to_string())),
        ("timestamptz", "now()") => Ok(Some("now()".to_string())),
        ("uuid", "gen_random_uuid()") => Ok(Some("gen_random_uuid()".to_string())),
        _ => Err("supabase: default value is not compatible with the column type".to_string()),
    }
}

fn is_integer_default(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    let digits = value.strip_prefix('-').unwrap_or(value);

    is_plain_digits(digits)
}

fn is_numeric_default(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    let unsigned = value.strip_prefix('-').unwrap_or(value);
    let mut parts = unsigned.split('.');
    let Some(integer) = parts.next() else {
        return false;
    };

    if !is_plain_digits(integer) {
        return false;
    }

    match (parts.next(), parts.next()) {
        (None, None) => true,
        (Some(decimal), None) => {
            !decimal.is_empty() && decimal.chars().all(|item| item.is_ascii_digit())
        }
        _ => false,
    }
}

fn is_plain_digits(value: &str) -> bool {
    if value == "0" {
        return true;
    }

    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    first.is_ascii_digit() && first != '0' && chars.all(|item| item.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::{sql_data_type, sql_default_value};

    #[test]
    fn sql_data_type_accepts_common_postgres_aliases() {
        assert_eq!(sql_data_type("int2").unwrap(), "integer");
        assert_eq!(sql_data_type("smallint").unwrap(), "integer");
        assert_eq!(sql_data_type("int8").unwrap(), "bigint");
        assert_eq!(sql_data_type("bool").unwrap(), "boolean");
        assert_eq!(sql_data_type("timestamp").unwrap(), "timestamptz");
    }

    #[test]
    fn sql_default_value_accepts_safe_numeric_literals() {
        assert_eq!(
            sql_default_value(Some("9"), "integer").unwrap(),
            Some("9".to_string())
        );
        assert_eq!(
            sql_default_value(Some("-12"), "bigint").unwrap(),
            Some("-12".to_string())
        );
        assert_eq!(
            sql_default_value(Some("0.5"), "numeric").unwrap(),
            Some("0.5".to_string())
        );
    }

    #[test]
    fn sql_default_value_rejects_unsafe_numeric_expressions() {
        assert!(sql_default_value(Some("9; drop table rooms"), "integer").is_err());
        assert!(sql_default_value(Some("1e6"), "numeric").is_err());
        assert!(sql_default_value(Some("01"), "integer").is_err());
        assert!(sql_default_value(Some("1.5"), "integer").is_err());
    }
}
