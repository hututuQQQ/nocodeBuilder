use std::{fs, path::Path, process::Command};

use super::{
    metadata::{read_metadata, touch_project_metadata, write_metadata, METADATA_DIR},
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

pub fn delete_uninitialized_project(project_id: String) -> Result<(), String> {
    let workspace = ensure_workspace_dir()?;
    let project_dir = resolve_project_dir(&project_id)?;
    ensure_child_path(&workspace, &project_dir)?;

    validate_project_is_uninitialized(&project_dir)?;

    fs::remove_dir_all(&project_dir).map_err(|error| {
        format!(
            "project: failed to delete uninitialized project '{}': {error}",
            project_dir.display()
        )
    })
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

fn validate_project_is_uninitialized(project_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(project_dir).map_err(|error| {
        format!(
            "project: failed to inspect project directory '{}': {error}",
            project_dir.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("project: failed to read project entry: {error}"))?;
        let path = entry.path();
        let name = entry.file_name();

        if name.to_string_lossy() != METADATA_DIR {
            return Err(
                "project: cannot delete initialized project with project files".to_string(),
            );
        }

        validate_uninitialized_metadata_path(project_dir, &path)?;
    }

    Ok(())
}

fn validate_uninitialized_metadata_path(
    project_dir: &Path,
    metadata_dir: &Path,
) -> Result<(), String> {
    let mut stack = vec![metadata_dir.to_path_buf()];

    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(&path).map_err(|error| {
            format!(
                "project: failed to inspect metadata directory '{}': {error}",
                path.display()
            )
        })? {
            let entry = entry
                .map_err(|error| format!("project: failed to read metadata entry: {error}"))?;
            let child = entry.path();
            let relative = child
                .strip_prefix(project_dir)
                .map_err(|_| "project: metadata path escaped project".to_string())?;
            let relative_parts = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>();

            if entry
                .file_type()
                .map_err(|error| format!("project: failed to inspect metadata entry: {error}"))?
                .is_dir()
            {
                if is_allowed_uninitialized_directory(&relative_parts) {
                    stack.push(child);
                    continue;
                }

                return Err("project: cannot delete initialized project metadata".to_string());
            }

            if !is_allowed_uninitialized_file(&relative_parts) {
                return Err("project: cannot delete initialized project metadata".to_string());
            }
        }
    }

    Ok(())
}

fn is_allowed_uninitialized_directory(parts: &[String]) -> bool {
    matches!(
        parts,
        [metadata, child]
            if metadata == METADATA_DIR && (child == "specs" || child == "conversations")
    )
}

fn is_allowed_uninitialized_file(parts: &[String]) -> bool {
    matches!(parts, [metadata, file] if metadata == METADATA_DIR && file == "project.json")
        || matches!(
            parts,
            [metadata, child, file]
                if metadata == METADATA_DIR
                    && ((child == "specs" && file.ends_with(".json"))
                        || (child == "conversations" && file == "index.json"))
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn delete_uninitialized_project_removes_empty_project() {
        with_temp_home(|| {
            let project =
                create_project("Cleanup Empty Project".to_string()).expect("create project");
            let project_path = project.path.clone();

            delete_uninitialized_project(project.id).expect("delete uninitialized project");

            assert!(!Path::new(&project_path).exists());
        });
    }

    #[test]
    fn delete_uninitialized_project_allows_temporary_spec_metadata() {
        with_temp_home(|| {
            let project =
                create_project("Cleanup Temporary Spec".to_string()).expect("create project");
            let project_dir = Path::new(&project.path);
            let specs_dir = project_dir.join(METADATA_DIR).join("specs");
            let conversations_dir = project_dir.join(METADATA_DIR).join("conversations");
            fs::create_dir_all(&specs_dir).expect("create specs dir");
            fs::create_dir_all(&conversations_dir).expect("create conversations dir");
            fs::write(specs_dir.join("spec-1.json"), "{}").expect("write temporary spec");
            fs::write(
                conversations_dir.join("index.json"),
                r#"{"conversations":[]}"#,
            )
            .expect("write empty index");
            let project_path = project.path.clone();

            delete_uninitialized_project(project.id)
                .expect("temporary metadata should not block cleanup");

            assert!(!Path::new(&project_path).exists());
        });
    }

    #[test]
    fn delete_uninitialized_project_rejects_business_files() {
        with_temp_home(|| {
            let project =
                create_project("Reject Business Files".to_string()).expect("create project");
            let project_dir = Path::new(&project.path);
            fs::write(project_dir.join("package.json"), "{}").expect("write business file");

            let error = delete_uninitialized_project(project.id)
                .expect_err("business files should block cleanup");

            assert!(error.contains("cannot delete initialized project with project files"));
            assert!(project_dir.exists());
        });
    }

    #[test]
    fn delete_uninitialized_project_rejects_conversation_files() {
        with_temp_home(|| {
            let project =
                create_project("Reject Conversation Metadata".to_string()).expect("create project");
            let project_dir = Path::new(&project.path);
            let conversations_dir = project_dir.join(METADATA_DIR).join("conversations");
            fs::create_dir_all(&conversations_dir).expect("create conversations dir");
            fs::write(conversations_dir.join("conv-1.json"), r#"{"id":"conv-1"}"#)
                .expect("write attached conversation");

            let error = delete_uninitialized_project(project.id)
                .expect_err("conversation files should block cleanup");

            assert!(error.contains("cannot delete initialized project metadata"));
            assert!(project_dir.exists());
        });
    }

    fn with_temp_home(run: impl FnOnce()) {
        crate::test_support::with_temp_home("project-command-test", run);
    }
}
