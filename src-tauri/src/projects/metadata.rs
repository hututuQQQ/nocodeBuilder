use std::{
    fs,
    path::{Path, PathBuf},
};

use super::{
    types::ProjectInfo,
    workspace::{current_timestamp, FRAMEWORK},
};

pub const METADATA_DIR: &str = ".nocodebuilder";
const METADATA_FILE: &str = "project.json";

pub fn read_metadata(project_dir: &Path) -> Result<ProjectInfo, String> {
    let metadata_path = metadata_path(project_dir);
    let content = fs::read_to_string(&metadata_path).map_err(|error| {
        format!(
            "project: failed to read project metadata '{}': {error}",
            metadata_path.display()
        )
    })?;
    let mut info = serde_json::from_str::<ProjectInfo>(&content)
        .map_err(|error| format!("project: failed to parse project metadata: {error}"))?;

    info.path = project_dir.to_string_lossy().to_string();
    info.framework = FRAMEWORK.to_string();

    Ok(info)
}

pub fn write_metadata(project_dir: &Path, info: &ProjectInfo) -> Result<(), String> {
    let metadata_dir = project_dir.join(METADATA_DIR);
    fs::create_dir_all(&metadata_dir).map_err(|error| {
        format!(
            "project: failed to create metadata directory '{}': {error}",
            metadata_dir.display()
        )
    })?;

    let metadata_path = metadata_path(project_dir);
    let content = serde_json::to_string_pretty(info)
        .map_err(|error| format!("project: failed to serialize project metadata: {error}"))?;

    fs::write(&metadata_path, content).map_err(|error| {
        format!(
            "project: failed to write project metadata '{}': {error}",
            metadata_path.display()
        )
    })
}

pub fn touch_project_metadata(
    project_dir: &Path,
    update_modified: bool,
    update_last_opened: bool,
) -> Result<(), String> {
    let mut info = read_metadata(project_dir)?;
    let now = current_timestamp();

    if update_modified {
        info.updated_at = now.clone();
    }

    if update_last_opened {
        info.last_opened_at = now;
    }

    write_metadata(project_dir, &info)
}

fn metadata_path(project_dir: &Path) -> PathBuf {
    project_dir.join(METADATA_DIR).join(METADATA_FILE)
}
