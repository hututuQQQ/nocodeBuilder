use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    metadata::METADATA_DIR,
    types::{ProjectConversation, ProjectConversationSummary},
    workspace::{current_timestamp, resolve_project_dir},
};

const CONVERSATIONS_DIR: &str = "conversations";
const INDEX_FILE: &str = "index.json";
const DEFAULT_CONVERSATION_TITLE: &str = "New chat";

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
    title: Option<String>,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let id = unique_conversation_id(&project_dir)?;
    let now = current_timestamp();
    let conversation = ProjectConversation {
        id,
        project_id,
        title: normalize_title(title.as_deref()),
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

pub fn save_project_conversation(
    project_id: String,
    mut conversation: ProjectConversation,
) -> Result<ProjectConversation, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    validate_conversation_id(&conversation.id)?;

    if conversation.project_id != project_id {
        return Err("conversation: conversation does not belong to project".to_string());
    }

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
        let mut index = serde_json::from_str::<ConversationIndex>(&content)
            .map_err(|error| format!("conversation: failed to parse conversation index: {error}"))?;

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

fn conversations_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(METADATA_DIR).join(CONVERSATIONS_DIR)
}

fn index_path(project_dir: &Path) -> PathBuf {
    conversations_dir(project_dir).join(INDEX_FILE)
}

fn conversation_file_path(project_dir: &Path, conversation_id: &str) -> PathBuf {
    conversations_dir(project_dir).join(format!("{conversation_id}.json"))
}
