use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const FRAMEWORK: &str = "next-app-router";
const WORKSPACE_DIR_NAME: &str = "AIBuilderProjects";
const METADATA_DIR: &str = ".aibuilder";
const METADATA_FILE: &str = "project.json";
const SKIPPED_DIRS: [&str; 5] = [METADATA_DIR, "node_modules", "dist", ".next", ".git"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    id: String,
    name: String,
    path: String,
    framework: String,
    created_at: String,
    updated_at: String,
    last_opened_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTree {
    name: String,
    path: String,
    kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<FileTree>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileInput {
    path: String,
    content: String,
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn list_files(project_id: String) -> Result<FileTree, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let info = read_metadata(&project_dir)?;

    build_file_tree(&project_dir, &project_dir, &info.name)
}

#[tauri::command]
pub fn read_file(project_id: String, path: String) -> Result<String, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let file_path = resolve_existing_file_path(&project_dir, &path)?;

    fs::read_to_string(&file_path).map_err(|error| {
        format!(
            "project: failed to read file '{}': {error}",
            path_to_slash(&file_path)
        )
    })
}

#[tauri::command]
pub fn write_file(project_id: String, path: String, content: String) -> Result<(), String> {
    write_files(project_id, vec![ProjectFileInput { path, content }])
}

#[tauri::command]
pub fn write_files(project_id: String, files: Vec<ProjectFileInput>) -> Result<(), String> {
    let project_dir = resolve_project_dir(&project_id)?;

    if files.is_empty() {
        return Ok(());
    }

    let mut targets = Vec::with_capacity(files.len());

    for file in &files {
        let target = prepare_write_target(&project_dir, &file.path)?;
        targets.push(target);
    }

    for (file, target) in files.iter().zip(targets.iter()) {
        fs::write(target, &file.content)
            .map_err(|error| format!("project: failed to write file '{}': {error}", file.path))?;
    }

    touch_project_metadata(&project_dir, true, false)?;
    Ok(())
}

#[tauri::command]
pub fn delete_files(project_id: String, paths: Vec<String>) -> Result<(), String> {
    let project_dir = resolve_project_dir(&project_id)?;

    if paths.is_empty() {
        return Ok(());
    }

    let mut targets = Vec::with_capacity(paths.len());

    for path in &paths {
        let target = resolve_optional_file_path(&project_dir, path)?;
        targets.push(target);
    }

    for target in targets.iter().flatten() {
        fs::remove_file(target).map_err(|error| {
            format!(
                "project: failed to delete file '{}': {error}",
                path_to_slash(target)
            )
        })?;
    }

    touch_project_metadata(&project_dir, true, false)?;
    Ok(())
}

#[tauri::command]
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

fn normalize_project_name(project_name: &str) -> Result<String, String> {
    let name = project_name.trim();

    if name.is_empty() {
        return Err("project: project name is required".to_string());
    }

    Ok(name.to_string())
}

fn workspace_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .ok_or_else(|| "project: failed to resolve user home directory".to_string())?;

    Ok(PathBuf::from(home).join(WORKSPACE_DIR_NAME))
}

fn ensure_workspace_dir() -> Result<PathBuf, String> {
    let workspace = workspace_dir()?;

    fs::create_dir_all(&workspace).map_err(|error| {
        format!(
            "project: failed to create workspace '{}': {error}",
            workspace.display()
        )
    })?;

    workspace
        .canonicalize()
        .map_err(|error| format!("project: failed to resolve workspace directory: {error}"))
}

pub(crate) fn resolve_project_dir(project_id: &str) -> Result<PathBuf, String> {
    validate_project_id(project_id)?;

    let workspace = ensure_workspace_dir()?;
    let project_dir = workspace.join(project_id);
    let project_dir = project_dir
        .canonicalize()
        .map_err(|_| format!("project: project '{project_id}' was not found"))?;

    ensure_child_path(&workspace, &project_dir)?;
    read_metadata(&project_dir)?;

    Ok(project_dir)
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty()
        || !project_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("project: invalid project id".to_string());
    }

    Ok(())
}

fn ensure_child_path(parent: &Path, child: &Path) -> Result<(), String> {
    if !child.starts_with(parent) {
        return Err("project: path escaped the workspace".to_string());
    }

    Ok(())
}

fn slugify_project_name(project_name: &str) -> String {
    let mut slug = String::new();
    let mut previous_was_dash = false;

    for character in project_name.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_was_dash = false;
        } else if !previous_was_dash && !slug.is_empty() {
            slug.push('-');
            previous_was_dash = true;
        }
    }

    while slug.ends_with('-') {
        slug.pop();
    }

    if slug.is_empty() {
        format!("project-{}", Utc::now().timestamp())
    } else {
        slug
    }
}

fn unique_project_id(workspace: &Path, base_id: &str) -> Result<String, String> {
    let mut candidate = base_id.to_string();
    let mut suffix = 2;

    while workspace.join(&candidate).exists() {
        candidate = format!("{base_id}-{suffix}");
        suffix += 1;

        if suffix > 10_000 {
            return Err("project: failed to create a unique project id".to_string());
        }
    }

    Ok(candidate)
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn metadata_path(project_dir: &Path) -> PathBuf {
    project_dir.join(METADATA_DIR).join(METADATA_FILE)
}

fn read_metadata(project_dir: &Path) -> Result<ProjectInfo, String> {
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

fn write_metadata(project_dir: &Path, info: &ProjectInfo) -> Result<(), String> {
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

fn touch_project_metadata(
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

fn validate_relative_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();

    if path.is_empty() {
        return Err("project: file path is required".to_string());
    }

    let raw_path = Path::new(path);

    if raw_path.is_absolute() {
        return Err("project: absolute paths are not allowed".to_string());
    }

    let mut normalized = PathBuf::new();

    for component in raw_path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err("project: path traversal is not allowed".to_string());
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("project: file path is required".to_string());
    }

    if normalized
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == std::ffi::OsStr::new(METADATA_DIR))
    {
        return Err("project: writing project metadata is not allowed".to_string());
    }

    Ok(normalized)
}

fn resolve_existing_file_path(project_dir: &Path, path: &str) -> Result<PathBuf, String> {
    let relative_path = validate_relative_path(path)?;
    let target = project_dir.join(relative_path);
    let target = target
        .canonicalize()
        .map_err(|_| format!("project: file '{path}' was not found"))?;

    ensure_child_path(project_dir, &target)?;

    if !target.is_file() {
        return Err(format!("project: '{path}' is not a file"));
    }

    Ok(target)
}

fn resolve_optional_file_path(project_dir: &Path, path: &str) -> Result<Option<PathBuf>, String> {
    let relative_path = validate_relative_path(path)?;
    let target = project_dir.join(relative_path);

    if !target.exists() {
        return Ok(None);
    }

    let target = target
        .canonicalize()
        .map_err(|error| format!("project: failed to resolve file '{path}': {error}"))?;
    ensure_child_path(project_dir, &target)?;

    if !target.is_file() {
        return Err(format!("project: '{path}' is not a file"));
    }

    Ok(Some(target))
}

fn prepare_write_target(project_dir: &Path, path: &str) -> Result<PathBuf, String> {
    let relative_path = validate_relative_path(path)?;
    let target = project_dir.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "project: invalid file path".to_string())?;

    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "project: failed to create parent directory '{}': {error}",
            parent.display()
        )
    })?;

    let parent = parent
        .canonicalize()
        .map_err(|error| format!("project: failed to resolve parent directory: {error}"))?;
    ensure_child_path(project_dir, &parent)?;

    if target.exists() {
        let resolved_target = target
            .canonicalize()
            .map_err(|error| format!("project: failed to resolve target file: {error}"))?;
        ensure_child_path(project_dir, &resolved_target)?;

        if resolved_target.is_dir() {
            return Err(format!("project: '{path}' is a directory"));
        }
    }

    Ok(target)
}

fn build_file_tree(root: &Path, current: &Path, root_name: &str) -> Result<FileTree, String> {
    let metadata = fs::metadata(current).map_err(|error| {
        format!(
            "project: failed to inspect file tree path '{}': {error}",
            current.display()
        )
    })?;
    let relative_path = current
        .strip_prefix(root)
        .map_err(|_| "project: file tree escaped project root".to_string())?;
    let path = path_to_slash(relative_path);
    let name = if relative_path.as_os_str().is_empty() {
        root_name.to_string()
    } else {
        current
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string()
    };

    if metadata.is_file() {
        return Ok(FileTree {
            name,
            path,
            kind: "file".to_string(),
            children: Vec::new(),
        });
    }

    let mut children = Vec::new();

    for entry in fs::read_dir(current).map_err(|error| {
        format!(
            "project: failed to read directory '{}': {error}",
            current.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("project: failed to read directory entry: {error}"))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        if SKIPPED_DIRS.contains(&file_name.as_str()) {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("project: failed to inspect directory entry: {error}"))?;

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() || file_type.is_file() {
            children.push(build_file_tree(root, &entry.path(), root_name)?);
        }
    }

    children.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(FileTree {
        name,
        path,
        kind: "directory".to_string(),
        children,
    })
}

fn path_to_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_paths() {
        let absolute_path = if cfg!(windows) {
            "C:/outside.tsx"
        } else {
            "/outside.tsx"
        };

        assert!(validate_relative_path("../outside.tsx").is_err());
        assert!(validate_relative_path("src/../../outside.tsx").is_err());
        assert!(validate_relative_path(absolute_path).is_err());
    }

    #[test]
    fn rejects_metadata_writes() {
        assert!(validate_relative_path(".aibuilder/project.json").is_err());
    }

    #[test]
    fn slugifies_project_names() {
        assert_eq!(slugify_project_name("Pet Care Site"), "pet-care-site");
        assert_eq!(slugify_project_name("  CRM__Dashboard!! "), "crm-dashboard");
    }
}
