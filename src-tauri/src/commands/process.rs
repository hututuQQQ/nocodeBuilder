use std::{
    path::Path,
    process::{Child, Command, Stdio},
};

use super::types::AllowedCommand;

pub fn spawn_child(project_dir: &Path, allowed: AllowedCommand) -> Result<Child, String> {
    let mut command = Command::new(package_manager_executable(allowed.package_manager));
    command
        .args(allowed.args)
        .current_dir(project_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

pub fn npx_executable() -> String {
    if cfg!(target_os = "windows") {
        "npx.cmd".to_string()
    } else {
        "npx".to_string()
    }
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

fn package_manager_executable(package_manager: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{package_manager}.cmd")
    } else {
        package_manager.to_string()
    }
}
