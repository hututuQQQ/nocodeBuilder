use std::{fs, process::Command};

use super::{
    metadata::{read_metadata, touch_project_metadata, write_metadata},
    types::ProjectInfo,
    workspace::{
        current_timestamp, ensure_child_path, ensure_workspace_dir, normalize_project_name,
        resolve_project_dir, slugify_project_name, unique_project_id, FRAMEWORK,
    },
};

pub fn create_project(project_name: String) -> Result<ProjectInfo, String> {
    let name = normalize_project_name(&project_name)?;
    let workspace = ensure_workspace_dir()?;
    let id = unique_project_id(&workspace, &slugify_project_name(&name))?;
    let project_dir = workspace.join(&id);

    fs::create_dir_all(&project_dir).map_err(|error| {
        format!(
            "project: failed to create project directory '{}': {error}",
            project_dir.display()
        )
    })?;

    let now = current_timestamp();
    let project_dir = project_dir
        .canonicalize()
        .map_err(|error| format!("project: failed to resolve project directory: {error}"))?;
    ensure_child_path(&workspace, &project_dir)?;

    let info = ProjectInfo {
        id,
        name,
        path: project_dir.to_string_lossy().to_string(),
        framework: FRAMEWORK.to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_opened_at: now,
    };

    write_metadata(&project_dir, &info)?;
    Ok(info)
}

pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let workspace = ensure_workspace_dir()?;
    let entries = fs::read_dir(&workspace).map_err(|error| {
        format!(
            "project: failed to read workspace '{}': {error}",
            workspace.display()
        )
    })?;
    let mut projects = Vec::new();

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("project: failed to read workspace entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("project: failed to inspect workspace entry: {error}"))?;

        if !file_type.is_dir() {
            continue;
        }

        if let Ok(project_dir) = entry.path().canonicalize() {
            if ensure_child_path(&workspace, &project_dir).is_err() {
                continue;
            }

            if let Ok(info) = read_metadata(&project_dir) {
                projects.push(info);
            }
        }
    }

    projects.sort_by(|left, right| {
        right
            .last_opened_at
            .cmp(&left.last_opened_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(projects)
}

pub fn open_project_folder(project_id: String) -> Result<(), String> {
    let project_dir = resolve_project_dir(&project_id)?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&project_dir);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&project_dir);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&project_dir);
        command
    };

    command.spawn().map_err(|error| {
        format!(
            "project: failed to open project folder '{}': {error}",
            project_dir.display()
        )
    })?;

    touch_project_metadata(&project_dir, false, true)?;
    Ok(())
}
