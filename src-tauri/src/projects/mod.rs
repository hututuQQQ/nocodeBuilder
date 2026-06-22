mod change_commands;
mod conversation_commands;
mod file_commands;
mod metadata;
mod project_commands;
mod types;
mod workspace;

use types::{
    FileTree, ProjectChangeRecord, ProjectConversation, ProjectConversationSummary,
    ProjectFileInput, ProjectInfo,
};

pub(crate) use workspace::resolve_project_dir;

#[tauri::command]
pub fn create_project(project_name: String) -> Result<ProjectInfo, String> {
    project_commands::create_project(project_name)
}

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    project_commands::list_projects()
}

#[tauri::command]
pub fn list_files(project_id: String) -> Result<FileTree, String> {
    file_commands::list_files(project_id)
}

#[tauri::command]
pub fn read_file(project_id: String, path: String) -> Result<String, String> {
    file_commands::read_file(project_id, path)
}

#[tauri::command]
pub fn write_file(project_id: String, path: String, content: String) -> Result<(), String> {
    file_commands::write_file(project_id, path, content)
}

#[tauri::command]
pub fn write_files(project_id: String, files: Vec<ProjectFileInput>) -> Result<(), String> {
    file_commands::write_files(project_id, files)
}

#[tauri::command]
pub fn delete_files(project_id: String, paths: Vec<String>) -> Result<(), String> {
    file_commands::delete_files(project_id, paths)
}

#[tauri::command]
pub fn open_project_folder(project_id: String) -> Result<(), String> {
    project_commands::open_project_folder(project_id)
}

#[tauri::command]
pub fn list_project_change_history(
    project_id: String,
) -> Result<Vec<ProjectChangeRecord>, String> {
    change_commands::list_project_change_history(project_id)
}

#[tauri::command]
pub fn save_project_change_history(
    project_id: String,
    records: Vec<ProjectChangeRecord>,
) -> Result<(), String> {
    change_commands::save_project_change_history(project_id, records)
}

#[tauri::command]
pub fn list_project_conversations(
    project_id: String,
    include_archived: bool,
) -> Result<Vec<ProjectConversationSummary>, String> {
    conversation_commands::list_project_conversations(project_id, include_archived)
}

#[tauri::command]
pub fn create_project_conversation(
    project_id: String,
    title: Option<String>,
) -> Result<ProjectConversation, String> {
    conversation_commands::create_project_conversation(project_id, title)
}

#[tauri::command]
pub fn read_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    conversation_commands::read_project_conversation(project_id, conversation_id)
}

#[tauri::command]
pub fn save_project_conversation(
    project_id: String,
    conversation: ProjectConversation,
) -> Result<ProjectConversation, String> {
    conversation_commands::save_project_conversation(project_id, conversation)
}

#[tauri::command]
pub fn archive_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    conversation_commands::archive_project_conversation(project_id, conversation_id)
}

#[tauri::command]
pub fn unarchive_project_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<ProjectConversation, String> {
    conversation_commands::unarchive_project_conversation(project_id, conversation_id)
}
