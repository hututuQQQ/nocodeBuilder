use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub framework: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTree {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<FileTree>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileChangeSummary {
    pub action: String,
    pub additions: usize,
    pub after_content: Option<String>,
    pub before_content: Option<String>,
    pub deletions: usize,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted_at: Option<String>,
    pub sample_added_lines: Vec<String>,
    pub sample_removed_lines: Vec<String>,
    pub unified_diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChangeRecord {
    pub id: String,
    pub created_at: String,
    pub files: Vec<ProjectFileChangeSummary>,
    pub kind: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverted_by_change_id: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activities: Option<Vec<ProjectChatActivity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activities_collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animate_content: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_streaming: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatActivity {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_line_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConversation {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub kind: String,
    pub mode: String,
    pub active_spec_id: Option<String>,
    pub spec_ids: Vec<String>,
    pub mode_changed_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_at: String,
    pub archived_at: Option<String>,
    pub messages: Vec<ProjectChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConversationSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub kind: String,
    pub mode: String,
    pub active_spec_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_message_at: String,
    pub archived_at: Option<String>,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectConversationInput {
    pub title: Option<String>,
    pub kind: String,
    pub mode: String,
    pub conversation_id: Option<String>,
    pub active_spec_id: Option<String>,
    pub spec_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchProjectConversationModeInput {
    pub conversation_id: String,
    pub target_mode: String,
    pub active_spec_id: Option<String>,
    pub spec_ids: Vec<String>,
}
