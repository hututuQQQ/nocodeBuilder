use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use tauri::AppHandle;

use crate::{projects::resolve_project_dir, sandbox::SandboxManager};

use super::{
    command_whitelist::parse_allowed_command,
    events::{emit_status, spawn_output_reader},
    time::current_timestamp,
    types::{AllowedCommand, CommandResult},
};

pub async fn run_command(
    app: AppHandle,
    sandbox_manager: SandboxManager,
    project_id: String,
    command: String,
) -> Result<CommandResult, String> {
    let allowed = parse_allowed_command(&command)?;
    let project_dir = resolve_project_dir(&project_id)?;
    let command_label = allowed.label.to_string();
    let project_id_for_task = project_id.clone();
    let app_for_task = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_command_blocking(
            app_for_task,
            sandbox_manager,
            project_id_for_task,
            project_dir.as_path(),
            allowed,
        )
    })
    .await
    .map_err(|error| format!("command: failed to join command task: {error}"))?
    .map_err(|error| {
        emit_status(
            &app,
            &project_id,
            &command_label,
            "failed",
            None,
            Some(error.clone()),
            None,
        );
        error
    })
}

pub(crate) fn run_command_blocking(
    app: AppHandle,
    sandbox_manager: SandboxManager,
    project_id: String,
    project_dir: &Path,
    allowed: AllowedCommand,
) -> Result<CommandResult, String> {
    let started_at = current_timestamp();
    let command_label = allowed.label.to_string();
    let output = Arc::new(Mutex::new(String::new()));

    emit_status(
        &app,
        &project_id,
        &command_label,
        "started",
        None,
        None,
        None,
    );

    let mut prepared = sandbox_manager
        .spawn_command(&project_id, project_dir, allowed)
        .map_err(|error| error.to_string())?;
    let stdout = prepared.child.take_stdout();
    let stderr = prepared.child.take_stderr();
    let mut readers = Vec::new();
    let max_output_bytes = Some(prepared.policy.limits.max_output_bytes);

    if let Some(stdout) = stdout {
        readers.push(spawn_output_reader(
            app.clone(),
            project_id.clone(),
            command_label.clone(),
            "stdout",
            stdout,
            Some(output.clone()),
            None,
            None,
            max_output_bytes,
            None,
        ));
    }

    if let Some(stderr) = stderr {
        readers.push(spawn_output_reader(
            app.clone(),
            project_id.clone(),
            command_label.clone(),
            "stderr",
            stderr,
            Some(output.clone()),
            None,
            None,
            max_output_bytes,
            None,
        ));
    }

    let timeout = prepared
        .policy
        .limits
        .timeout_seconds
        .map(Duration::from_secs);
    let sandbox_exit = prepared
        .child
        .wait_with_timeout(timeout)
        .map_err(|error| format!("command: failed to wait for {command_label}: {error}"))?;

    for reader in readers {
        let _ = reader.join();
    }

    let finished_at = current_timestamp();
    let mut success = sandbox_exit.success;
    let exit_code = sandbox_exit.code;
    let mut validation_message = None;
    prepared.metadata.termination_reason = Some(sandbox_exit.termination_reason);

    if success {
        if let Err(error) = validate_post_command(&prepared.workspace.workspace_root, allowed) {
            success = false;
            validation_message = Some(error);
        }
    }

    if success {
        match prepared.workspace.write_back_allowed_outputs(project_dir) {
            Ok(written) if !written.is_empty() => {
                if let Ok(mut output) = output.lock() {
                    output.push_str("[sandbox] wrote back ");
                    output.push_str(&written.join(", "));
                    output.push('\n');
                }
            }
            Ok(_) => {}
            Err(error) => {
                success = false;
                validation_message = Some(error.to_string());
            }
        }
    }

    emit_status(
        &app,
        &project_id,
        &command_label,
        if success { "succeeded" } else { "failed" },
        exit_code,
        validation_message.clone(),
        None,
    );
    let mut output = output
        .lock()
        .map_err(|_| "command: failed to read command output".to_string())?
        .clone();

    if let Some(message) = &validation_message {
        output.push_str("[validation] ");
        output.push_str(message);
        output.push('\n');
    }

    prepared.workspace.cleanup_tmp();

    Ok(CommandResult {
        project_id,
        command: command_label,
        success,
        exit_code,
        output,
        started_at,
        finished_at,
        sandbox: Some(prepared.metadata),
    })
}

fn validate_post_command(project_dir: &Path, allowed: AllowedCommand) -> Result<(), String> {
    if allowed.label == "npm install" || allowed.label == "pnpm install" {
        validate_next_install(project_dir, allowed.package_manager)?;
    }

    Ok(())
}

fn validate_next_install(project_dir: &Path, package_manager: &str) -> Result<(), String> {
    if !project_uses_next(project_dir)? {
        return Ok(());
    }

    let lockfile = if package_manager == "pnpm" {
        project_dir.join("pnpm-lock.yaml")
    } else {
        project_dir.join("package-lock.json")
    };

    if !lockfile.is_file() {
        return Err(format!(
            "install: expected lockfile '{}' was not created",
            lockfile.display()
        ));
    }

    let next_bin =
        project_dir
            .join("node_modules")
            .join(".bin")
            .join(if cfg!(target_os = "windows") {
                "next.cmd"
            } else {
                "next"
            });

    if !next_bin.is_file() {
        return Err(format!(
            "install: Next.js binary link '{}' is missing; run npm install again",
            next_bin.display()
        ));
    }

    Ok(())
}

fn project_uses_next(project_dir: &Path) -> Result<bool, String> {
    let package_path = project_dir.join("package.json");

    if !package_path.is_file() {
        return Ok(false);
    }

    let content = fs::read_to_string(&package_path).map_err(|error| {
        format!(
            "install: failed to read package.json '{}': {error}",
            package_path.display()
        )
    })?;
    let parsed = serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|error| format!("install: failed to parse package.json: {error}"))?;

    Ok(parsed
        .get("dependencies")
        .and_then(|value| value.as_object())
        .is_some_and(|dependencies| dependencies.contains_key("next"))
        || parsed
            .get("devDependencies")
            .and_then(|value| value.as_object())
            .is_some_and(|dependencies| dependencies.contains_key("next")))
}
