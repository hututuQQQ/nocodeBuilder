use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::{metadata::METADATA_DIR, types::ProjectChangeRecord, workspace::resolve_project_dir};

const CHANGE_HISTORY_FILE: &str = "change-history.json";
const MAX_CHANGE_HISTORY_RECORDS: usize = 50;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeHistoryFile {
    records: Vec<ProjectChangeRecord>,
}

pub fn list_project_change_history(project_id: String) -> Result<Vec<ProjectChangeRecord>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let mut history = read_change_history_file(&project_dir)?;

    history
        .records
        .retain(|record| record.project_id == project_id);
    Ok(history.records)
}

pub fn save_project_change_history(
    project_id: String,
    records: Vec<ProjectChangeRecord>,
) -> Result<(), String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let mut project_records = records
        .into_iter()
        .filter(|record| record.project_id == project_id)
        .collect::<Vec<_>>();

    project_records.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    project_records.truncate(MAX_CHANGE_HISTORY_RECORDS);

    write_change_history_file(
        &project_dir,
        &ChangeHistoryFile {
            records: project_records,
        },
    )
}

fn read_change_history_file(project_dir: &Path) -> Result<ChangeHistoryFile, String> {
    let path = change_history_path(project_dir);

    if !path.exists() {
        return Ok(ChangeHistoryFile::default());
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "change-history: failed to read change history '{}': {error}",
            path.display()
        )
    })?;

    serde_json::from_str::<ChangeHistoryFile>(&content)
        .map_err(|error| format!("change-history: failed to parse change history: {error}"))
}

fn write_change_history_file(
    project_dir: &Path,
    history: &ChangeHistoryFile,
) -> Result<(), String> {
    let metadata_dir = project_dir.join(METADATA_DIR);
    fs::create_dir_all(&metadata_dir).map_err(|error| {
        format!(
            "change-history: failed to create metadata directory '{}': {error}",
            metadata_dir.display()
        )
    })?;

    let path = change_history_path(project_dir);
    let content = serde_json::to_string_pretty(history)
        .map_err(|error| format!("change-history: failed to serialize change history: {error}"))?;

    fs::write(&path, content).map_err(|error| {
        format!(
            "change-history: failed to write change history '{}': {error}",
            path.display()
        )
    })
}

fn change_history_path(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(METADATA_DIR).join(CHANGE_HISTORY_FILE)
}
