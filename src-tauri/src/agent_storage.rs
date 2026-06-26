use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};

use crate::projects::resolve_project_dir;

const AGENT_DB_FILE: &str = "agent.sqlite";
const ARTIFACTS_DIR: &str = "artifacts";
const METADATA_DIR: &str = ".aibuilder";
const SITE_SPEC_FILE: &str = "site-spec.json";
const SOURCE_MAP_FILE: &str = "source-map.json";
const SCHEMA_VERSION: i64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub project_id: String,
    pub conversation_id: String,
    pub contract: Value,
    pub manifest: Value,
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
    pub manifest: Value,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunProgressInput {
    pub run_id: String,
    pub expected_state_version: i64,
    pub model_turns: i64,
    pub tool_calls: i64,
    pub mutation_count: i64,
    pub repair_cycles: i64,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalRecord {
    pub id: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub normalized_args_hash: String,
    pub target_resources: Vec<String>,
    pub exact_side_effect: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalCreateInput {
    pub id: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub normalized_args_hash: String,
    pub target_resources: Vec<String>,
    pub exact_side_effect: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalResolveInput {
    pub run_id: String,
    pub approval_id: String,
    pub decision: String,
    pub resolved_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalClaimInput {
    pub run_id: String,
    pub approval_id: String,
    pub normalized_args_hash: String,
    pub tool_call_id: String,
    pub consumed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpointRecord {
    pub id: String,
    pub run_id: String,
    pub created_at: String,
    pub workspace_fingerprint: String,
    pub plan: Value,
    pub observations: Vec<Value>,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub package_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_baseline_json: Option<String>,
    pub read_snapshots: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_report_id: Option<String>,
    pub repair_feedback: Vec<String>,
    pub steering_watermark: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpointInput {
    pub id: String,
    pub run_id: String,
    pub created_at: String,
    pub workspace_fingerprint: String,
    pub plan: Value,
    pub observations: Vec<Value>,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub package_changed: bool,
    pub package_baseline_json: Option<String>,
    pub read_snapshots: Vec<Value>,
    pub latest_report_id: Option<String>,
    pub repair_feedback: Vec<String>,
    pub steering_watermark: i64,
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadRecord {
    pub id: String,
    pub run_id: String,
    pub path: String,
    pub hash: String,
    pub size_bytes: i64,
    pub created_at: String,
    pub content: String,
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
    create_agent_run_with_pool(&pool, run).await
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
pub async fn record_agent_progress(
    project_id: String,
    update: AgentRunProgressInput,
) -> Result<AgentTransitionResult, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("agent-storage: failed to begin progress transaction: {error}"))?;
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
            "agent-storage: stale run progress for {}; expected {}, got {}",
            update.run_id, current_version, update.expected_state_version
        ));
    }

    let next_version = current_version + 1;
    sqlx::query(
        r#"
        UPDATE agent_runs
        SET state_version = ?1,
            model_turns = ?2,
            tool_calls = ?3,
            mutation_count = ?4,
            repair_cycles = ?5,
            updated_at = ?6
        WHERE id = ?7 AND project_id = ?8
        "#,
    )
    .bind(next_version)
    .bind(update.model_turns)
    .bind(update.tool_calls)
    .bind(update.mutation_count)
    .bind(update.repair_cycles)
    .bind(&update.updated_at)
    .bind(&update.run_id)
    .bind(&project_id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to update run progress: {error}"))?;

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
        .map_err(|error| format!("agent-storage: failed to commit progress: {error}"))?;

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
pub async fn create_agent_approval(
    project_id: String,
    approval: AgentApprovalCreateInput,
) -> Result<AgentApprovalRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    create_agent_approval_with_pool(&pool, approval).await
}

#[tauri::command]
pub async fn list_agent_approvals(
    project_id: String,
    run_id: String,
) -> Result<Vec<AgentApprovalRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    list_agent_approvals_with_pool(&pool, &run_id).await
}

#[tauri::command]
pub async fn get_pending_agent_approval(
    project_id: String,
    run_id: String,
) -> Result<Option<AgentApprovalRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    get_pending_agent_approval_with_pool(&pool, &run_id, &Utc::now().to_rfc3339()).await
}

#[tauri::command]
pub async fn resolve_agent_approval(
    project_id: String,
    resolution: AgentApprovalResolveInput,
) -> Result<AgentApprovalRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    resolve_agent_approval_with_pool(&pool, resolution).await
}

#[tauri::command]
pub async fn claim_agent_approval(
    project_id: String,
    claim: AgentApprovalClaimInput,
) -> Result<AgentApprovalRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    claim_agent_approval_with_pool(&pool, claim).await
}

#[tauri::command]
pub async fn save_agent_checkpoint(
    project_id: String,
    checkpoint: AgentCheckpointInput,
) -> Result<AgentCheckpointRecord, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    save_agent_checkpoint_with_pool(&pool, checkpoint).await
}

#[tauri::command]
pub async fn get_latest_agent_checkpoint(
    project_id: String,
    run_id: String,
) -> Result<Option<AgentCheckpointRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    get_latest_agent_checkpoint_with_pool(&pool, &run_id).await
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
pub async fn read_agent_artifact(
    project_id: String,
    artifact_id: String,
) -> Result<Option<ArtifactReadRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let pool = open_project_agent_db(&project_dir).await?;
    read_agent_artifact_with_pool(&pool, &project_dir, &artifact_id).await
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

    let database_options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(database_options)
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
            manifest_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            state_version INTEGER NOT NULL,
            model_turns INTEGER NOT NULL,
            tool_calls INTEGER NOT NULL,
            mutation_count INTEGER NOT NULL,
            repair_cycles INTEGER NOT NULL,
            is_write_run INTEGER NOT NULL DEFAULT 1,
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
    migrate_agent_run_columns(pool).await?;

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
            normalized_args_hash TEXT NOT NULL,
            target_resources_json TEXT NOT NULL,
            exact_side_effect TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            resolved_at TEXT,
            decision TEXT,
            consumed_at TEXT,
            consumed_tool_call_id TEXT,
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create approvals table: {error}"))?;
    migrate_approval_columns(pool).await?;

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
        CREATE TABLE IF NOT EXISTS run_checkpoints (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            workspace_fingerprint TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            observations_json TEXT NOT NULL,
            changed_files_json TEXT NOT NULL,
            deleted_files_json TEXT NOT NULL DEFAULT '[]',
            package_changed INTEGER NOT NULL,
            package_baseline_json TEXT,
            read_snapshots_json TEXT NOT NULL,
            latest_report_id TEXT,
            repair_feedback_json TEXT NOT NULL,
            steering_watermark INTEGER NOT NULL,
            FOREIGN KEY(run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
        )
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to create checkpoints table: {error}"))?;
    migrate_checkpoint_columns(pool).await?;

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

async fn create_agent_run_with_pool(
    pool: &SqlitePool,
    run: AgentRunCreateInput,
) -> Result<AgentRunRecord, String> {
    let contract_json = serde_json::to_string(&run.contract)
        .map_err(|error| format!("agent-storage: failed to encode contract: {error}"))?;
    let manifest_json = serde_json::to_string(&run.manifest)
        .map_err(|error| format!("agent-storage: failed to encode manifest: {error}"))?;
    let is_write_run = is_write_task_contract(&run.contract);

    let mut transaction = pool.begin().await.map_err(|error| {
        format!("agent-storage: failed to begin create run transaction: {error}")
    })?;

    if is_write_run {
        let active_write_run = sqlx::query(
            r#"
            SELECT id FROM agent_runs
            WHERE project_id = ?1
              AND is_write_run = 1
              AND status NOT IN ('completed', 'failed', 'cancelled', 'budget_exceeded')
            LIMIT 1
            "#,
        )
        .bind(&run.project_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("agent-storage: failed to check active write run: {error}"))?;

        if let Some(row) = active_write_run {
            let active_id: String = row.try_get("id").map_err(row_error)?;
            return Err(format!(
                "agent-storage: active write run {active_id} already exists for project {}",
                run.project_id
            ));
        }
    }

    sqlx::query(
        r#"
        INSERT INTO agent_runs (
            id, project_id, conversation_id, contract_json, manifest_json, status, phase, state_version,
            model_turns, tool_calls, mutation_count, repair_cycles, is_write_run,
            cancel_requested, pause_requested, started_at, updated_at, completed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 0, 0, ?8, 0, 0, ?9, ?10, NULL)
        "#,
    )
    .bind(&run.id)
    .bind(&run.project_id)
    .bind(&run.conversation_id)
    .bind(contract_json)
    .bind(manifest_json)
    .bind(&run.status)
    .bind(&run.phase)
    .bind(bool_to_i64(is_write_run))
    .bind(&run.started_at)
    .bind(&run.updated_at)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to create run: {error}"))?;

    insert_event_in_transaction(
        &mut transaction,
        AgentEventAppendInput {
            id: create_id("event"),
            run_id: run.id.clone(),
            event_type: "run.created".to_string(),
            timestamp: run.started_at,
            payload: json!({ "status": run.status }),
            artifact_ids: None,
        },
    )
    .await?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("agent-storage: failed to commit create run: {error}"))?;

    read_agent_run_with_pool(pool, &run.id).await
}

async fn create_agent_approval_with_pool(
    pool: &SqlitePool,
    approval: AgentApprovalCreateInput,
) -> Result<AgentApprovalRecord, String> {
    let target_resources_json = serde_json::to_string(&approval.target_resources)
        .map_err(|error| format!("agent-storage: failed to encode approval resources: {error}"))?;

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("agent-storage: failed to begin approval transaction: {error}"))?;
    let run_exists = sqlx::query("SELECT 1 FROM agent_runs WHERE id = ?1")
        .bind(&approval.run_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("agent-storage: failed to validate approval run: {error}"))?;

    if run_exists.is_none() {
        return Err("agent-storage: approval run not found".to_string());
    }

    sqlx::query(
        r#"
        INSERT INTO approvals (
            id, run_id, tool_call_id, tool_name, normalized_args_hash,
            target_resources_json, exact_side_effect, created_at, expires_at, resolved_at, decision
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL)
        "#,
    )
    .bind(&approval.id)
    .bind(&approval.run_id)
    .bind(&approval.tool_call_id)
    .bind(&approval.tool_name)
    .bind(&approval.normalized_args_hash)
    .bind(target_resources_json)
    .bind(&approval.exact_side_effect)
    .bind(&approval.created_at)
    .bind(&approval.expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to create approval: {error}"))?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("agent-storage: failed to commit approval: {error}"))?;

    read_agent_approval_with_pool(pool, &approval.id).await
}

async fn list_agent_approvals_with_pool(
    pool: &SqlitePool,
    run_id: &str,
) -> Result<Vec<AgentApprovalRecord>, String> {
    let rows = sqlx::query(
        r#"
        SELECT * FROM approvals
        WHERE run_id = ?1
        ORDER BY created_at ASC, id ASC
        "#,
    )
    .bind(run_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to list approvals: {error}"))?;

    rows.into_iter().map(row_to_approval).collect()
}

async fn get_pending_agent_approval_with_pool(
    pool: &SqlitePool,
    run_id: &str,
    now: &str,
) -> Result<Option<AgentApprovalRecord>, String> {
    let row = sqlx::query(
        r#"
        SELECT * FROM approvals
        WHERE run_id = ?1
          AND resolved_at IS NULL
          AND decision IS NULL
          AND expires_at > ?2
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        "#,
    )
    .bind(run_id)
    .bind(now)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to read pending approval: {error}"))?;

    row.map(row_to_approval).transpose()
}

async fn resolve_agent_approval_with_pool(
    pool: &SqlitePool,
    resolution: AgentApprovalResolveInput,
) -> Result<AgentApprovalRecord, String> {
    validate_approval_decision(&resolution.decision)?;
    let existing = sqlx::query(
        r#"
        SELECT * FROM approvals
        WHERE id = ?1
          AND run_id = ?2
          AND decision IS NULL
          AND resolved_at IS NULL
        "#,
    )
    .bind(&resolution.approval_id)
    .bind(&resolution.run_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to read approval before resolve: {error}"))?;
    let approval = existing
        .map(row_to_approval)
        .transpose()?
        .ok_or_else(|| "agent-storage: pending approval not found".to_string())?;

    if resolution.decision != "expired" && approval.expires_at <= resolution.resolved_at {
        return Err("agent-storage: approval expired before resolution".to_string());
    }

    let result = sqlx::query(
        r#"
        UPDATE approvals
        SET decision = ?1,
            resolved_at = ?2
        WHERE id = ?3
          AND run_id = ?4
          AND decision IS NULL
          AND resolved_at IS NULL
        "#,
    )
    .bind(&resolution.decision)
    .bind(&resolution.resolved_at)
    .bind(&resolution.approval_id)
    .bind(&resolution.run_id)
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to resolve approval: {error}"))?;

    if result.rows_affected() != 1 {
        return Err("agent-storage: pending approval not found".to_string());
    }

    read_agent_approval_with_pool(pool, &resolution.approval_id).await
}

async fn claim_agent_approval_with_pool(
    pool: &SqlitePool,
    claim: AgentApprovalClaimInput,
) -> Result<AgentApprovalRecord, String> {
    let result = sqlx::query(
        r#"
        UPDATE approvals
        SET consumed_at = ?1,
            consumed_tool_call_id = ?2
        WHERE id = ?3
          AND run_id = ?4
          AND decision = 'approved'
          AND normalized_args_hash = ?5
          AND consumed_at IS NULL
        "#,
    )
    .bind(&claim.consumed_at)
    .bind(&claim.tool_call_id)
    .bind(&claim.approval_id)
    .bind(&claim.run_id)
    .bind(&claim.normalized_args_hash)
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to claim approval: {error}"))?;

    if result.rows_affected() != 1 {
        return Err("agent-storage: approval consumption claim failed".to_string());
    }

    read_agent_approval_with_pool(pool, &claim.approval_id).await
}

async fn read_agent_approval_with_pool(
    pool: &SqlitePool,
    approval_id: &str,
) -> Result<AgentApprovalRecord, String> {
    let row = sqlx::query("SELECT * FROM approvals WHERE id = ?1")
        .bind(approval_id)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read approval: {error}"))?;

    row_to_approval(row)
}

async fn save_agent_checkpoint_with_pool(
    pool: &SqlitePool,
    checkpoint: AgentCheckpointInput,
) -> Result<AgentCheckpointRecord, String> {
    let observations_json = serde_json::to_string(&checkpoint.observations)
        .map_err(|error| format!("agent-storage: failed to encode observations: {error}"))?;
    let changed_files_json = serde_json::to_string(&checkpoint.changed_files)
        .map_err(|error| format!("agent-storage: failed to encode changed files: {error}"))?;
    let deleted_files_json = serde_json::to_string(&checkpoint.deleted_files)
        .map_err(|error| format!("agent-storage: failed to encode deleted files: {error}"))?;
    let plan_json = serde_json::to_string(&checkpoint.plan)
        .map_err(|error| format!("agent-storage: failed to encode plan: {error}"))?;
    let read_snapshots_json = serde_json::to_string(&checkpoint.read_snapshots)
        .map_err(|error| format!("agent-storage: failed to encode read snapshots: {error}"))?;
    let repair_feedback_json = serde_json::to_string(&checkpoint.repair_feedback)
        .map_err(|error| format!("agent-storage: failed to encode repair feedback: {error}"))?;

    let mut transaction = pool.begin().await.map_err(|error| {
        format!("agent-storage: failed to begin checkpoint transaction: {error}")
    })?;
    let run_exists = sqlx::query("SELECT 1 FROM agent_runs WHERE id = ?1")
        .bind(&checkpoint.run_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("agent-storage: failed to validate checkpoint run: {error}"))?;

    if run_exists.is_none() {
        return Err("agent-storage: checkpoint run not found".to_string());
    }

    sqlx::query(
        r#"
        INSERT OR REPLACE INTO run_checkpoints (
            id, run_id, created_at, workspace_fingerprint, plan_json, observations_json,
            changed_files_json, deleted_files_json, package_changed, package_baseline_json, read_snapshots_json, latest_report_id,
            repair_feedback_json, steering_watermark
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
    )
    .bind(&checkpoint.id)
    .bind(&checkpoint.run_id)
    .bind(&checkpoint.created_at)
    .bind(&checkpoint.workspace_fingerprint)
    .bind(plan_json)
    .bind(observations_json)
    .bind(changed_files_json)
    .bind(deleted_files_json)
    .bind(bool_to_i64(checkpoint.package_changed))
    .bind(&checkpoint.package_baseline_json)
    .bind(read_snapshots_json)
    .bind(&checkpoint.latest_report_id)
    .bind(repair_feedback_json)
    .bind(checkpoint.steering_watermark)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("agent-storage: failed to save checkpoint: {error}"))?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("agent-storage: failed to commit checkpoint: {error}"))?;

    read_agent_checkpoint_with_pool(pool, &checkpoint.id).await
}

async fn get_latest_agent_checkpoint_with_pool(
    pool: &SqlitePool,
    run_id: &str,
) -> Result<Option<AgentCheckpointRecord>, String> {
    let row = sqlx::query(
        r#"
        SELECT * FROM run_checkpoints
        WHERE run_id = ?1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to read latest checkpoint: {error}"))?;

    row.map(row_to_checkpoint).transpose()
}

async fn read_agent_checkpoint_with_pool(
    pool: &SqlitePool,
    checkpoint_id: &str,
) -> Result<AgentCheckpointRecord, String> {
    let row = sqlx::query("SELECT * FROM run_checkpoints WHERE id = ?1")
        .bind(checkpoint_id)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read checkpoint: {error}"))?;

    row_to_checkpoint(row)
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
    let manifest_json: String = row
        .try_get("manifest_json")
        .unwrap_or_else(|_| fallback_manifest_json(&contract));
    let manifest = serde_json::from_str(&manifest_json)
        .map_err(|error| format!("agent-storage: failed to parse manifest json: {error}"))?;

    Ok(AgentRunRecord {
        id: row.try_get("id").map_err(row_error)?,
        project_id: row.try_get("project_id").map_err(row_error)?,
        conversation_id: row.try_get("conversation_id").map_err(row_error)?,
        contract,
        manifest,
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

fn fallback_manifest_json(contract: &Value) -> String {
    let objective = contract
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or("Agent task");
    let task_type = contract
        .get("taskType")
        .and_then(Value::as_str)
        .unwrap_or("component_edit");
    let allowed_paths = contract
        .pointer("/scope/allowedPaths")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let forbidden_paths = contract
        .pointer("/scope/forbiddenPaths")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let expected_files = contract
        .pointer("/source/expectedFiles")
        .cloned()
        .unwrap_or_else(|| json!([]));

    json!({
        "rawUserGoal": objective,
        "mode": if contract.pointer("/source/mode").and_then(Value::as_str) == Some("spec") { "spec" } else { "chat" },
        "projectGoal": objective,
        "conversationId": "",
        "projectId": "",
        "runtimeContract": {
            "taskType": task_type,
            "compiledAllowedPaths": allowed_paths,
            "forbiddenPaths": forbidden_paths,
            "expectedFiles": expected_files,
            "permissions": {
                "fileWrite": contract.pointer("/permissions/fileWrite").and_then(Value::as_bool).unwrap_or(true),
                "dependencyChange": contract.pointer("/permissions/dependencyChange").and_then(Value::as_str).unwrap_or("ask"),
                "databaseChange": contract.pointer("/permissions/databaseChange").and_then(Value::as_str).unwrap_or("deny"),
                "fileDelete": contract.pointer("/permissions/fileDelete").and_then(Value::as_str).unwrap_or("ask"),
                "previewDeployment": "ask",
                "productionDeployment": "ask"
            }
        },
        "antiDriftRules": [
            "TaskManifest is the source of truth.",
            "Do not expand scope beyond compiledAllowedPaths."
        ],
        "knownRisks": []
    })
    .to_string()
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

async fn read_agent_artifact_with_pool(
    pool: &SqlitePool,
    project_dir: &Path,
    artifact_id: &str,
) -> Result<Option<ArtifactReadRecord>, String> {
    let Some(row) = sqlx::query("SELECT * FROM artifacts WHERE id = ?1")
        .bind(artifact_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read artifact record: {error}"))?
    else {
        return Ok(None);
    };
    let record = row_to_artifact(row)?;
    let expected_prefix = format!("{}/{}/", ARTIFACTS_DIR, record.run_id);
    let relative_path = record.path.strip_prefix(&expected_prefix).ok_or_else(|| {
        "agent-storage: artifact record path does not match run directory".to_string()
    })?;
    let artifact_path = resolve_artifact_path(project_dir, &record.run_id, relative_path)?;
    let content = fs::read_to_string(&artifact_path).map_err(|error| {
        format!(
            "agent-storage: failed to read artifact '{}': {error}",
            artifact_path.display()
        )
    })?;

    if hash_text(&content) != record.hash {
        return Err("agent-storage: artifact hash mismatch".to_string());
    }

    Ok(Some(ArtifactReadRecord {
        id: record.id,
        run_id: record.run_id,
        path: record.path,
        hash: record.hash,
        size_bytes: record.size_bytes,
        created_at: record.created_at,
        content,
    }))
}

fn row_to_artifact(row: sqlx::sqlite::SqliteRow) -> Result<ArtifactRecord, String> {
    Ok(ArtifactRecord {
        id: row.try_get("id").map_err(row_error)?,
        run_id: row.try_get("run_id").map_err(row_error)?,
        path: row.try_get("path").map_err(row_error)?,
        hash: row.try_get("hash").map_err(row_error)?,
        size_bytes: row.try_get("size_bytes").map_err(row_error)?,
        created_at: row.try_get("created_at").map_err(row_error)?,
    })
}

fn row_to_approval(row: sqlx::sqlite::SqliteRow) -> Result<AgentApprovalRecord, String> {
    let target_resources_json: String = row.try_get("target_resources_json").map_err(row_error)?;

    Ok(AgentApprovalRecord {
        id: row.try_get("id").map_err(row_error)?,
        run_id: row.try_get("run_id").map_err(row_error)?,
        tool_call_id: row.try_get("tool_call_id").map_err(row_error)?,
        tool_name: row.try_get("tool_name").map_err(row_error)?,
        normalized_args_hash: row.try_get("normalized_args_hash").map_err(row_error)?,
        target_resources: serde_json::from_str(&target_resources_json).map_err(|error| {
            format!("agent-storage: failed to parse approval target resources: {error}")
        })?,
        exact_side_effect: row.try_get("exact_side_effect").map_err(row_error)?,
        created_at: row.try_get("created_at").map_err(row_error)?,
        expires_at: row.try_get("expires_at").map_err(row_error)?,
        resolved_at: row.try_get("resolved_at").map_err(row_error)?,
        decision: row.try_get("decision").map_err(row_error)?,
        consumed_at: row.try_get("consumed_at").map_err(row_error)?,
        consumed_tool_call_id: row.try_get("consumed_tool_call_id").map_err(row_error)?,
    })
}

fn row_to_checkpoint(row: sqlx::sqlite::SqliteRow) -> Result<AgentCheckpointRecord, String> {
    let plan_json: String = row.try_get("plan_json").map_err(row_error)?;
    let observations_json: String = row.try_get("observations_json").map_err(row_error)?;
    let changed_files_json: String = row.try_get("changed_files_json").map_err(row_error)?;
    let deleted_files_json: String = row.try_get("deleted_files_json").map_err(row_error)?;
    let read_snapshots_json: String = row.try_get("read_snapshots_json").map_err(row_error)?;
    let repair_feedback_json: String = row.try_get("repair_feedback_json").map_err(row_error)?;

    Ok(AgentCheckpointRecord {
        id: row.try_get("id").map_err(row_error)?,
        run_id: row.try_get("run_id").map_err(row_error)?,
        created_at: row.try_get("created_at").map_err(row_error)?,
        workspace_fingerprint: row.try_get("workspace_fingerprint").map_err(row_error)?,
        plan: serde_json::from_str(&plan_json)
            .map_err(|error| format!("agent-storage: failed to parse checkpoint plan: {error}"))?,
        observations: serde_json::from_str(&observations_json).map_err(|error| {
            format!("agent-storage: failed to parse checkpoint observations: {error}")
        })?,
        changed_files: serde_json::from_str(&changed_files_json).map_err(|error| {
            format!("agent-storage: failed to parse checkpoint changed files: {error}")
        })?,
        deleted_files: serde_json::from_str(&deleted_files_json).map_err(|error| {
            format!("agent-storage: failed to parse checkpoint deleted files: {error}")
        })?,
        package_changed: int_to_bool(row.try_get("package_changed").map_err(row_error)?),
        package_baseline_json: row.try_get("package_baseline_json").map_err(row_error)?,
        read_snapshots: serde_json::from_str(&read_snapshots_json).map_err(|error| {
            format!("agent-storage: failed to parse checkpoint read snapshots: {error}")
        })?,
        latest_report_id: row.try_get("latest_report_id").map_err(row_error)?,
        repair_feedback: serde_json::from_str(&repair_feedback_json).map_err(|error| {
            format!("agent-storage: failed to parse checkpoint repair feedback: {error}")
        })?,
        steering_watermark: row.try_get("steering_watermark").map_err(row_error)?,
    })
}

async fn migrate_agent_run_columns(pool: &SqlitePool) -> Result<(), String> {
    let has_is_write_run = table_has_column(pool, "agent_runs", "is_write_run").await?;
    let has_manifest_json = table_has_column(pool, "agent_runs", "manifest_json").await?;

    if !has_is_write_run {
        sqlx::query("ALTER TABLE agent_runs ADD COLUMN is_write_run INTEGER NOT NULL DEFAULT 1")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add run write-kind column: {error}")
            })?;
    }

    if !has_manifest_json {
        sqlx::query("ALTER TABLE agent_runs ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{}'")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add run manifest column: {error}")
            })?;
    }

    let rows = sqlx::query("SELECT id, contract_json FROM agent_runs")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to read runs for migration: {error}"))?;

    for row in rows {
        let id: String = row.try_get("id").map_err(row_error)?;
        let contract_json: String = row.try_get("contract_json").map_err(row_error)?;
        let contract = serde_json::from_str::<Value>(&contract_json).unwrap_or(Value::Null);
        sqlx::query("UPDATE agent_runs SET is_write_run = ?1 WHERE id = ?2")
            .bind(bool_to_i64(is_write_task_contract(&contract)))
            .bind(id)
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to backfill run write-kind: {error}")
            })?;

        sqlx::query(
            "UPDATE agent_runs SET manifest_json = ?1 WHERE id = ?2 AND manifest_json = '{}'",
        )
        .bind(fallback_manifest_json(&contract))
        .bind(&id)
        .execute(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to backfill run manifest: {error}"))?;
    }

    Ok(())
}

async fn migrate_approval_columns(pool: &SqlitePool) -> Result<(), String> {
    let has_normalized_args_hash =
        table_has_column(pool, "approvals", "normalized_args_hash").await?;
    let has_created_at = table_has_column(pool, "approvals", "created_at").await?;
    let has_consumed_at = table_has_column(pool, "approvals", "consumed_at").await?;
    let has_consumed_tool_call_id =
        table_has_column(pool, "approvals", "consumed_tool_call_id").await?;
    let has_legacy_args_hash = table_has_column(pool, "approvals", "args_hash").await?;

    if !has_normalized_args_hash {
        sqlx::query("ALTER TABLE approvals ADD COLUMN normalized_args_hash TEXT")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add approval normalized hash column: {error}")
            })?;
    }

    if !has_created_at {
        sqlx::query("ALTER TABLE approvals ADD COLUMN created_at TEXT")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add approval created_at column: {error}")
            })?;
    }

    if !has_consumed_at {
        sqlx::query("ALTER TABLE approvals ADD COLUMN consumed_at TEXT")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add approval consumed timestamp column: {error}")
            })?;
    }

    if !has_consumed_tool_call_id {
        sqlx::query("ALTER TABLE approvals ADD COLUMN consumed_tool_call_id TEXT")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add approval consumed tool call column: {error}")
            })?;
    }

    if has_legacy_args_hash {
        sqlx::query(
            r#"
            UPDATE approvals
            SET normalized_args_hash = args_hash
            WHERE normalized_args_hash IS NULL OR normalized_args_hash = ''
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| {
            format!("agent-storage: failed to migrate approval args hashes: {error}")
        })?;
    }

    sqlx::query(
        r#"
        UPDATE approvals
        SET created_at = COALESCE(created_at, expires_at)
        WHERE created_at IS NULL OR created_at = ''
        "#,
    )
    .execute(pool)
    .await
    .map_err(|error| format!("agent-storage: failed to migrate approval timestamps: {error}"))?;

    Ok(())
}

async fn migrate_checkpoint_columns(pool: &SqlitePool) -> Result<(), String> {
    let has_deleted_files_json =
        table_has_column(pool, "run_checkpoints", "deleted_files_json").await?;
    let has_package_baseline_json =
        table_has_column(pool, "run_checkpoints", "package_baseline_json").await?;

    if !has_deleted_files_json {
        sqlx::query(
            "ALTER TABLE run_checkpoints ADD COLUMN deleted_files_json TEXT NOT NULL DEFAULT '[]'",
        )
        .execute(pool)
        .await
        .map_err(|error| {
            format!("agent-storage: failed to add checkpoint deleted files column: {error}")
        })?;
    }

    if !has_package_baseline_json {
        sqlx::query("ALTER TABLE run_checkpoints ADD COLUMN package_baseline_json TEXT")
            .execute(pool)
            .await
            .map_err(|error| {
                format!("agent-storage: failed to add checkpoint package baseline column: {error}")
            })?;
    }

    Ok(())
}

fn is_write_task_contract(contract: &Value) -> bool {
    contract
        .get("taskType")
        .and_then(Value::as_str)
        .map(|task_type| task_type != "answer")
        .unwrap_or(true)
}

async fn table_has_column(
    pool: &SqlitePool,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let query = format!("PRAGMA table_info({table_name})");
    let rows = sqlx::query(&query)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("agent-storage: failed to inspect table columns: {error}"))?;

    for row in rows {
        let name: String = row.try_get("name").map_err(row_error)?;

        if name == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn validate_approval_decision(decision: &str) -> Result<(), String> {
    match decision {
        "approved" | "denied" | "expired" => Ok(()),
        _ => {
            Err("agent-storage: approval decision must be approved, denied, or expired".to_string())
        }
    }
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
    fn reads_artifact_content_by_id() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("agent-storage-artifact-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");
            insert_test_run(&pool, "run-artifact").await;
            let content = "$ npm run build\nexitCode=1\n\nError: broken build";
            let artifact_path = resolve_artifact_path(&root, "run-artifact", "verifier/build.log")
                .expect("artifact path");
            fs::write(&artifact_path, content).expect("write artifact");
            let relative_path = artifact_path
                .strip_prefix(root.join(METADATA_DIR))
                .expect("strip metadata")
                .to_string_lossy()
                .replace('\\', "/");

            sqlx::query(
                r#"
                INSERT INTO artifacts (id, run_id, path, hash, size_bytes, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
            )
            .bind("artifact-1")
            .bind("run-artifact")
            .bind(&relative_path)
            .bind(hash_text(content))
            .bind(content.len() as i64)
            .bind("2026-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .expect("insert artifact");

            let artifact = read_agent_artifact_with_pool(&pool, &root, "artifact-1")
                .await
                .expect("read artifact")
                .expect("artifact exists");

            assert_eq!(artifact.id, "artifact-1");
            assert_eq!(artifact.content, content);
            assert_eq!(artifact.path, "artifacts/run-artifact/verifier/build.log");
            assert_eq!(artifact.size_bytes, content.len() as i64);

            let _ = fs::remove_dir_all(root);
        });
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
                manifest: json!({ "rawUserGoal": "test" }),
                status: "created".to_string(),
                phase: "created".to_string(),
                started_at: "2026-01-01T00:00:00Z".to_string(),
                updated_at: "2026-01-01T00:00:00Z".to_string(),
            };
            let contract_json = serde_json::to_string(&run.contract).expect("contract json");
            let manifest_json = serde_json::to_string(&run.manifest).expect("manifest json");

            sqlx::query(
                r#"
                INSERT INTO agent_runs (
                    id, project_id, conversation_id, contract_json, manifest_json, status, phase,
                    state_version, model_turns, tool_calls, mutation_count, repair_cycles,
                    cancel_requested, pause_requested, started_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, 0, 0, 0, 0, 0, ?8, ?9)
                "#,
            )
            .bind(&run.id)
            .bind(&run.project_id)
            .bind(&run.conversation_id)
            .bind(contract_json)
            .bind(manifest_json)
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

    #[test]
    fn creates_lists_and_resolves_approvals() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("agent-storage-approval-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");

            insert_test_run(&pool, "run-approval").await;

            let approval = create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-1".to_string(),
                    run_id: "run-approval".to_string(),
                    tool_call_id: "tool-call-1".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:abcd".to_string(),
                    target_resources: vec!["app/page.tsx".to_string()],
                    exact_side_effect: "delete app/page.tsx".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2026-01-01T00:10:00Z".to_string(),
                },
            )
            .await
            .expect("create approval");

            assert_eq!(approval.normalized_args_hash, "12:abcd");
            assert_eq!(approval.decision, None);

            let approvals = list_agent_approvals_with_pool(&pool, "run-approval")
                .await
                .expect("list approvals");
            assert_eq!(approvals.len(), 1);

            let pending =
                get_pending_agent_approval_with_pool(&pool, "run-approval", "2026-01-01T00:01:00Z")
                    .await
                    .expect("pending approval")
                    .expect("pending exists");
            assert_eq!(pending.id, "approval-1");

            let resolved = resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-approval".to_string(),
                    approval_id: "approval-1".to_string(),
                    decision: "denied".to_string(),
                    resolved_at: "2026-01-01T00:02:00Z".to_string(),
                },
            )
            .await
            .expect("resolve approval");

            assert_eq!(resolved.decision.as_deref(), Some("denied"));
            let pending_after_resolve =
                get_pending_agent_approval_with_pool(&pool, "run-approval", "2026-01-01T00:03:00Z")
                    .await
                    .expect("pending after resolve");
            assert!(
                pending_after_resolve.is_none(),
                "resolved approvals must no longer be pending"
            );

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn atomically_claims_approved_authorization_once() {
        tauri::async_runtime::block_on(async {
            let root = std::env::temp_dir().join(format!("agent-storage-claim-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");

            insert_test_run(&pool, "run-claim").await;

            create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-claim".to_string(),
                    run_id: "run-claim".to_string(),
                    tool_call_id: "tool-call-request".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:claim".to_string(),
                    target_resources: vec!["app/page.tsx".to_string()],
                    exact_side_effect: "delete app/page.tsx".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2026-01-01T00:10:00Z".to_string(),
                },
            )
            .await
            .expect("create approval");

            resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-claim".to_string(),
                    approval_id: "approval-claim".to_string(),
                    decision: "approved".to_string(),
                    resolved_at: "2026-01-01T00:01:00Z".to_string(),
                },
            )
            .await
            .expect("approve authorization");

            let claimed = claim_agent_approval_with_pool(
                &pool,
                AgentApprovalClaimInput {
                    run_id: "run-claim".to_string(),
                    approval_id: "approval-claim".to_string(),
                    normalized_args_hash: "12:claim".to_string(),
                    tool_call_id: "tool-call-execute".to_string(),
                    consumed_at: "2026-01-01T00:02:00Z".to_string(),
                },
            )
            .await
            .expect("claim once");

            assert_eq!(claimed.consumed_at.as_deref(), Some("2026-01-01T00:02:00Z"));
            assert_eq!(
                claimed.consumed_tool_call_id.as_deref(),
                Some("tool-call-execute")
            );

            let second_claim = claim_agent_approval_with_pool(
                &pool,
                AgentApprovalClaimInput {
                    run_id: "run-claim".to_string(),
                    approval_id: "approval-claim".to_string(),
                    normalized_args_hash: "12:claim".to_string(),
                    tool_call_id: "tool-call-replay".to_string(),
                    consumed_at: "2026-01-01T00:03:00Z".to_string(),
                },
            )
            .await;
            assert!(second_claim.is_err(), "same approval must not claim twice");

            create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-wrong-hash".to_string(),
                    run_id: "run-claim".to_string(),
                    tool_call_id: "tool-call-request-2".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:expected".to_string(),
                    target_resources: vec!["components/Old.tsx".to_string()],
                    exact_side_effect: "delete components/Old.tsx".to_string(),
                    created_at: "2026-01-01T00:04:00Z".to_string(),
                    expires_at: "2026-01-01T00:10:00Z".to_string(),
                },
            )
            .await
            .expect("create second approval");

            resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-claim".to_string(),
                    approval_id: "approval-wrong-hash".to_string(),
                    decision: "approved".to_string(),
                    resolved_at: "2026-01-01T00:05:00Z".to_string(),
                },
            )
            .await
            .expect("approve second authorization");

            let wrong_hash = claim_agent_approval_with_pool(
                &pool,
                AgentApprovalClaimInput {
                    run_id: "run-claim".to_string(),
                    approval_id: "approval-wrong-hash".to_string(),
                    normalized_args_hash: "12:actual".to_string(),
                    tool_call_id: "tool-call-wrong".to_string(),
                    consumed_at: "2026-01-01T00:06:00Z".to_string(),
                },
            )
            .await;
            assert!(wrong_hash.is_err(), "hash mismatch must not claim approval");

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn rejects_late_approval_resolution_after_expiry() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("agent-storage-expired-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");

            insert_test_run(&pool, "run-expired-approval").await;

            create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-expired".to_string(),
                    run_id: "run-expired-approval".to_string(),
                    tool_call_id: "tool-call-expired".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:expired".to_string(),
                    target_resources: vec!["app/page.tsx".to_string()],
                    exact_side_effect: "delete app/page.tsx".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2026-01-01T00:01:00Z".to_string(),
                },
            )
            .await
            .expect("create approval");

            let pending_after_expiry = get_pending_agent_approval_with_pool(
                &pool,
                "run-expired-approval",
                "2026-01-01T00:02:00Z",
            )
            .await
            .expect("pending after expiry");
            assert!(
                pending_after_expiry.is_none(),
                "expired approvals must no longer be pending"
            );

            let approved = resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-expired-approval".to_string(),
                    approval_id: "approval-expired".to_string(),
                    decision: "approved".to_string(),
                    resolved_at: "2026-01-01T00:02:00Z".to_string(),
                },
            )
            .await;
            assert!(
                approved.is_err(),
                "expired approvals must not be approved after expiry"
            );

            create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-expired-denied".to_string(),
                    run_id: "run-expired-approval".to_string(),
                    tool_call_id: "tool-call-expired-denied".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:expired-denied".to_string(),
                    target_resources: vec!["components/Old.tsx".to_string()],
                    exact_side_effect: "delete components/Old.tsx".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2026-01-01T00:01:00Z".to_string(),
                },
            )
            .await
            .expect("create second approval");

            let denied = resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-expired-approval".to_string(),
                    approval_id: "approval-expired-denied".to_string(),
                    decision: "denied".to_string(),
                    resolved_at: "2026-01-01T00:02:00Z".to_string(),
                },
            )
            .await;
            assert!(
                denied.is_err(),
                "expired approvals must not be denied after expiry"
            );

            create_agent_approval_with_pool(
                &pool,
                AgentApprovalCreateInput {
                    id: "approval-expired-marker".to_string(),
                    run_id: "run-expired-approval".to_string(),
                    tool_call_id: "tool-call-expired-marker".to_string(),
                    tool_name: "delete_files".to_string(),
                    normalized_args_hash: "12:expired-marker".to_string(),
                    target_resources: vec!["components/Marker.tsx".to_string()],
                    exact_side_effect: "delete components/Marker.tsx".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                    expires_at: "2026-01-01T00:01:00Z".to_string(),
                },
            )
            .await
            .expect("create expiry marker approval");

            let expired = resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-expired-approval".to_string(),
                    approval_id: "approval-expired-marker".to_string(),
                    decision: "expired".to_string(),
                    resolved_at: "2026-01-01T00:02:00Z".to_string(),
                },
            )
            .await
            .expect("mark approval expired");
            assert_eq!(expired.decision.as_deref(), Some("expired"));

            let second_resolution = resolve_agent_approval_with_pool(
                &pool,
                AgentApprovalResolveInput {
                    run_id: "run-expired-approval".to_string(),
                    approval_id: "approval-expired-marker".to_string(),
                    decision: "approved".to_string(),
                    resolved_at: "2026-01-01T00:02:30Z".to_string(),
                },
            )
            .await;
            assert!(
                second_resolution.is_err(),
                "resolved approvals must not accept a second decision"
            );

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn rejects_second_active_write_run_but_allows_answer_run() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("agent-storage-single-run-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");

            create_agent_run_with_pool(&pool, test_run_input("run-write-1", "component_edit"))
                .await
                .expect("first write run");

            let second_write =
                create_agent_run_with_pool(&pool, test_run_input("run-write-2", "style_edit"))
                    .await;
            assert!(
                second_write.is_err(),
                "a project may only have one active write run"
            );

            create_agent_run_with_pool(&pool, test_run_input("run-answer-1", "answer"))
                .await
                .expect("answer run can run beside an active write run");

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn persists_and_reads_latest_checkpoint() {
        tauri::async_runtime::block_on(async {
            let root =
                std::env::temp_dir().join(format!("agent-storage-checkpoint-{}", rand_suffix()));
            fs::create_dir_all(root.join(METADATA_DIR)).expect("create metadata dir");
            let pool = open_project_agent_db(&root).await.expect("open db");

            insert_test_run(&pool, "run-checkpoint").await;

            save_agent_checkpoint_with_pool(
                &pool,
                test_checkpoint_input("checkpoint-1", "run-checkpoint", "fingerprint:one"),
            )
            .await
            .expect("first checkpoint");
            let latest = save_agent_checkpoint_with_pool(
                &pool,
                AgentCheckpointInput {
                    created_at: "2026-01-01T00:01:00Z".to_string(),
                    ..test_checkpoint_input("checkpoint-2", "run-checkpoint", "fingerprint:two")
                },
            )
            .await
            .expect("second checkpoint");

            assert_eq!(latest.workspace_fingerprint, "fingerprint:two");

            let read = get_latest_agent_checkpoint_with_pool(&pool, "run-checkpoint")
                .await
                .expect("read latest checkpoint")
                .expect("latest checkpoint exists");

            assert_eq!(read.id, "checkpoint-2");
            assert_eq!(read.changed_files, vec!["app/page.tsx"]);
            assert_eq!(read.deleted_files, vec!["components/Old.tsx"]);
            assert!(read.package_changed);
            assert_eq!(
                read.package_baseline_json.as_deref(),
                Some("{\"dependencies\":{}}")
            );
            assert_eq!(read.repair_feedback, vec!["repair this"]);
            assert_eq!(read.steering_watermark, 7);

            let _ = fs::remove_dir_all(root);
        });
    }

    async fn insert_test_run(pool: &SqlitePool, run_id: &str) {
        let contract_json =
            serde_json::to_string(&json!({ "objective": "test" })).expect("contract json");

        sqlx::query(
            r#"
            INSERT INTO agent_runs (
                id, project_id, conversation_id, contract_json, manifest_json, status, phase,
                state_version, model_turns, tool_calls, mutation_count, repair_cycles,
                cancel_requested, pause_requested, started_at, updated_at
            ) VALUES (?1, 'project-1', 'conversation-1', ?2, ?3, 'created', 'created',
                0, 0, 0, 0, 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
            "#,
        )
        .bind(run_id)
        .bind(contract_json)
        .bind(json!({ "rawUserGoal": "test" }).to_string())
        .execute(pool)
        .await
        .expect("insert test run");
    }

    fn test_run_input(run_id: &str, task_type: &str) -> AgentRunCreateInput {
        AgentRunCreateInput {
            id: run_id.to_string(),
            project_id: "project-1".to_string(),
            conversation_id: "conversation-1".to_string(),
            contract: json!({
                "objective": "test",
                "taskType": task_type
            }),
            manifest: json!({ "rawUserGoal": "test" }),
            status: "created".to_string(),
            phase: "created".to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    fn test_checkpoint_input(
        checkpoint_id: &str,
        run_id: &str,
        fingerprint: &str,
    ) -> AgentCheckpointInput {
        AgentCheckpointInput {
            id: checkpoint_id.to_string(),
            run_id: run_id.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            workspace_fingerprint: fingerprint.to_string(),
            plan: json!({ "steps": ["inspect", "edit"] }),
            observations: vec![json!({ "summary": "read file" })],
            changed_files: vec!["app/page.tsx".to_string()],
            deleted_files: vec!["components/Old.tsx".to_string()],
            package_changed: true,
            package_baseline_json: Some("{\"dependencies\":{}}".to_string()),
            read_snapshots: vec![json!({
                "path": "app/page.tsx",
                "contentHash": "12:abcd",
                "readAt": "2026-01-01T00:00:00Z"
            })],
            latest_report_id: Some("report-1".to_string()),
            repair_feedback: vec!["repair this".to_string()],
            steering_watermark: 7,
        }
    }
}
