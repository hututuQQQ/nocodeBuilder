use std::{
    path::Path,
    process::{Child, Command, Stdio},
};

use super::{
    node_runtime::{apply_runtime_environment, resolve_package_manager_command, ResolvedCommand},
    types::AllowedCommand,
};

pub fn spawn_child(project_dir: &Path, allowed: AllowedCommand) -> Result<Child, String> {
    let resolved = resolve_package_manager_command(allowed.package_manager, allowed.args)?;
    let mut command = Command::new(&resolved.executable);
    command
        .args(&resolved.args)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_runtime_environment(&mut command, &resolved)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|error| {
        format!(
            "command: failed to start '{}' in '{}': {error}",
            allowed.label,
            project_dir.display()
        )
    })
}

pub fn resolve_npx_command(args: Vec<String>) -> Result<ResolvedCommand, String> {
    super::node_runtime::resolve_npx_command(args)
}

pub fn apply_resolved_command_environment(
    command: &mut Command,
    resolved: &ResolvedCommand,
) -> Result<(), String> {
    apply_runtime_environment(command, resolved)
}

pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("command: failed to stop dev server process tree: {error}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "command: taskkill failed while stopping dev server process tree for pid {pid}"
            ))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|error| format!("command: failed to stop dev server process: {error}"))?;

        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "command: kill failed while stopping dev server process {pid}"
            ))
        }
    }
}
