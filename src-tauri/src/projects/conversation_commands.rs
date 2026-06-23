use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    metadata::METADATA_DIR,
    types::{
        CreateProjectConversationInput, ProjectConversation, ProjectConversationSummary,
        SwitchProjectConversationModeInput,
    },
    workspace::{current_timestamp, resolve_project_dir},
};

const CONVERSATIONS_DIR: &str = "conversations";
const INDEX_FILE: &str = "index.json";
const DEFAULT_CONVERSATION_TITLE: &str = "New iteration";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationIndex {
    conversations: Vec<ProjectConversationSummary>,
}

pub fn list_project_conversations(
    project_id: String,
    include_archived: bool,
) -> Result<Vec<ProjectConversationSummary>, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let index = load_conversation_index(&project_dir, &project_id)?;
    let mut conversations = index.conversations;

    if !include_archived {
        conversations.retain(|conversation| conversation.archived_at.is_none());
    }

    conversations.sort_by(|left, right| {
        right
            .last_message_at
            .cmp(&left.last_message_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.title.cmp(&right.title))
    });

    Ok(conversations)
}

pub fn create_project_conversation(
    project_id: String,
    input: CreateProjectConversationInput,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let id = match input.conversation_id {
        Some(id) => {
            validate_conversation_id(&id)?;
            if conversation_file_path(&project_dir, &id).exists() {
                return Err("conversation: conversation already exists".to_string());
            }
            id
        }
        None => unique_conversation_id(&project_dir)?,
    };
    let now = current_timestamp();
    let spec_ids = input.spec_ids.unwrap_or_default();
    validate_conversation_shape(
        &input.kind,
        &input.mode,
        input.active_spec_id.as_deref(),
        &spec_ids,
    )?;
    validate_create_conversation_rules(
        &project_dir,
        &project_id,
        &id,
        &input.kind,
        &input.mode,
        &spec_ids,
    )?;
    let conversation = ProjectConversation {
        id,
        project_id,
        title: normalize_title(input.title.as_deref()),
        kind: input.kind,
        mode: input.mode,
        active_spec_id: input.active_spec_id,
        spec_ids,
        mode_changed_at: now.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
        last_message_at: now,
        archived_at: None,
        messages: Vec::new(),
    };

    write_project_conversation(&project_dir, &conversation)?;
    upsert_conversation_summary(&project_dir, summary_from_conversation(&conversation))?;

    Ok(conversation)
}

pub fn read_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let conversation = read_conversation_file(&project_dir, &conversation_id)?;

    if conversation.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

    Ok(conversation)
}

pub(crate) fn project_contains_spec_id(project_id: &str, spec_id: &str) -> Result<bool, String> {
    validate_spec_id(spec_id)?;
    let project_dir = resolve_project_dir(project_id)?;
    let conversations = read_project_conversation_files(&project_dir, project_id)?;

    Ok(conversations
        .iter()
        .any(|conversation| conversation.spec_ids.iter().any(|item| item == spec_id)))
}

pub fn save_project_conversation(
    project_id: String,
    mut conversation: ProjectConversation,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    validate_conversation_id(&conversation.id)?;
    validate_conversation_shape(
        &conversation.kind,
        &conversation.mode,
        conversation.active_spec_id.as_deref(),
        &conversation.spec_ids,
    )?;

    if conversation.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

    let existing = read_conversation_file(&project_dir, &conversation.id)?;

    if existing.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

    if existing.kind != conversation.kind
        || existing.mode != conversation.mode
        || existing.active_spec_id != conversation.active_spec_id
        || existing.spec_ids != conversation.spec_ids
    {
        return Err(
            "conversation: mode metadata must be changed with switch_project_conversation_mode"
                .to_string(),
        );
    }

    conversation.mode_changed_at = existing.mode_changed_at;

    if conversation.title.trim().is_empty() {
        conversation.title = title_from_messages(&conversation)
            .unwrap_or_else(|| DEFAULT_CONVERSATION_TITLE.to_string());
    } else {
        conversation.title = conversation.title.trim().to_string();
    }

    write_project_conversation(&project_dir, &conversation)?;
    upsert_conversation_summary(&project_dir, summary_from_conversation(&conversation))?;

    Ok(conversation)
}

pub fn switch_project_conversation_mode(
    project_id: String,
    input: SwitchProjectConversationModeInput,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let mut conversation = read_conversation_file(&project_dir, &input.conversation_id)?;

    if conversation.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

    if conversation.kind == "initial_build" {
        return Err("conversation: initial build mode is locked".to_string());
    }

    if conversation.kind != "iteration" {
        return Err("conversation: invalid conversation kind".to_string());
    }

    if conversation.mode == input.target_mode {
        return Err("conversation: target mode is already active".to_string());
    }

    validate_conversation_shape(
        &conversation.kind,
        &input.target_mode,
        input.active_spec_id.as_deref(),
        &input.spec_ids,
    )?;
    validate_historical_specs_preserved(&conversation.spec_ids, &input.spec_ids)?;
    if !input.spec_ids.is_empty() {
        crate::spec_storage::validate_specs_belong_to_conversation(
            &project_id,
            &conversation.id,
            &input.spec_ids,
        )?;
    }

    let now = current_timestamp();
    conversation.mode = input.target_mode;
    conversation.active_spec_id = input.active_spec_id;
    conversation.spec_ids = input.spec_ids;
    conversation.mode_changed_at = now.clone();
    conversation.updated_at = now;

    write_project_conversation(&project_dir, &conversation)?;
    upsert_conversation_summary(&project_dir, summary_from_conversation(&conversation))?;

    Ok(conversation)
}

pub fn archive_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    update_archive_state(project_id, conversation_id, true)
}

pub fn unarchive_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    update_archive_state(project_id, conversation_id, false)
}

fn update_archive_state(
    project_id: String,
    conversation_id: String,
    archived: bool,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let mut conversation = read_conversation_file(&project_dir, &conversation_id)?;

    if conversation.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

    if archived && conversation.kind == "initial_build" {
        validate_initial_build_conversation_completed(&project_id, &conversation, "archiving")?;
    }

    let now = current_timestamp();
    conversation.updated_at = now.clone();
    conversation.archived_at = if archived { Some(now) } else { None };

    write_project_conversation(&project_dir, &conversation)?;
    upsert_conversation_summary(&project_dir, summary_from_conversation(&conversation))?;

    Ok(conversation)
}

fn load_conversation_index(
    project_dir: &Path,
    project_id: &str,
) -> Result<ConversationIndex, String> {
    let path = index_path(project_dir);

    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|error| {
            format!(
                "conversation: failed to read conversation index '{}': {error}",
                path.display()
            )
        })?;
        let mut index = serde_json::from_str::<ConversationIndex>(&content).map_err(|error| {
            format!("conversation: failed to parse conversation index: {error}")
        })?;

        index
            .conversations
            .retain(|conversation| conversation.project_id == project_id);
        return Ok(index);
    }

    rebuild_conversation_index(project_dir, project_id)
}

fn rebuild_conversation_index(
    project_dir: &Path,
    project_id: &str,
) -> Result<ConversationIndex, String> {
    let dir = conversations_dir(project_dir);

    if !dir.exists() {
        return Ok(ConversationIndex::default());
    }

    let mut conversations = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|error| {
        format!(
            "conversation: failed to read conversations directory '{}': {error}",
            dir.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("conversation: failed to read entry: {error}"))?;
        let path = entry.path();

        if path.file_name().and_then(|name| name.to_str()) == Some(INDEX_FILE)
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }

        let content = fs::read_to_string(&path).map_err(|error| {
            format!(
                "conversation: failed to read conversation '{}': {error}",
                path.display()
            )
        })?;
        let conversation = serde_json::from_str::<ProjectConversation>(&content)
            .map_err(|error| format!("conversation: failed to parse conversation: {error}"))?;

        if conversation.project_id == project_id {
            conversations.push(summary_from_conversation(&conversation));
        }
    }

    let index = ConversationIndex { conversations };
    write_conversation_index(project_dir, &index)?;

    Ok(index)
}

fn read_conversation_file(
    project_dir: &Path,
    conversation_id: &str,
) -> Result<ProjectConversation, String> {
    validate_conversation_id(conversation_id)?;
    let path = conversation_file_path(project_dir, conversation_id);

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "conversation: failed to read conversation '{}': {error}",
            path.display()
        )
    })?;

    serde_json::from_str::<ProjectConversation>(&content)
        .map_err(|error| format!("conversation: failed to parse conversation: {error}"))
}

fn read_project_conversation_files(
    project_dir: &Path,
    project_id: &str,
) -> Result<Vec<ProjectConversation>, String> {
    let dir = conversations_dir(project_dir);

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut conversations = Vec::new();

    for entry in fs::read_dir(&dir).map_err(|error| {
        format!(
            "conversation: failed to read conversations directory '{}': {error}",
            dir.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("conversation: failed to read entry: {error}"))?;
        let path = entry.path();

        if path.file_name().and_then(|name| name.to_str()) == Some(INDEX_FILE)
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }

        let content = fs::read_to_string(&path).map_err(|error| {
            format!(
                "conversation: failed to read conversation '{}': {error}",
                path.display()
            )
        })?;
        let conversation = serde_json::from_str::<ProjectConversation>(&content)
            .map_err(|error| format!("conversation: failed to parse conversation: {error}"))?;

        if conversation.project_id == project_id {
            conversations.push(conversation);
        }
    }

    Ok(conversations)
}

fn write_project_conversation(
    project_dir: &Path,
    conversation: &ProjectConversation,
) -> Result<(), String> {
    validate_conversation_id(&conversation.id)?;
    let dir = conversations_dir(project_dir);
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "conversation: failed to create conversations directory '{}': {error}",
            dir.display()
        )
    })?;

    let path = conversation_file_path(project_dir, &conversation.id);
    let content = serde_json::to_string_pretty(conversation)
        .map_err(|error| format!("conversation: failed to serialize conversation: {error}"))?;

    fs::write(&path, content).map_err(|error| {
        format!(
            "conversation: failed to write conversation '{}': {error}",
            path.display()
        )
    })
}

fn upsert_conversation_summary(
    project_dir: &Path,
    summary: ProjectConversationSummary,
) -> Result<(), String> {
    let mut index = load_conversation_index(project_dir, &summary.project_id)?;
    index
        .conversations
        .retain(|conversation| conversation.id != summary.id);
    index.conversations.push(summary);
    write_conversation_index(project_dir, &index)
}

fn write_conversation_index(project_dir: &Path, index: &ConversationIndex) -> Result<(), String> {
    let dir = conversations_dir(project_dir);
    fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "conversation: failed to create conversations directory '{}': {error}",
            dir.display()
        )
    })?;

    let path = index_path(project_dir);
    let content = serde_json::to_string_pretty(index)
        .map_err(|error| format!("conversation: failed to serialize index: {error}"))?;

    fs::write(&path, content).map_err(|error| {
        format!(
            "conversation: failed to write conversation index '{}': {error}",
            path.display()
        )
    })
}

fn unique_conversation_id(project_dir: &Path) -> Result<String, String> {
    let dir = conversations_dir(project_dir);
    let base = format!("conv-{}", chrono::Utc::now().timestamp_millis());

    for suffix in 0..10_000 {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };

        if !conversation_file_path(project_dir, &candidate).exists() {
            return Ok(candidate);
        }
    }

    if !dir.exists() {
        return Ok(base);
    }

    Err("conversation: failed to create a unique conversation id".to_string())
}

fn summary_from_conversation(conversation: &ProjectConversation) -> ProjectConversationSummary {
    ProjectConversationSummary {
        id: conversation.id.clone(),
        project_id: conversation.project_id.clone(),
        title: conversation.title.clone(),
        kind: conversation.kind.clone(),
        mode: conversation.mode.clone(),
        active_spec_id: conversation.active_spec_id.clone(),
        created_at: conversation.created_at.clone(),
        updated_at: conversation.updated_at.clone(),
        last_message_at: conversation.last_message_at.clone(),
        archived_at: conversation.archived_at.clone(),
        message_count: conversation.messages.len(),
    }
}

fn title_from_messages(conversation: &ProjectConversation) -> Option<String> {
    conversation
        .messages
        .iter()
        .find(|message| message.role == "user")
        .map(|message| compact_title(&message.content))
        .filter(|title| !title.is_empty())
}

fn normalize_title(title: Option<&str>) -> String {
    let title = title.map(str::trim).unwrap_or("");

    if title.is_empty() {
        DEFAULT_CONVERSATION_TITLE.to_string()
    } else {
        compact_title(title)
    }
}

fn compact_title(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");

    if compact.chars().count() <= 48 {
        compact
    } else {
        let mut title = compact.chars().take(45).collect::<String>();
        title.push_str("...");
        title
    }
}

fn validate_conversation_id(conversation_id: &str) -> Result<(), String> {
    if conversation_id.is_empty()
        || !conversation_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("conversation: invalid conversation id".to_string());
    }

    Ok(())
}

fn validate_spec_id(spec_id: &str) -> Result<(), String> {
    if spec_id.is_empty()
        || !spec_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("conversation: invalid spec id".to_string());
    }

    Ok(())
}

fn validate_conversation_shape(
    kind: &str,
    mode: &str,
    active_spec_id: Option<&str>,
    spec_ids: &[String],
) -> Result<(), String> {
    match kind {
        "initial_build" | "iteration" => {}
        _ => return Err("conversation: invalid conversation kind".to_string()),
    }

    match mode {
        "chat" | "spec" => {}
        _ => return Err("conversation: invalid conversation mode".to_string()),
    }

    if kind == "initial_build" && mode != "spec" {
        return Err("conversation: initial build must use spec mode".to_string());
    }

    validate_unique_spec_ids(spec_ids)?;

    if mode == "chat" {
        if active_spec_id.is_some() {
            return Err("conversation: chat mode cannot have an active spec".to_string());
        }
        return Ok(());
    }

    let active_spec_id = active_spec_id
        .ok_or_else(|| "conversation: spec mode requires an active spec".to_string())?;
    validate_spec_id(active_spec_id)?;

    if !spec_ids.iter().any(|spec_id| spec_id == active_spec_id) {
        return Err("conversation: active spec must be included in specIds".to_string());
    }

    Ok(())
}

fn validate_unique_spec_ids(spec_ids: &[String]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();

    for spec_id in spec_ids {
        validate_spec_id(spec_id)?;
        if !seen.insert(spec_id) {
            return Err("conversation: duplicate spec id".to_string());
        }
    }

    Ok(())
}

fn validate_historical_specs_preserved(previous: &[String], next: &[String]) -> Result<(), String> {
    for spec_id in previous {
        if !next.iter().any(|item| item == spec_id) {
            return Err("conversation: historical specs cannot be removed".to_string());
        }
    }

    Ok(())
}

fn validate_create_conversation_rules(
    project_dir: &Path,
    project_id: &str,
    conversation_id: &str,
    kind: &str,
    mode: &str,
    spec_ids: &[String],
) -> Result<(), String> {
    let conversations = read_project_conversation_files(project_dir, project_id)?;

    if kind == "initial_build"
        && conversations
            .iter()
            .any(|conversation| conversation.kind == "initial_build")
    {
        return Err("conversation: initial build already exists".to_string());
    }

    if kind == "iteration" {
        validate_initial_build_completed_for_iterations(project_id, &conversations)?;
    }

    if mode == "spec" || !spec_ids.is_empty() {
        crate::spec_storage::validate_specs_belong_to_conversation(
            project_id,
            conversation_id,
            spec_ids,
        )?;
    }

    Ok(())
}

fn validate_initial_build_completed_for_iterations(
    project_id: &str,
    conversations: &[ProjectConversation],
) -> Result<(), String> {
    let initial_builds = conversations
        .iter()
        .filter(|conversation| conversation.kind == "initial_build")
        .collect::<Vec<_>>();

    if initial_builds.len() != 1 {
        return Err(
            "conversation: initial build must complete before creating iterations".to_string(),
        );
    }

    validate_initial_build_conversation_completed(
        project_id,
        initial_builds[0],
        "creating iterations",
    )
}

fn validate_initial_build_conversation_completed(
    project_id: &str,
    conversation: &ProjectConversation,
    action: &str,
) -> Result<(), String> {
    let Some(active_spec_id) = conversation.active_spec_id.as_deref() else {
        return Err(format!(
            "conversation: initial build must complete before {action}"
        ));
    };

    if !conversation
        .spec_ids
        .iter()
        .any(|spec_id| spec_id == active_spec_id)
    {
        return Err(format!(
            "conversation: initial build must complete before {action}"
        ));
    }

    crate::spec_storage::validate_spec_belongs_to_conversation(
        project_id,
        &conversation.id,
        active_spec_id,
    )
    .map_err(|_| format!("conversation: initial build must complete before {action}"))?;

    let status = crate::spec_storage::read_development_spec_status(project_id, active_spec_id)
        .map_err(|_| format!("conversation: initial build must complete before {action}"))?;

    if status != "completed" {
        return Err(format!(
            "conversation: initial build must complete before {action}"
        ));
    }

    Ok(())
}

fn conversations_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(METADATA_DIR).join(CONVERSATIONS_DIR)
}

fn index_path(project_dir: &Path) -> PathBuf {
    conversations_dir(project_dir).join(INDEX_FILE)
}

fn conversation_file_path(project_dir: &Path, conversation_id: &str) -> PathBuf {
    conversations_dir(project_dir).join(format!("{conversation_id}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initial_build_requires_spec_mode_and_active_spec() {
        assert!(validate_conversation_shape("initial_build", "chat", None, &Vec::new(),).is_err());
        assert!(validate_conversation_shape("initial_build", "spec", None, &Vec::new(),).is_err());
        assert!(validate_conversation_shape(
            "initial_build",
            "spec",
            Some("spec-1"),
            &vec!["spec-1".to_string()],
        )
        .is_ok());
    }

    #[test]
    fn chat_mode_rejects_active_spec() {
        assert!(validate_conversation_shape(
            "iteration",
            "chat",
            Some("spec-1"),
            &vec!["spec-1".to_string()],
        )
        .is_err());
        assert!(validate_conversation_shape(
            "iteration",
            "chat",
            None,
            &vec!["spec-1".to_string()],
        )
        .is_ok());
    }

    #[test]
    fn spec_ids_must_be_unique_and_preserved() {
        assert!(validate_conversation_shape(
            "iteration",
            "spec",
            Some("spec-1"),
            &vec!["spec-1".to_string(), "spec-1".to_string()],
        )
        .is_err());
        assert!(validate_historical_specs_preserved(
            &vec!["spec-1".to_string(), "spec-2".to_string()],
            &vec!["spec-2".to_string()],
        )
        .is_err());
        assert!(validate_historical_specs_preserved(
            &vec!["spec-1".to_string()],
            &vec!["spec-1".to_string(), "spec-2".to_string()],
        )
        .is_ok());
    }

    #[test]
    fn untitled_iterations_use_iteration_label() {
        assert_eq!(normalize_title(None), "New iteration");
        assert_eq!(normalize_title(Some("   ")), "New iteration");
    }

    #[test]
    fn initial_build_gate_rejects_iteration_and_archive_until_completed() {
        with_temp_home(|| {
            let project =
                crate::projects::project_commands::create_project("Initial Gate Test".to_string())
                    .expect("create project");
            let conversation_id = "conv-initial".to_string();
            let spec_id = "spec-initial".to_string();
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

            crate::spec_storage::create_development_spec(project.id.clone(), spec)
                .expect("create initial spec");
            create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: Some(spec_id.clone()),
                    conversation_id: Some(conversation_id.clone()),
                    kind: "initial_build".to_string(),
                    mode: "spec".to_string(),
                    spec_ids: Some(vec![spec_id.clone()]),
                    title: Some("Initial build".to_string()),
                },
            )
            .expect("create initial conversation");

            let duplicate = create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: Some(spec_id.clone()),
                    conversation_id: Some("conv-initial-2".to_string()),
                    kind: "initial_build".to_string(),
                    mode: "spec".to_string(),
                    spec_ids: Some(vec![spec_id.clone()]),
                    title: None,
                },
            )
            .expect_err("duplicate initial build must fail");
            assert!(duplicate.contains("initial build already exists"));

            let iteration_error = create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: None,
                    conversation_id: Some("conv-iteration".to_string()),
                    kind: "iteration".to_string(),
                    mode: "chat".to_string(),
                    spec_ids: None,
                    title: None,
                },
            )
            .expect_err("incomplete initial build must block iteration");
            assert_eq!(
                iteration_error,
                "conversation: initial build must complete before creating iterations"
            );

            assert!(
                archive_project_conversation(project.id.clone(), conversation_id.clone())
                    .expect_err("incomplete initial build archive must fail")
                    .contains("initial build must complete")
            );

            let completed_spec = json!({
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
            crate::spec_storage::save_development_spec(project.id.clone(), completed_spec)
                .expect("save completed spec");

            create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: None,
                    conversation_id: Some("conv-iteration".to_string()),
                    kind: "iteration".to_string(),
                    mode: "chat".to_string(),
                    spec_ids: None,
                    title: Some("Follow up".to_string()),
                },
            )
            .expect("completed initial build allows iteration");
        });
    }

    #[test]
    fn initial_build_gate_rejects_spec_from_another_conversation() {
        with_temp_home(|| {
            let project = crate::projects::project_commands::create_project(
                "Initial Gate Ownership Test".to_string(),
            )
            .expect("create project");
            let conversation_id = "conv-initial".to_string();
            let spec_id = "spec-initial".to_string();

            crate::spec_storage::create_development_spec(
                project.id.clone(),
                json!({
                    "id": spec_id,
                    "projectId": project.id,
                    "conversationId": conversation_id,
                    "kind": "initial_build",
                    "status": "completed",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }),
            )
            .expect("create completed initial spec");
            create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: Some(spec_id.clone()),
                    conversation_id: Some(conversation_id.clone()),
                    kind: "initial_build".to_string(),
                    mode: "spec".to_string(),
                    spec_ids: Some(vec![spec_id.clone()]),
                    title: Some("Initial build".to_string()),
                },
            )
            .expect("create initial conversation");

            let project_dir = resolve_project_dir(&project.id).expect("project dir");
            let specs_dir = project_dir.join(METADATA_DIR).join("specs");
            fs::write(
                specs_dir.join(format!("{spec_id}.json")),
                serde_json::to_string_pretty(&json!({
                    "id": spec_id,
                    "projectId": project.id,
                    "conversationId": "conv-other",
                    "kind": "initial_build",
                    "status": "completed",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:01Z"
                }))
                .expect("serialize mismatched spec"),
            )
            .expect("overwrite mismatched spec");

            let error = create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: None,
                    conversation_id: Some("conv-iteration".to_string()),
                    kind: "iteration".to_string(),
                    mode: "chat".to_string(),
                    spec_ids: None,
                    title: Some("Follow up".to_string()),
                },
            )
            .expect_err("mismatched initial spec must block iteration");

            assert_eq!(
                error,
                "conversation: initial build must complete before creating iterations"
            );
        });
    }

    #[test]
    fn switch_mode_rejects_spec_from_another_conversation() {
        with_temp_home(|| {
            let project = crate::projects::project_commands::create_project(
                "Spec Ownership Test".to_string(),
            )
            .expect("create project");
            let initial_conversation_id = "conv-initial".to_string();
            let initial_spec_id = "spec-initial".to_string();

            crate::spec_storage::create_development_spec(
                project.id.clone(),
                json!({
                    "id": initial_spec_id,
                    "projectId": project.id,
                    "conversationId": initial_conversation_id,
                    "kind": "initial_build",
                    "status": "completed",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }),
            )
            .expect("create completed initial spec");
            create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: Some(initial_spec_id),
                    conversation_id: Some(initial_conversation_id),
                    kind: "initial_build".to_string(),
                    mode: "spec".to_string(),
                    spec_ids: Some(vec!["spec-initial".to_string()]),
                    title: Some("Initial build".to_string()),
                },
            )
            .expect("create initial conversation");

            let conversation = create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: None,
                    conversation_id: Some("conv-target".to_string()),
                    kind: "iteration".to_string(),
                    mode: "chat".to_string(),
                    spec_ids: None,
                    title: Some("Target".to_string()),
                },
            )
            .expect("create target iteration");

            crate::spec_storage::create_development_spec(
                project.id.clone(),
                json!({
                    "id": "spec-other",
                    "projectId": project.id,
                    "conversationId": "conv-other",
                    "kind": "feature",
                    "status": "review",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }),
            )
            .expect("create other conversation spec");

            let error = switch_project_conversation_mode(
                project.id.clone(),
                SwitchProjectConversationModeInput {
                    active_spec_id: Some("spec-other".to_string()),
                    conversation_id: conversation.id,
                    spec_ids: vec!["spec-other".to_string()],
                    target_mode: "spec".to_string(),
                },
            )
            .expect_err("other conversation spec must be rejected");

            assert!(error.contains("spec does not belong to conversation"));
        });
    }

    #[test]
    fn switch_mode_rejects_mismatched_spec_file_identity() {
        with_temp_home(|| {
            let project = crate::projects::project_commands::create_project(
                "Spec File Identity Test".to_string(),
            )
            .expect("create project");
            let initial_conversation_id = "conv-initial".to_string();
            let initial_spec_id = "spec-initial".to_string();

            crate::spec_storage::create_development_spec(
                project.id.clone(),
                json!({
                    "id": initial_spec_id,
                    "projectId": project.id,
                    "conversationId": initial_conversation_id,
                    "kind": "initial_build",
                    "status": "completed",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }),
            )
            .expect("create completed initial spec");
            create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: Some("spec-initial".to_string()),
                    conversation_id: Some(initial_conversation_id),
                    kind: "initial_build".to_string(),
                    mode: "spec".to_string(),
                    spec_ids: Some(vec!["spec-initial".to_string()]),
                    title: Some("Initial build".to_string()),
                },
            )
            .expect("create initial conversation");

            let conversation = create_project_conversation(
                project.id.clone(),
                CreateProjectConversationInput {
                    active_spec_id: None,
                    conversation_id: Some("conv-target".to_string()),
                    kind: "iteration".to_string(),
                    mode: "chat".to_string(),
                    spec_ids: None,
                    title: Some("Target".to_string()),
                },
            )
            .expect("create target iteration");

            let project_dir = resolve_project_dir(&project.id).expect("resolve project dir");
            let specs_dir = project_dir.join(METADATA_DIR).join("specs");
            fs::create_dir_all(&specs_dir).expect("create specs dir");
            fs::write(
                specs_dir.join("spec-active.json"),
                serde_json::to_string_pretty(&json!({
                    "id": "spec-other",
                    "projectId": project.id,
                    "conversationId": conversation.id,
                    "kind": "feature",
                    "status": "review",
                    "currentRevisionId": "rev-1",
                    "revisions": [],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                }))
                .expect("serialize mismatched spec"),
            )
            .expect("write mismatched spec file");

            let error = switch_project_conversation_mode(
                project.id.clone(),
                SwitchProjectConversationModeInput {
                    active_spec_id: Some("spec-active".to_string()),
                    conversation_id: conversation.id,
                    spec_ids: vec!["spec-active".to_string()],
                    target_mode: "spec".to_string(),
                },
            )
            .expect_err("mismatched spec file identity must be rejected");

            assert!(error.contains("spec file id does not match requested spec id"));
        });
    }

    fn with_temp_home(run: impl FnOnce()) {
        crate::test_support::with_temp_home("conversation-command-test", run);
    }
}
