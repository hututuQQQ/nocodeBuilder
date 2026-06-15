mod command_runner;
mod command_whitelist;
mod dev_server;
mod events;
mod preview;
mod process;
mod time;
mod types;
mod vercel;

use tauri::{AppHandle, State};

pub use dev_server::DevServerRegistry;

use types::{
    CommandResult, DevServerInfo, VercelDeployOptions, VercelDeploymentInfo, VercelUserInfo,
};

#[tauri::command]
pub async fn run_command(
    app: AppHandle,
    project_id: String,
    command: String,
) -> Result<CommandResult, String> {
    command_runner::run_command(app, project_id, command).await
}

#[tauri::command]
pub fn start_dev_server(
    app: AppHandle,
    registry: State<'_, DevServerRegistry>,
    project_id: String,
) -> Result<DevServerInfo, String> {
    dev_server::start_dev_server(app, registry, project_id)
}

#[tauri::command]
pub fn stop_dev_server(
    app: AppHandle,
    registry: State<'_, DevServerRegistry>,
    project_id: String,
) -> Result<(), String> {
    dev_server::stop_dev_server(app, registry, project_id)
}

#[tauri::command]
pub fn open_preview_in_browser(url: String) -> Result<(), String> {
    preview::open_preview_in_browser(url)
}

#[tauri::command]
pub async fn deploy_to_vercel(
    app: AppHandle,
    project_id: String,
    options: VercelDeployOptions,
) -> Result<VercelDeploymentInfo, String> {
    vercel::deploy_to_vercel(app, project_id, options).await
}

#[tauri::command]
pub async fn test_vercel_token(token: String) -> Result<VercelUserInfo, String> {
    vercel::test_vercel_token(token).await
}
