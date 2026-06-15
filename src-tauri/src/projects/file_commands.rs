use std::{
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

use super::{
    metadata::{read_metadata, touch_project_metadata, METADATA_DIR},
    types::{FileTree, ProjectFileInput},
    workspace::{ensure_child_path, resolve_project_dir},
};

const SKIPPED_DIRS: [&str; 5] = [METADATA_DIR, "node_modules", "dist", ".next", ".git"];

pub fn list_files(project_id: String) -> Result<FileTree, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let info = read_metadata(&project_dir)?;

    build_file_tree(&project_dir, &project_dir, &info.name)
}

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

pub fn write_file(project_id: String, path: String, content: String) -> Result<(), String> {
    write_files(project_id, vec![ProjectFileInput { path, content }])
}

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
        .is_some_and(|component| component.as_os_str() == OsStr::new(METADATA_DIR))
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
}
