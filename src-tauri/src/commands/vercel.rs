use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use tauri::AppHandle;

use crate::projects::resolve_project_dir;

use super::{
    command_runner::run_command_blocking,
    command_whitelist::preferred_build_command,
    events::{emit_status, redact_secrets, spawn_output_reader, OutputReaderOptions},
    time::current_timestamp,
    types::{VercelDeployOptions, VercelDeploymentInfo, VercelUserInfo},
};

mod cli;
mod urls;

pub async fn deploy_to_vercel(
    app: AppHandle,
    project_id: String,
    options: VercelDeployOptions,
) -> Result<VercelDeploymentInfo, String> {
    cli::validate_vercel_options(&options)?;
    let project_dir = resolve_project_dir(&project_id)?;
    let token_for_errors = options.token.clone();
    let project_id_for_task = project_id.clone();
    let app_for_task = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let build_command = preferred_build_command(&project_dir);
        let build_result = run_command_blocking(
            app_for_task.clone(),
            project_id_for_task.clone(),
            project_dir.as_path(),
            build_command,
        )?;

        if !build_result.success {
            let exit_code = build_result
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string());

            return Err(format!(
                "deploy: local build failed before Vercel deploy with exit code {exit_code}"
            ));
        }

        run_vercel_deploy_blocking(
            app_for_task,
            project_id_for_task,
            project_dir.as_path(),
            options,
        )
    })
    .await
    .map_err(|error| format!("deploy: failed to join deploy task: {error}"))?
    .inspect_err(|error| {
        emit_status(
            &app,
            &project_id,
            "vercel deploy",
            "failed",
            None,
            Some(redact_secrets(error, &[token_for_errors.as_str()])),
            None,
        );
    })
}

pub async fn test_vercel_token(token: String) -> Result<VercelUserInfo, String> {
    let token = cli::normalize_secret(&token, "vercel: token is required")?;

    tauri::async_runtime::spawn_blocking(move || cli::vercel_whoami(token))
        .await
        .map_err(|error| format!("vercel: failed to join token validation task: {error}"))?
}

fn run_vercel_deploy_blocking(
    app: AppHandle,
    project_id: String,
    project_dir: &Path,
    options: VercelDeployOptions,
) -> Result<VercelDeploymentInfo, String> {
    let started_at = current_timestamp();
    let command_label = "vercel deploy".to_string();
    let output = Arc::new(Mutex::new(String::new()));
    let redactions = Arc::new(vec![options.token.clone()]);

    emit_status(
        &app,
        &project_id,
        &command_label,
        "started",
        None,
        None,
        None,
    );

    let mut child = cli::spawn_vercel_deploy_child(project_dir, &options)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();

    if let Some(stdout) = stdout {
        readers.push(spawn_output_reader(OutputReaderOptions {
            app: app.clone(),
            project_id: project_id.clone(),
            command: command_label.clone(),
            stream: "stdout",
            reader: stdout,
            output: Some(output.clone()),
            url_sender: None,
            url_state: None,
            redactions: Some(redactions.clone()),
        }));
    }

    if let Some(stderr) = stderr {
        readers.push(spawn_output_reader(OutputReaderOptions {
            app: app.clone(),
            project_id: project_id.clone(),
            command: command_label.clone(),
            stream: "stderr",
            reader: stderr,
            output: Some(output.clone()),
            url_sender: None,
            url_state: None,
            redactions: Some(redactions.clone()),
        }));
    }

    let status = child
        .wait()
        .map_err(|error| format!("vercel: failed to wait for deploy: {error}"))?;

    for reader in readers {
        let _ = reader.join();
    }

    let finished_at = current_timestamp();
    let captured_output = output
        .lock()
        .map_err(|_| "vercel: failed to read deployment output".to_string())?
        .clone();
    let deployment_url = urls::find_deployment_url(&captured_output, &options, project_dir);

    if !status.success() {
        let exit_code = status.code();
        let error_message = cli::vercel_deploy_error_message(exit_code, &captured_output, &options);

        emit_status(
            &app,
            &project_id,
            &command_label,
            "failed",
            exit_code,
            Some(error_message.clone()),
            None,
        );

        return Err(error_message);
    }

    let Some(url) = deployment_url else {
        emit_status(
            &app,
            &project_id,
            &command_label,
            "failed",
            status.code(),
            Some("deploy succeeded but no deployment URL was found".to_string()),
            None,
        );

        return Err("vercel: deploy succeeded but no deployment URL was found".to_string());
    };

    emit_status(
        &app,
        &project_id,
        &command_label,
        "succeeded",
        status.code(),
        None,
        Some(url.clone()),
    );

    Ok(VercelDeploymentInfo {
        project_id,
        target: options.target,
        url,
        started_at,
        finished_at,
    })
}
