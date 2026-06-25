#![allow(dead_code)]

mod environment;
mod macos;
pub mod manager;
mod network;
mod policy;
pub mod process;
mod types;
mod unsupported;
mod windows;
mod workspace;

use tauri::State;

pub use manager::SandboxManager;
pub use process::{SandboxChild, SandboxedProcess};
pub use types::{SandboxMetadata, SandboxStatus};
pub(crate) use workspace::SandboxWorkspace;

#[tauri::command]
pub fn get_sandbox_status(manager: State<'_, SandboxManager>) -> Result<SandboxStatus, String> {
    Ok(manager.status())
}

#[tauri::command]
pub fn initialize_windows_sandbox(
    manager: State<'_, SandboxManager>,
) -> Result<SandboxStatus, String> {
    manager
        .initialize_windows()
        .map(|_| manager.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn repair_sandbox(manager: State<'_, SandboxManager>) -> Result<SandboxStatus, String> {
    manager
        .repair()
        .map(|_| manager.status())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn reset_project_sandbox(
    manager: State<'_, SandboxManager>,
    project_id: String,
) -> Result<(), String> {
    manager
        .reset_project(&project_id)
        .map_err(|error| error.to_string())
}
