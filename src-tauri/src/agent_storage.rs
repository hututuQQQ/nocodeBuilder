use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

use crate::projects::resolve_project_dir;

const AGENT_DB_FILE: &str = "agent.sqlite";
const ARTIFACTS_DIR: &str = "artifacts";
const METADATA_DIR: &str = ".aibuilder";
const SITE_SPEC_FILE: &str = "site-spec.json";
const SOURCE_MAP_FILE: &str = "source-map.json";
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub contract: Value,
    pub status: String,
    pub phase: String,
    pub state_version: i64,
    pub model_turns: i64,
    pub tool_calls: i64,
    pub mutation_count: i64,
    pub repair_cycles: i64,
    pub cancel_requested: bool,
    pub pause_requested: bool,
    pub started_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCreateInput {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub contract: Value,
    pub status: String,
    pub phase: String,
    pub started_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunTransitionInput {
    pub run_id: String,
    pub expected_state_version: i64,
    pub status: String,
    pub phase: String,
    pub model_turns: i64,
    pub tool_calls: i64,
    pub mutation_count: i64,
    pub repair_cycles: i64,
    pub cancel_requested: bool,
    pub pause_requested: bool,
    pub completed_at: Option<String>,
    pub updated_at: String,
    pub event_type: String,
    pub event_timestamp: String,
    pub event_payload: Value,
    pub artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRecord {
    pub id: String,
    pub run_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub timestamp: String,
    pub payload: Value,
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventAppendInput {
    pub id: String,
    pub run_id: String,
    pub event_type: String,
    pub timestamp: String,
    pub payload: Value,
    pub artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTransitionResult {
    pub run: AgentRunRecord,
    pub event: AgentEventRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReportRecord {
    pub id: String,
    pub run_id: String,
    pub status: String,
    pub created_at: String,
    pub report: Value,
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReportInput {
    pub id: String,
    pub run_id: String,
    pub status: String,
    pub created_at: String,
    pub report: Value,
    pub artifact_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub run_id: String,
    pub path: String,
    pub hash: String,
    pub size_bytes: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactWriteInput {
    pub id: String,
    pub run_id: String,
    pub relative_path: String,
    pub content: String,
}

#[tauri::command]
pub async fn create_agent_run(
    project_id: String,
    run: AgentRunCreateInput,
) -> Result<AgentRunRecord, String> {
    if project_id != run.project_id {
        return Err("agent-storage: project id mismatch".to_string());
    }

    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let contract_json = serde_json::to_string(&run.contract)
        .map_err(|error| format!("agent-storage: failed to encode contract: {error}"))?;

    sqlx::query(
        r#"
        INSERT INTO agent_runs (
            id, project_id, conversation_id, contract_json, status, phase, state_version,
            model_turns, tool_calls, mutation_count, repair_cycles,
            cancel_requested, pause_requested, started_at, updated_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 0, 0, 0, 0, ?7, ?8, NULL)
        "#,
    )
    .bind(&run.id)
    .bind(&run.project_id)
    .bind(&run.conversation_id)
    .bind(contract_json)
    .bind(&run.status)
    .bind(&run.phase)
    .bind(&run.started_at)
    .bind(&run.updated_at)
    .execute(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create run: {error}"))?;

    let event = AgentEventAppendInput {
        id: create_id("event"),
        run_id: run.id.clone(),
        event_type: "run.created".to_string(),
        timestamp: run.started_at,
        payload: json!({ "status": run.status }),
        artifact_ids: None,
    };
    append_agent_event_with_pool(&pool, event).await?;
    read_agent_run_with_pool(&pool, &run.id).await
}

#[tauri::command]
pub async fn list_agent_runs(project_id: String) -> Result<Vec<AgentRunRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let rows = sqlx::query(
        r#"
        SELECT * FROM agent_runs
        WHERE project_id = ?1
        ORDER BY updated_at DESC
        LIMIT 50
        "#,
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to list runs: {error}"))?;

    rows.into_iter().map(row_to_run).collect()
}

#[tauri::command]
pub async fn get_agent_run(
    project_id: String,
    run_id: String,
) -> Result<Option<AgentRunRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let row = sqlx::query("SELECT * FROM agent_runs WHERE id = ?1 AND project_id = ?2")
        .bind(run_id)
        .bind(project_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read run: {error}"))?;

    row.map(row_to_run).transpose()
}

#[tauri::command]
pub async fn transition_agent_run(
    project_id: String,
    update: AgentRunTransitionInput,
) -> Result<AgentTransitionResult, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("agent-storage: failed to begin transaction: {error}"))?;
    let current =
        sqlx::query("SELECT state_version FROM agent_runs WHERE id = ?1 AND project_id = ?2")
            .bind(&update.run_id)
            .bind(&project_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| format!("agent-storage: failed to read run version: {error}"))?
            .ok_or_else(|| "agent-storage: run not found".to_string())?;
    let current_version: i64 = current
        .try_get("state_version")
        .map_err(|error| format!("agent-storage: invalid run version: {error}"))?;

    if current_version != update.expected_state_version {
        return Err(format!(
            "agent-storage: stale run update for {}; expected {}, got {}",
            update.run_id, current_version, update.expected_state_version
        ));
    }

    let next_version = current_version + 1;
    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = ?1,
            phase = ?2,
            state_version = ?3,
            model_turns = ?4,
            tool_calls = ?5,
            mutation_count = ?6,
            repair_cycles = ?7,
            cancel_requested = ?8,
            pause_requested = ?9,
            updated_at = ?10,
            completed_at = ?11
        WHERE id = ?12 AND project_id = ?13
        "#,
    )
    .bind(&update.status)
    .bind(&update.phase)
    .bind(next_version)
    .bind(update.model_turns)
    .bind(update.tool_calls)
    .bind(update.mutation_count)
    .bind(update.repair_cycles)
    .bind(bool_to_i64(update.cancel_requested))
    .bind(bool_to_i64(update.pause_requested))
    .bind(&update.updated_at)
    .bind(&update.completed_at)
    .bind(&update.run_id)
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to update run: {error}"))?;

    let event = insert_event_in_transaction(
        &mut transaction,
        AgentEventAppendInput {
            id: create_id("event"),
            run_id: update.run_id.clone(),
            event_type: update.event_type,
            timestamp: update.event_timestamp,
            payload: update.event_payload,
            artifact_ids: update.artifact_ids,
        },
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("agent-storage: failed to commit transaction: {error}"))?;

    let run = read_agent_run_with_pool(&pool, &update.run_id).await?;
    Ok(AgentTransitionResult { run, event })
}

#[tauri::command]
pub async fn append_agent_event(
    project_id: String,
    event: AgentEventAppendInput,
) -> Result<AgentEventRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    append_agent_event_with_pool(&pool, event).await
}

#[tauri::command]
pub async fn list_agent_events(
    project_id: String,
    run_id: String,
) -> Result<Vec<AgentEventRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let rows = sqlx::query(
        r#"
        SELECT * FROM agent_events
        WHERE run_id = ?1
        ORDER BY sequence ASC
        "#,
    )
    .bind(run_id)
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to list events: {error}"))?;

    rows.into_iter().map(row_to_event).collect()
}

#[tauri::command]
pub async fn save_verification_report(
    project_id: String,
    report: VerificationReportInput,
) -> Result<VerificationReportRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let report_json = serde_json::to_string(&report.report)
        .map_err(|error| format!("agent-storage: failed to encode report: {error}"))?;
    let artifact_ids = report.artifact_ids.unwrap_or_default();
    let artifact_ids_json = serde_json::to_string(&artifact_ids)
        .map_err(|error| format!("agent-storage: failed to encode artifact ids: {error}"))?;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO verification_reports (
            id, run_id, status, created_at, report_json, artifact_ids_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(&report.id)
    .bind(&report.run_id)
    .bind(&report.status)
    .bind(&report.created_at)
    .bind(report_json)
    .bind(artifact_ids_json)
    .execute(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to save report: {error}"))?;

    Ok(VerificationReportRecord {
        id: report.id,
        run_id: report.run_id,
        status: report.status,
        created_at: report.created_at,
        report: report.report,
        artifact_ids,
    })
}

#[tauri::command]
pub async fn get_latest_verification_report(
    project_id: String,
    run_id: String,
) -> Result<Option<VerificationReportRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let row = sqlx::query(
        r#"
        SELECT * FROM verification_reports
        WHERE run_id = ?1
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(run_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to read report: {error}"))?;

    row.map(row_to_report).transpose()
}

#[tauri::command]
pub async fn write_agent_artifact(
    project_id: String,
    artifact: ArtifactWriteInput,
) -> Result<ArtifactRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let artifact_path =
        resolve_artifact_path(&project_dir, &artifact.run_id, &artifact.relative_path)?;

    if let Some(parent) = artifact_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "agent-storage: failed to create artifact directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    fs::write(&artifact_path, &artifact.content).map_err(|error| {
        format!(
            "agent-storage: failed to write artifact '{}': {error}",
            artifact_path.display()
        )
    })?;

    let relative_path = artifact_path
        .strip_prefix(project_dir.join(METADATA_DIR))
        .map_err(|_| "agent-storage: artifact path escaped metadata".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let record = ArtifactRecord {
        id: artifact.id,
        run_id: artifact.run_id,
        path: relative_path,
        hash: hash_text(&artifact.content),
        size_bytes: artifact.content.len() as i64,
        created_at: Utc::now().to_rfc3339(),
    };

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO artifacts (id, run_id, path, hash, size_bytes, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
    )
    .bind(&record.id)
    .bind(&record.run_id)
    .bind(&record.path)
    .bind(&record.hash)
    .bind(record.size_bytes)
    .bind(&record.created_at)
    .execute(&pool)
    .await
    .map_err(|error| format!("agent-storage: failed to record artifact: {error}"))?;

    Ok(record)
}

#[tauri::command]
pub fn read_site_spec(project_id: String) -> Result<Option<Value>, String> {
    read_metadata_json(project_id, SITE_SPEC_FILE)
}

#[tauri::command]
pub fn write_site_spec(project_id: String, site_spec: Value) -> Result<(), String> {
    write_metadata_json(project_id, SITE_SPEC_FILE, site_spec)
}

#[tauri::command]
pub fn read_site_source_map(project_id: String) -> Result<Option<Value>, String> {
    read_metadata_json(project_id, SOURCE_MAP_FILE)
}

#[tauri::command]
pub fn write_site_source_map(project_id: String, source_map: Value) -> Result<(), String> {
    write_metadata_json(project_id, SOURCE_MAP_FILE, source_map)
}

async fn open_project_agent_db(project_dir: &Path) -> Result<SqlitePool, String> {
    let db_path = database_path_for_project_dir(project_dir)?;
    let parent = db_path
        .parent()
        .ok_or_else(|| "agent-storage: invalid database path".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "agent-storage: failed to create metadata directory '{}': {error}",
            parent.display()
        )
    })?;

    let database_url = format!(
        "sqlite://{}?mode=rwc",
        db_path.to_string_lossy().replace('\\', "/")
    );
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .map_err(|error| format!("agent-storage: failed to open SQLite database: {error}"))?;
    init_database(&pool).await?;
    Ok(pool)
}

fn database_path_for_project_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let metadata_dir = project_dir.join(METADATA_DIR);
    Ok(metadata_dir.join(AGENT_DB_FILE))
}

async fn init_database(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to enable foreign keys: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS schema_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create schema metadata: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            contract_json TEXT NOT NULL,
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            state_version INTEGER NOT NULL,
            model_turns INTEGER NOT NULL,
            tool_calls INTEGER NOT NULL,
            mutation_count INTEGER NOT NULL,
            repair_cycles INTEGER NOT NULL,
            cancel_requested INTEGER NOT NULL,
            pause_requested INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create runs table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS agent_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            artifact_ids_json TEXT NOT NULL,
            UNIQUE(run_id, sequence),
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create events table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS verification_reports (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            report_json TEXT NOT NULL,
            artifact_ids_json TEXT NOT NULL,
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create reports table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            args_hash TEXT NOT NULL,
            target_resources_json TEXT NOT NULL,
            exact_side_effect TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            resolved_at TEXT,
            decision TEXT,
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create approvals table: {error}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            path TEXT NOT NULL,
            hash TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create artifacts table: {error}"))?;

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO schema_metadata (key, value, updated_at)
        VALUES ('schema_version', ?1, ?2)
        "#,
    )
    .bind(SCHEMA_VERSION.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to record schema version: {error}"))?;

    Ok(())
}

async fn append_agent_event_with_pool(
    pool: &SqlitePool,
    event: AgentEventAppendInput,
) -> Result<AgentEventRecord, String> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("agent-storage: failed to begin event transaction: {error}"))?;
    let event = insert_event_in_transaction(&mut transaction, event).await?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("agent-storage: failed to commit event transaction: {error}"))?;

    Ok(event)
}

async fn insert_event_in_transaction(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: AgentEventAppendInput,
) -> Result<AgentEventRecord, String> {
    let row = sqlx::query("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_events WHERE run_id = ?1")
        .bind(&event.run_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|error| format!("agent-storage: failed to allocate event sequence: {error}"))?;
    let sequence: i64 = row
        .try_get("next_sequence")
        .map_err(|error| format!("agent-storage: invalid event sequence: {error}"))?;
    let artifact_ids = event.artifact_ids.unwrap_or_default();
    let payload_json = serde_json::to_string(&event.payload)
        .map_err(|error| format!("agent-storage: failed to encode event payload: {error}"))?;
    let artifact_ids_json = serde_json::to_string(&artifact_ids)
        .map_err(|error| format!("agent-storage: failed to encode artifact ids: {error}"))?;

    sqlx::query(
        r#"
        INSERT INTO agent_events (
            id, run_id, sequence, event_type, timestamp, payload_json, artifact_ids_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(&event.id)
    .bind(&event.run_id)
    .bind(sequence)
    .bind(&event.event_type)
    .bind(&event.timestamp)
    .bind(payload_json)
    .bind(artifact_ids_json)
    .execute(&mut **transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to append event: {error}"))?;

    Ok(AgentEventRecord {
        id: event.id,
        run_id: event.run_id,
        sequence,
        event_type: event.event_type,
        timestamp: event.timestamp,
        payload: event.payload,
        artifact_ids,
    })
}

async fn read_agent_run_with_pool(
    pool: &SqlitePool,
    run_id: &str,
) -> Result<AgentRunRecord, String> {
    let row = sqlx::query("SELECT * FROM agent_runs WHERE id = ?1")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read run: {error}"))?;

    row_to_run(row)
}

fn row_to_run(row: sqlx::sqlite::SqliteRow) -> Result<AgentRunRecord, String> {
    let contract_json: String = row
        .try_get("contract_json")
        .map_err(|error| format!("agent-storage: invalid contract json: {error}"))?;
    let contract = serde_json::from_str(&contract_json)
        .map_err(|error| format!("agent-storage: failed to parse contract json: {error}"))?;

    Ok(AgentRunRecord {
        id: row.try_get("id").map_err(row_error)?,
        project_id: row.try_get("project_id").map_err(row_error)?,
        conversation_id: row.try_get("conversation_id").map_err(row_error)?,
        contract,
        status: row.try_get("status").map_err(row_error)?,
        phase: row.try_get("phase").map_err(row_error)?,
        state_version: row.try_get("state_version").map_err(row_error)?,
        model_turns: row.try_get("model_turns").map_err(row_error)?,
        tool_calls: row.try_get("tool_calls").map_err(row_error)?,
        mutation_count: row.try_get("mutation_count").map_err(row_error)?,
        repair_cycles: row.try_get("repair_cycles").map_err(row_error)?,
        cancel_requested: int_to_bool(row.try_get("cancel_requested").map_err(row_error)?),
        pause_requested: int_to_bool(row.try_get("pause_requested").map_err(row_error)?),
        started_at: row.try_get("started_at").map_err(row_error)?,
        updated_at: row.try_get("updated_at").map_err(row_error)?,
        completed_at: row.try_get("completed_at").map_err(row_error)?,
    })
}

fn row_to_event(row: sqlx::sqlite::SqliteRow) -> Result<AgentEventRecord, String> {
    let payload_json: String = row.try_get("payload_json").map_err(row_error)?;
    let artifact_ids_json: String = row.try_get("artifact_ids_json").map_err(row_error)?;

    Ok(AgentEventRecord {
        id: row.try_get("id").map_err(row_error)?,
        run_id: row.try_get("run_id").map_err(row_error)?,
        sequence: row.try_get("sequence").map_err(row_error)?,
        event_type: row.try_get("event_type").map_err(row_error)?,
        timestamp: row.try_get("timestamp").map_err(row_error)?,
        payload: serde_json::from_str(&payload_json)
            .map_err(|error| format!("agent-storage: failed to parse event payload: {error}"))?,
        artifact_ids: serde_json::from_str(&artifact_ids_json).map_err(|error| {
            format!("agent-storage: failed to parse event artifact ids: {error}")
        })?,
    })
}

fn row_to_report(row: sqlx::sqlite::SqliteRow) -> Result<VerificationReportRecord, String> {
    let report_json: String = row.try_get("report_json").map_err(row_error)?;
    let artifact_ids_json: String = row.try_get("artifact_ids_json").map_err(row_error)?;

    Ok(VerificationReportRecord {
        id: row.try_get("id").map_err(row_error)?,
        run_id: row.try_get("run_id").map_err(row_error)?,
        status: row.try_get("status").map_err(row_error)?,
        created_at: row.try_get("created_at").map_err(row_error)?,
        report: serde_json::from_str(&report_json)
            .map_err(|error| format!("agent-storage: failed to parse report: {error}"))?,
        artifact_ids: serde_json::from_str(&artifact_ids_json).map_err(|error| {
            format!("agent-storage: failed to parse report artifact ids: {error}")
        })?,
    })
}

fn row_error(error: sqlx::Error) -> String {
    format!("agent-storage: invalid row: {error}")
}

fn read_metadata_json(project_id: String, file_name: &str) -> Result<Option<Value>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let path = project_dir.join(METADATA_DIR).join(file_name);

    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "agent-storage: failed to read metadata file '{}': {error}",
            path.display()
        )
    })?;
    let value = serde_json::from_str(&content)
        .map_err(|error| format!("agent-storage: failed to parse metadata JSON: {error}"))?;

    Ok(Some(value))
}

fn write_metadata_json(project_id: String, file_name: &str, value: Value) -> Result<(), String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let path = project_dir.join(METADATA_DIR).join(file_name);
    let parent = path
        .parent()
        .ok_or_else(|| "agent-storage: invalid metadata path".to_string())?;

    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "agent-storage: failed to create metadata directory '{}': {error}",
            parent.display()
        )
    })?;
    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("agent-storage: failed to encode metadata JSON: {error}"))?;
    fs::write(&path, content).map_err(|error| {
        format!(
            "agent-storage: failed to write metadata file '{}': {error}",
            path.display()
        )
    })
}

fn resolve_artifact_path(
    project_dir: &Path,
    run_id: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_safe_segment(run_id)?;
    let relative_path = validate_relative_path(relative_path)?;
    let root = project_dir
        .join(METADATA_DIR)
        .join(ARTIFACTS_DIR)
        .join(run_id);
    let path = root.join(relative_path);
    let parent = path
        .parent()
        .ok_or_else(|| "agent-storage: invalid artifact path".to_string())?;

    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "agent-storage: failed to create artifact parent '{}': {error}",
            parent.display()
        )
    })?;

    let root = root
        .canonicalize()
        .map_err(|error| format!("agent-storage: failed to resolve artifact root: {error}"))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("agent-storage: failed to resolve artifact parent: {error}"))?;

    if !parent.starts_with(&root) {
        return Err("agent-storage: artifact path escaped run directory".to_string());
    }

    Ok(path)
}

fn validate_safe_segment(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("agent-storage: invalid path segment".to_string());
    }

    Ok(())
}

fn validate_relative_path(path: &str) -> Result<PathBuf, String> {
    let raw_path = Path::new(path.trim());

    if raw_path.is_absolute() {
        return Err("agent-storage: absolute artifact paths are not allowed".to_string());
    }

    let mut normalized = PathBuf::new();

    for component in raw_path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("agent-storage: artifact path traversal is not allowed".to_string());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("agent-storage: artifact path is required".to_string());
    }

    Ok(normalized)
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn create_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        Utc::now().timestamp_millis(),
        rand_suffix()
    )
}

fn rand_suffix() -> String {
    format!("{:x}", Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

fn hash_text(content: &str) -> String {
    let mut hash = 2166136261u32;

    for byte in content.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16777619);
    }

    format!("{}:{hash:x}", content.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_path_rejects_escape() {
        let root = std::env::temp_dir().join(format!("agent-storage-test-{}", rand_suffix()));
        fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");

        let result = resolve_artifact_path(&root, "run-1", "../escape.log");
        assert!(result.is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn database_path_uses_project_metadata_dir() {
        let root = PathBuf::from("C:/example/project");
        let path = database_path_for_project_dir(&root).expect("path");

        assert!(path.ends_with(Path::new(".aibuilder").join("agent.sqlite")));
    }

    #[test]
    fn initializes_schema_and_appends_strict_sequences() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!("agent-storage-db-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");
            let run = AgentRunCreateInput {
                id: "run-1".to_string(),
                project_id: "project-1".to_string(),
                conversation_id: "conversation-1".to_string(),
                contract: json!({ "objective": "test" }),
                status: "created".to_string(),
                phase: "created".to_string(),
                started_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
            };
            let contract_json = serde_json::to_string(&run.contract).expect("contract json");

            sqlx::query(
                r#"
                INSERT INTO agent_runs (
                    id, project_id, conversation_id, contract_json, status, phase,
                    state_version, model_turns, tool_calls, mutation_count, repair_cycles,
                    cancel_requested, pause_requested, started_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 0, 0, 0, 0, ?7, ?8)
                "#,
            )
            .bind(&run.id)
            .bind(&run.project_id)
            .bind(&run.conversation_id)
            .bind(contract_json)
            .bind(&run.status)
            .bind(&run.phase)
            .bind(&run.started_at)
            .bind(&run.updated_at)
            .execute(&pool)
            .await
            .expect("insert run");

            let first = append_agent_event_with_pool(
                &pool,
                AgentEventAppendInput {
                    id: "event-1".to_string(),
                    run_id: "run-1".to_string(),
                    event_type: "run.created".to_string(),
                    timestamp: "2026-01-01T00:00:00Z".to_string(),
                    payload: json!({}),
                    artifact_ids: None,
                },
            )
            .await
            .expect("first event");
            let second = append_agent_event_with_pool(
                &pool,
                AgentEventAppendInput {
                    id: "event-2".to_string(),
                    run_id: "run-1".to_string(),
                    event_type: "run.started".to_string(),
                    timestamp: "2026-01-01T00:00:01Z".to_string(),
                    payload: json!({}),
                    artifact_ids: None,
                },
            )
            .await
            .expect("second event");

            assert_eq!(first.sequence, 1);
            assert_eq!(second.sequence, 2);

            let _ = fs::remove_dir_all(root);
        });
    }
}
