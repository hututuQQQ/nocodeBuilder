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

use crate::commands::DevServerRegistry;

pub use manager::SandboxManager;
pub use process::{SandboxChild, SandboxedProcess};
pub(crate) use types::SandboxNetworkPolicy;
#[cfg(test)]
pub(crate) use types::{SandboxBackendKind, SandboxResourceLimits};
pub use types::{SandboxMetadata, SandboxStatus};
pub(crate) use workspace::SandboxWorkspace;
#[cfg(test)]
pub(crate) use workspace::SandboxWorkspaceKind;

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
    registry: State<'_, DevServerRegistry>,
    project_id: String,
) -> Result<(), String> {
    reset_project_sandbox_checked(manager.inner(), registry.inner(), project_id)
}

fn reset_project_sandbox_checked(
    manager: &SandboxManager,
    registry: &DevServerRegistry,
    project_id: String,
) -> Result<(), String> {
    if registry.is_project_running(&project_id)? {
        return Err(format!(
            "sandbox: cannot reset project '{project_id}' while its dev server is running"
        ));
    }

    manager
        .reset_project(&project_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_project_refuses_to_delete_running_dev_workspace() {
        let registry = DevServerRegistry::default();
        registry.mark_project_running_for_test("project-reset-test");
        let manager = SandboxManager::default();

        let error =
            reset_project_sandbox_checked(&manager, &registry, "project-reset-test".to_string())
                .unwrap_err();

        assert!(error.contains("dev server is running"));
    }
}
