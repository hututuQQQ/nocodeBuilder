use std::{
    env, fs,
    path::{Path, PathBuf},
};

use chrono::Utc;

use super::metadata::read_metadata;

pub const FRAMEWORK: &str = "next-app-router";
const WORKSPACE_DIR_NAME: &str = "nocodeBuilderProjects";

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

pub fn normalize_project_name(project_name: &str) -> Result<String, String> {
    let name = project_name.trim();

    if name.is_empty() {
        return Err("project: project name is required".to_string());
    }

    Ok(name.to_string())
}

pub fn ensure_workspace_dir() -> Result<PathBuf, String> {
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

pub fn ensure_child_path(parent: &Path, child: &Path) -> Result<(), String> {
    if !child.starts_with(parent) {
        return Err("project: path escaped the workspace".to_string());
    }

    Ok(())
}

pub fn slugify_project_name(project_name: &str) -> String {
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

pub fn unique_project_id(workspace: &Path, base_id: &str) -> Result<String, String> {
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

pub fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}

fn workspace_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .ok_or_else(|| "project: failed to resolve user home directory".to_string())?;

    Ok(PathBuf::from(home).join(WORKSPACE_DIR_NAME))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_project_names() {
        assert_eq!(slugify_project_name("Pet Care Site"), "pet-care-site");
        assert_eq!(slugify_project_name("  CRM__Dashboard!! "), "crm-dashboard");
    }
}
