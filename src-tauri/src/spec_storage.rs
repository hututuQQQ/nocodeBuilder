use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::projects;

const SPECS_DIR: &str = "specs";

#[tauri::command]
pub fn create_development_spec(project_id: String, spec: Value) -> Result<Value, String> {
    let spec_id = read_required_string(&spec, "id")?.to_string();
    let project_dir = projects::resolve_project_dir(&project_id)?;
    let path = spec_file_path(&project_dir, &spec_id)?;

    if path.exists() {
        return Err("spec: spec already exists".to_string());
    }

    validate_spec_identity(&project_id, &spec)?;
    write_spec_value(&project_dir, &spec_id, &spec)?;
    Ok(spec)
}

#[tauri::command]
pub fn read_development_spec(project_id: String, spec_id: String) -> Result<Value, String> {
    let project_dir = projects::resolve_project_dir(&project_id)?;
    let spec = read_spec_value(&project_dir, &spec_id)?;

    validate_spec_envelope(&project_id, &spec)?;
    Ok(spec)
}

#[tauri::command]
pub fn save_development_spec(project_id: String, spec: Value) -> Result<Value, String> {
    let spec_id = read_required_string(&spec, "id")?.to_string();
    let project_dir = projects::resolve_project_dir(&project_id)?;

    validate_spec_envelope(&project_id, &spec)?;
    write_spec_value(&project_dir, &spec_id, &spec)?;
    Ok(spec)
}

#[tauri::command]
pub fn delete_development_spec(project_id: String, spec_id: String) -> Result<(), String> {
    let project_dir = projects::resolve_project_dir(&project_id)?;
    let spec = match read_spec_value(&project_dir, &spec_id) {
        Ok(spec) => spec,
        Err(error) if error.contains("was not found") => return Ok(()),
        Err(error) => return Err(error),
    };

    validate_spec_envelope(&project_id, &spec)?;
    let conversation_id = read_required_string(&spec, "conversationId")?.to_string();

    if let Ok(conversation) =
        projects::read_project_conversation(project_id.clone(), conversation_id)
    {
        if conversation.spec_ids.iter().any(|item| item == &spec_id) {
            return Err("spec: attached conversation specs cannot be deleted".to_string());
        }
    }

    let path = spec_file_path(&project_dir, &spec_id)?;

    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            format!("spec: failed to delete spec '{}': {error}", path.display())
        })?;
    }

    Ok(())
}

fn validate_spec_envelope(project_id: &str, spec: &Value) -> Result<(), String> {
    validate_spec_identity(project_id, spec)?;
    let conversation_id = read_required_string(spec, "conversationId")?;

    let conversation =
        projects::read_project_conversation(project_id.to_string(), conversation_id.to_string())?;

    if conversation.project_id != project_id {
        return Err("spec: conversation does not belong to project".to_string());
    }

    Ok(())
}

fn validate_spec_identity(project_id: &str, spec: &Value) -> Result<(), String> {
    let spec_project_id = read_required_string(spec, "projectId")?;
    let spec_id = read_required_string(spec, "id")?;

    validate_spec_id(spec_id)?;

    if spec_project_id != project_id {
        return Err("spec: spec projectId does not match command projectId".to_string());
    }

    read_required_string(spec, "conversationId")?;
    Ok(())
}

fn read_spec_value(project_dir: &Path, spec_id: &str) -> Result<Value, String> {
    let path = spec_file_path(project_dir, spec_id)?;
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "spec: spec '{}' was not found or unreadable: {error}",
            path.display()
        )
    })?;

    serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("spec: failed to parse spec JSON: {error}"))
}

fn write_spec_value(project_dir: &Path, spec_id: &str, spec: &Value) -> Result<(), String> {
    let path = spec_file_path(project_dir, spec_id)?;
    let dir = specs_dir(project_dir);

    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "spec: failed to create specs directory '{}': {error}",
            dir.display()
        )
    })?;

    let content = serde_json::to_string_pretty(spec)
        .map_err(|error| format!("spec: failed to serialize spec: {error}"))?;
    let tmp_path = dir.join(format!(
        ".{spec_id}.{}.tmp",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    fs::write(&tmp_path, content).map_err(|error| {
        format!(
            "spec: failed to write temporary spec '{}': {error}",
            tmp_path.display()
        )
    })?;

    match fs::rename(&tmp_path, &path) {
        Ok(()) => Ok(()),
        Err(rename_error) if path.exists() => {
            fs::remove_file(&path).map_err(|remove_error| {
                let _ = fs::remove_file(&tmp_path);
                format!(
                    "spec: failed to replace existing spec '{}': {remove_error}; rename error: {rename_error}",
                    path.display()
                )
            })?;
            fs::rename(&tmp_path, &path).map_err(|error| {
                let _ = fs::remove_file(&tmp_path);
                format!(
                    "spec: failed to move spec into place '{}': {error}",
                    path.display()
                )
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp_path);
            Err(format!(
                "spec: failed to move spec into place '{}': {error}",
                path.display()
            ))
        }
    }
}

fn spec_file_path(project_dir: &Path, spec_id: &str) -> Result<PathBuf, String> {
    validate_spec_id(spec_id)?;
    Ok(specs_dir(project_dir).join(format!("{spec_id}.json")))
}

fn specs_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".aibuilder").join(SPECS_DIR)
}

fn validate_spec_id(spec_id: &str) -> Result<(), String> {
    if spec_id.is_empty()
        || !spec_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("spec: invalid spec id".to_string());
    }

    Ok(())
}

fn read_required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .ok_or_else(|| format!("spec: {field} is required"))
}
