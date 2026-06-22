mod command_runner;
mod command_whitelist;
mod dev_server;
mod events;
mod preview;
mod process;
mod supabase;
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

pub fn stop_all_dev_servers(
    app: AppHandle,
    registry: State<'_, DevServerRegistry>,
) -> Result<(), String> {
    dev_server::stop_all_dev_servers(app, registry)
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

#[tauri::command]
pub async fn supabase_proxy_request(
    request: supabase::SupabaseProxyRequest,
) -> Result<supabase::SupabaseProxyResponse, String> {
    supabase::supabase_proxy_request(request).await
}

#[tauri::command]
pub async fn create_supabase_table(
    request: supabase::SupabaseCreateTableRequest,
) -> Result<(), String> {
    supabase::create_supabase_table(request).await
}

#[tauri::command]
pub async fn test_supabase_database_url(
    request: supabase::SupabaseDatabaseUrlRequest,
) -> Result<(), String> {
    supabase::test_supabase_database_url(request).await
}

#[tauri::command]
pub async fn drop_supabase_table(
    request: supabase::SupabaseDropTableRequest,
) -> Result<(), String> {
    supabase::drop_supabase_table(request).await
}

#[tauri::command]
pub async fn alter_supabase_table(
    request: supabase::SupabaseAlterTableRequest,
) -> Result<(), String> {
    supabase::alter_supabase_table(request).await
}
