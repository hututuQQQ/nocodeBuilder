use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

const APP_STORAGE_DIR_NAME: &str = "AIWebBuilder";
const APP_STORAGE_STATE_DIR: &str = "state";

#[tauri::command]
pub fn read_app_storage(key: String) -> Result<Option<Value>, String> {
    let path = storage_file_path(&key)?;

    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "app-storage: failed to read '{}': {error}",
            path.display()
        )
    })?;
    let value = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("app-storage: failed to parse stored JSON: {error}"))?;

    Ok(Some(value))
}

#[tauri::command]
pub fn write_app_storage(key: String, value: Value) -> Result<(), String> {
    let path = storage_file_path(&key)?;
    let parent = path
        .parent()
        .ok_or_else(|| "app-storage: failed to resolve storage directory".to_string())?;

    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "app-storage: failed to create '{}': {error}",
            parent.display()
        )
    })?;

    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("app-storage: failed to serialize JSON: {error}"))?;

    fs::write(&path, content).map_err(|error| {
        format!(
            "app-storage: failed to write '{}': {error}",
            path.display()
        )
    })
}

fn storage_file_path(key: &str) -> Result<PathBuf, String> {
    Ok(storage_dir()?.join(storage_file_name(key)?))
}

fn storage_file_name(key: &str) -> Result<&'static str, String> {
    match key {
        "ai-provider-config" => Ok("ai-provider-config.v3.json"),
        "project-memory" => Ok("project-memory.v1.json"),
        _ => Err("app-storage: unknown storage key".to_string()),
    }
}

fn storage_dir() -> Result<PathBuf, String> {
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        return Ok(state_dir(PathBuf::from(local_app_data)));
    }

    if let Some(app_data) = env::var_os("APPDATA") {
        return Ok(state_dir(PathBuf::from(app_data)));
    }

    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .ok_or_else(|| "app-storage: failed to resolve user data directory".to_string())?;

    Ok(PathBuf::from(home)
        .join(format!(".{}", APP_STORAGE_DIR_NAME.to_ascii_lowercase()))
        .join(APP_STORAGE_STATE_DIR))
}

fn state_dir(base: PathBuf) -> PathBuf {
    base.join(Path::new(APP_STORAGE_DIR_NAME))
        .join(APP_STORAGE_STATE_DIR)
}
