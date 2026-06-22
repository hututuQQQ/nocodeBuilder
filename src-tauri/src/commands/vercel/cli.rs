use std::{
    path::Path,
    process::{Child, Command, Stdio},
};

use super::super::{
    events::{redact_secrets, strip_ansi_codes},
    process::{apply_resolved_command_environment, resolve_npx_command},
    types::{VercelDeployOptions, VercelUserInfo},
};

pub fn spawn_vercel_deploy_child(
    project_dir: &Path,
    options: &VercelDeployOptions,
) -> Result<Child, String> {
    let mut args = vec![
        "--yes".to_string(),
        "vercel@latest".to_string(),
        "deploy".to_string(),
        "--yes".to_string(),
        "--token".to_string(),
        options.token.trim().to_string(),
        "--no-color".to_string(),
    ];

    if options.target == "production" {
        args.push("--prod".to_string());
    }

    if let Some(scope) = normalize_optional_cli_value(options.scope.as_deref()) {
        args.push("--scope".to_string());
        args.push(scope);
    }

    if let Some(project_name) = normalize_optional_cli_value(options.project_name.as_deref()) {
        args.push("--project".to_string());
        args.push(project_name);
    }

    let resolved = resolve_npx_command(args)?;
    let mut command = Command::new(&resolved.executable);
    command
        .args(&resolved.args)
        .current_dir(project_dir)
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_resolved_command_environment(&mut command, &resolved)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|error| {
        format!(
            "vercel: failed to start deploy in '{}': {error}",
            project_dir.display()
        )
    })
}

pub fn validate_vercel_options(options: &VercelDeployOptions) -> Result<(), String> {
    normalize_secret(&options.token, "vercel: token is required")?;

    if options.target != "preview" && options.target != "production" {
        return Err("vercel: target must be preview or production".to_string());
    }

    Ok(())
}

pub fn normalize_secret(value: &str, error_message: &str) -> Result<String, String> {
    let value = value.trim();

    if value.is_empty() {
        return Err(error_message.to_string());
    }

    Ok(value.to_string())
}

pub fn vercel_whoami(token: String) -> Result<VercelUserInfo, String> {
    let resolved = resolve_npx_command(vec![
        "--yes".to_string(),
        "vercel@latest".to_string(),
        "whoami".to_string(),
        "--token".to_string(),
        token.clone(),
        "--no-color".to_string(),
    ])?;
    let mut command = Command::new(&resolved.executable);
    command
        .args(&resolved.args)
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    apply_resolved_command_environment(&mut command, &resolved)?;

    let output = command
        .output()
        .map_err(|error| format!("vercel: failed to run whoami: {error}"))?;

    let stdout = redact_secrets(
        &strip_ansi_codes(&String::from_utf8_lossy(&output.stdout)),
        &[token.as_str()],
    );
    let stderr = redact_secrets(
        &strip_ansi_codes(&String::from_utf8_lossy(&output.stderr)),
        &[token.as_str()],
    );

    if !output.status.success() {
        let message = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .or_else(|| stdout.lines().rev().find(|line| !line.trim().is_empty()))
            .unwrap_or("Vercel token validation failed");

        return Err(format!("vercel: {message}"));
    }

    let username = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    if username.is_empty() {
        return Err("vercel: token validation succeeded but no username was returned".to_string());
    }

    Ok(VercelUserInfo { username })
}

pub fn vercel_deploy_error_message(
    exit_code: Option<i32>,
    captured_output: &str,
    options: &VercelDeployOptions,
) -> String {
    let base_message = format!(
        "vercel: deploy failed with exit code {}",
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    );

    if normalize_optional_cli_value(options.project_name.as_deref()).is_some()
        && captured_output.contains("was not found in the current scope")
    {
        return format!(
            "{base_message}. The Vercel project field must be an existing project name or ID. Clear it to create or use the linked project automatically, or fix the scope/project value."
        );
    }

    base_message
}

fn normalize_optional_cli_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
