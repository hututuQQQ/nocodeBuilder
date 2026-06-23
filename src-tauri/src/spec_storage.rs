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
    let path = spec_file_path(&project_dir, &spec_id)?;

    validate_spec_envelope(&project_id, &spec)?;
    if path.exists() {
        let existing = read_spec_value(&project_dir, &spec_id)?;
        validate_approved_revision_immutability(&existing, &spec)?;
    }
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

    validate_spec_identity(&project_id, &spec)?;
    if projects::project_contains_spec_id(&project_id, &spec_id)? {
        return Err("spec: attached conversation specs cannot be deleted".to_string());
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
    let spec_id = read_required_string(spec, "id")?;
    let conversation_id = read_required_string(spec, "conversationId")?;

    let conversation =
        projects::read_project_conversation(project_id.to_string(), conversation_id.to_string())?;

    if conversation.project_id != project_id {
        return Err("spec: conversation does not belong to project".to_string());
    }

    if !conversation.spec_ids.iter().any(|item| item == spec_id) {
        return Err("spec: spec is not attached to conversation".to_string());
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

fn validate_spec_file_identity(expected_spec_id: &str, spec: &Value) -> Result<(), String> {
    let actual_spec_id = read_required_string(spec, "id")?;

    if actual_spec_id != expected_spec_id {
        return Err("spec: spec file id does not match requested spec id".to_string());
    }

    Ok(())
}

pub(crate) fn read_development_spec_status(
    project_id: &str,
    spec_id: &str,
) -> Result<String, String> {
    let project_dir = projects::resolve_project_dir(project_id)?;
    let spec = read_spec_value(&project_dir, spec_id)?;

    validate_spec_identity(project_id, &spec)?;
    read_required_string(&spec, "status").map(str::to_string)
}

pub(crate) fn validate_specs_belong_to_conversation(
    project_id: &str,
    conversation_id: &str,
    spec_ids: &[String],
) -> Result<(), String> {
    for spec_id in spec_ids {
        validate_spec_belongs_to_conversation(project_id, conversation_id, spec_id)?;
    }

    Ok(())
}

pub(crate) fn validate_spec_belongs_to_conversation(
    project_id: &str,
    conversation_id: &str,
    spec_id: &str,
) -> Result<(), String> {
    let project_dir = projects::resolve_project_dir(project_id)?;
    let spec = read_spec_value(&project_dir, spec_id)?;

    validate_spec_identity(project_id, &spec)?;
    let spec_conversation_id = read_required_string(&spec, "conversationId")?;

    if spec_conversation_id != conversation_id {
        return Err("spec: spec does not belong to conversation".to_string());
    }

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

    let spec = serde_json::from_str::<Value>(&content)
        .map_err(|error| format!("spec: failed to parse spec JSON: {error}"))?;
    validate_spec_file_identity(spec_id, &spec)?;

    Ok(spec)
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

    let backup_path = dir.join(format!(
        ".{spec_id}.{}.bak",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    replace_file_atomically(
        &tmp_path,
        &path,
        &backup_path,
        ReplaceFailureInjection::None,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReplaceFailureInjection {
    None,
    Backup,
    Replace,
    Restore,
}

fn replace_file_atomically(
    tmp_path: &Path,
    path: &Path,
    backup_path: &Path,
    failure_injection: ReplaceFailureInjection,
) -> Result<(), String> {
    if !path.exists() {
        let move_result = if failure_injection == ReplaceFailureInjection::Replace {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected initial move failure",
            ))
        } else {
            fs::rename(tmp_path, path)
        };

        return move_result.map_err(|error| {
            let _ = fs::remove_file(tmp_path);
            format!(
                "spec: failed to move spec into place '{}': {error}",
                path.display()
            )
        });
    }

    let backup_result = if failure_injection == ReplaceFailureInjection::Backup {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "injected backup failure",
        ))
    } else {
        fs::rename(path, backup_path)
    };

    backup_result.map_err(|backup_error| {
        let _ = fs::remove_file(tmp_path);
        format!(
            "spec: failed to back up existing spec '{}': {backup_error}",
            path.display()
        )
    })?;

    let replace_result = if matches!(
        failure_injection,
        ReplaceFailureInjection::Replace | ReplaceFailureInjection::Restore
    ) {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "injected replace failure",
        ))
    } else {
        fs::rename(tmp_path, path)
    };

    match replace_result {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let restore_result = if failure_injection == ReplaceFailureInjection::Restore {
                Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "injected restore failure",
                ))
            } else {
                fs::rename(backup_path, path)
            };
            let _ = fs::remove_file(tmp_path);

            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "spec: failed to move spec into place '{}': {error}; failed to restore previous spec: {restore_error}",
                    path.display()
                ));
            }

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

fn validate_approved_revision_immutability(existing: &Value, next: &Value) -> Result<(), String> {
    let Some(existing_revisions) = existing.get("revisions").and_then(Value::as_array) else {
        return Ok(());
    };
    let next_revisions = next
        .get("revisions")
        .and_then(Value::as_array)
        .ok_or_else(|| "spec: revisions is required".to_string())?;

    for existing_revision in existing_revisions {
        let revision_id = read_required_string(existing_revision, "id")?;
        let next_revision = find_revision_by_id(next_revisions, revision_id)
            .ok_or_else(|| "spec: existing revisions cannot be removed".to_string())?;

        if existing_revision
            .get("approvedAt")
            .and_then(Value::as_str)
            .is_none()
        {
            continue;
        }

        if approved_revision_plan(existing_revision)? != approved_revision_plan(next_revision)? {
            return Err("spec: approved revision plan fields are immutable".to_string());
        }
    }

    Ok(())
}

fn find_revision_by_id<'a>(revisions: &'a [Value], revision_id: &str) -> Option<&'a Value> {
    revisions.iter().find(|revision| {
        revision
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == revision_id)
    })
}

fn approved_revision_plan(revision: &Value) -> Result<Value, String> {
    let mut plan = serde_json::Map::new();

    for field in [
        "id",
        "version",
        "brief",
        "requirements",
        "design",
        "approvedAt",
    ] {
        let value = revision
            .get(field)
            .ok_or_else(|| format!("spec: approved revision {field} is required"))?;
        plan.insert(field.to_string(), value.clone());
    }

    let tasks = revision
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| "spec: approved revision tasks is required".to_string())?
        .iter()
        .map(normalize_task_plan)
        .collect::<Result<Vec<_>, _>>()?;
    plan.insert("tasks".to_string(), Value::Array(tasks));

    Ok(Value::Object(plan))
}

fn normalize_task_plan(task: &Value) -> Result<Value, String> {
    let mut task = task
        .as_object()
        .cloned()
        .ok_or_else(|| "spec: task must be an object".to_string())?;

    for runtime_field in ["status", "runId", "error", "blockedByTaskId"] {
        task.remove(runtime_field);
    }

    Ok(Value::Object(task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn read_spec_value_rejects_file_identity_mismatch() {
        let root = create_temp_root();
        let dir = specs_dir(&root);
        fs::create_dir_all(&dir).expect("create specs dir");
        fs::write(
            dir.join("spec-active.json"),
            serde_json::to_string_pretty(&json!({
                "id": "spec-other",
                "projectId": "project-1",
                "conversationId": "conv-1",
                "kind": "feature",
                "status": "review"
            }))
            .expect("serialize mismatched spec"),
        )
        .expect("write mismatched spec");

        let error =
            read_spec_value(&root, "spec-active").expect_err("mismatched spec id should fail");

        assert!(error.contains("spec file id does not match requested spec id"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn save_existing_unreadable_spec_is_rejected_and_preserved() {
        with_temp_home(|| {
            let project = crate::projects::create_project("Spec Save Safety Test".to_string())
                .expect("create project");
            let conversation_id = "conv-1".to_string();
            let spec_id = "spec-1".to_string();
            let spec = json!({
                "id": spec_id,
                "projectId": project.id,
                "conversationId": conversation_id,
                "kind": "initial_build",
                "status": "review",
                "currentRevisionId": "rev-1",
                "revisions": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            });

            create_development_spec(project.id.clone(), spec).expect("create spec");
            let project_dir = projects::resolve_project_dir(&project.id).expect("project dir");
            let conversations_dir = project_dir.join(".aibuilder").join("conversations");
            fs::create_dir_all(&conversations_dir).expect("create conversations dir");
            fs::write(
                conversations_dir.join(format!("{conversation_id}.json")),
                serde_json::to_string_pretty(&json!({
                    "id": conversation_id.clone(),
                    "projectId": project.id,
                    "title": "Initial build",
                    "kind": "initial_build",
                    "mode": "spec",
                    "activeSpecId": spec_id.clone(),
                    "specIds": [spec_id.clone()],
                    "modeChangedAt": "2026-01-01T00:00:00Z",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "lastMessageAt": "2026-01-01T00:00:00Z",
                    "archivedAt": null,
                    "messages": []
                }))
                .expect("serialize conversation"),
            )
            .expect("write conversation");

            let path = spec_file_path(&project_dir, &spec_id).expect("spec path");
            fs::write(&path, "{not valid json").expect("corrupt spec file");

            let replacement = json!({
                "id": spec_id,
                "projectId": project.id,
                "conversationId": conversation_id,
                "kind": "initial_build",
                "status": "completed",
                "currentRevisionId": "rev-1",
                "revisions": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:01Z"
            });
            let error = save_development_spec(project.id.clone(), replacement)
                .expect_err("existing unreadable spec must block save");

            assert!(error.contains("failed to parse spec JSON"));
            assert_eq!(
                fs::read_to_string(&path).expect("read preserved file"),
                "{not valid json"
            );
        });
    }

    #[test]
    fn delete_rejects_spec_referenced_by_any_conversation() {
        with_temp_home(|| {
            let project = crate::projects::create_project("Spec Delete Safety Test".to_string())
                .expect("create project");
            let spec_id = "spec-1".to_string();
            let spec = json!({
                "id": spec_id,
                "projectId": project.id,
                "conversationId": "conv-missing",
                "kind": "feature",
                "status": "review",
                "currentRevisionId": "rev-1",
                "revisions": [],
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            });

            create_development_spec(project.id.clone(), spec).expect("create spec");
            let project_dir = projects::resolve_project_dir(&project.id).expect("project dir");
            let conversations_dir = project_dir.join(".aibuilder").join("conversations");
            fs::create_dir_all(&conversations_dir).expect("create conversations dir");
            fs::write(
                conversations_dir.join("conv-attached.json"),
                serde_json::to_string_pretty(&json!({
                    "id": "conv-attached",
                    "projectId": project.id,
                    "title": "Attached Spec history",
                    "kind": "iteration",
                    "mode": "chat",
                    "activeSpecId": null,
                    "specIds": [spec_id.clone()],
                    "modeChangedAt": "2026-01-01T00:00:00Z",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "lastMessageAt": "2026-01-01T00:00:00Z",
                    "archivedAt": null,
                    "messages": []
                }))
                .expect("serialize conversation"),
            )
            .expect("write conversation");

            let error = delete_development_spec(project.id.clone(), spec_id.clone())
                .expect_err("attached spec must not be deleted");
            let path = spec_file_path(&project_dir, &spec_id).expect("spec path");

            assert!(error.contains("attached conversation specs cannot be deleted"));
            assert!(path.exists());
        });
    }

    #[test]
    fn approved_revision_plan_allows_runtime_task_updates() {
        let existing = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Build it",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{
                    "id": "task-1",
                    "title": "Task",
                    "objective": "Do work",
                    "status": "pending"
                }]
            }]
        });
        let next = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Build it",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{
                    "id": "task-1",
                    "title": "Task",
                    "objective": "Do work",
                    "status": "passed",
                    "runId": "run-1"
                }]
            }]
        });

        assert!(validate_approved_revision_immutability(&existing, &next).is_ok());
    }

    #[test]
    fn approved_revision_plan_rejects_plan_mutation() {
        let existing = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Build it",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task", "status": "pending"}]
            }]
        });
        let next = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Changed",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task", "status": "pending"}]
            }]
        });

        assert!(validate_approved_revision_immutability(&existing, &next).is_err());
    }

    #[test]
    fn revisions_cannot_remove_unapproved_existing_revision() {
        let existing = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Draft",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task"}]
            }]
        });
        let next = json!({
            "revisions": []
        });

        let error = validate_approved_revision_immutability(&existing, &next)
            .expect_err("existing revision removal should fail");

        assert!(error.contains("existing revisions cannot be removed"));
    }

    #[test]
    fn unapproved_revision_can_be_approved() {
        let existing = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Draft",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task"}]
            }]
        });
        let next = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Draft",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task"}]
            }]
        });

        assert!(validate_approved_revision_immutability(&existing, &next).is_ok());
    }

    #[test]
    fn approved_revision_rejects_approved_at_change() {
        let existing = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Build it",
                "approvedAt": "2026-01-01T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task"}]
            }]
        });
        let next = json!({
            "revisions": [{
                "id": "rev-1",
                "version": 1,
                "brief": "Build it",
                "approvedAt": "2026-01-02T00:00:00Z",
                "requirements": {"goal": "A"},
                "design": {"summary": "B"},
                "tasks": [{"id": "task-1", "title": "Task"}]
            }]
        });

        let error = validate_approved_revision_immutability(&existing, &next)
            .expect_err("approvedAt mutation should fail");

        assert!(error.contains("approved revision plan fields are immutable"));
    }

    #[test]
    fn atomic_replace_cleans_tmp_on_initial_move_failure() {
        let root = create_temp_root();
        let path = root.join("spec.json");
        let tmp_path = root.join(".spec.tmp");
        let backup_path = root.join(".spec.bak");

        fs::write(&tmp_path, "new").expect("write new");

        let error = replace_file_atomically(
            &tmp_path,
            &path,
            &backup_path,
            ReplaceFailureInjection::Replace,
        )
        .expect_err("initial move should fail");

        assert!(error.contains("failed to move spec into place"));
        assert!(!path.exists());
        assert!(!tmp_path.exists());
        assert!(!backup_path.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_replace_keeps_previous_file_on_backup_failure() {
        let root = create_temp_root();
        let path = root.join("spec.json");
        let tmp_path = root.join(".spec.tmp");
        let backup_path = root.join(".spec.bak");

        fs::write(&path, "old").expect("write old");
        fs::write(&tmp_path, "new").expect("write new");

        let error = replace_file_atomically(
            &tmp_path,
            &path,
            &backup_path,
            ReplaceFailureInjection::Backup,
        )
        .expect_err("backup should fail");

        assert!(error.contains("failed to back up existing spec"));
        assert_eq!(fs::read_to_string(&path).expect("read old"), "old");
        assert!(!tmp_path.exists());
        assert!(!backup_path.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_replace_restores_previous_file_on_replace_failure() {
        let root = create_temp_root();
        let path = root.join("spec.json");
        let tmp_path = root.join(".spec.tmp");
        let backup_path = root.join(".spec.bak");

        fs::write(&path, "old").expect("write old");
        fs::write(&tmp_path, "new").expect("write new");

        assert!(replace_file_atomically(
            &tmp_path,
            &path,
            &backup_path,
            ReplaceFailureInjection::Replace,
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).expect("read restored"), "old");
        assert!(!backup_path.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn atomic_replace_reports_restore_failure_clearly() {
        let root = create_temp_root();
        let path = root.join("spec.json");
        let tmp_path = root.join(".spec.tmp");
        let backup_path = root.join(".spec.bak");

        fs::write(&path, "old").expect("write old");
        fs::write(&tmp_path, "new").expect("write new");

        let error = replace_file_atomically(
            &tmp_path,
            &path,
            &backup_path,
            ReplaceFailureInjection::Restore,
        )
        .expect_err("restore should fail");

        assert!(error.contains("failed to restore previous spec"));
        assert!(!tmp_path.exists());
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read backup"),
            "old"
        );

        let _ = fs::remove_dir_all(&root);
    }

    fn create_temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "spec-storage-test-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn with_temp_home(run: impl FnOnce()) {
        crate::test_support::with_temp_home("spec-storage-home-test", run);
    }
}
