use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub project_id: String,
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub output: String,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerInfo {
    pub project_id: String,
    pub command: String,
    pub pid: u32,
    pub status: String,
    pub started_at: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelDeployOptions {
    pub token: String,
    pub scope: Option<String>,
    pub project_name: Option<String>,
    pub target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelDeploymentInfo {
    pub project_id: String,
    pub target: String,
    pub url: String,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelUserInfo {
    pub username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelProjectMetadata {
    pub project_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutputEvent {
    pub project_id: String,
    pub command: String,
    pub stream: String,
    pub line: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatusEvent {
    pub project_id: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
    pub timestamp: String,
    pub url: Option<String>,
}

#[derive(Clone, Copy)]
pub struct AllowedCommand {
    pub label: &'static str,
    pub package_manager: &'static str,
    pub args: &'static [&'static str],
}
