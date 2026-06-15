use crate::projects::resolve_project_dir;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

const COMMAND_OUTPUT_EVENT: &str = "command-output";
const COMMAND_STATUS_EVENT: &str = "command-status";
const DEV_SERVER_START_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Default, Clone)]
pub struct DevServerRegistry {
    servers: Arc<Mutex<HashMap<String, DevServerProcess>>>,
}

#[derive(Debug)]
struct DevServerProcess {
    command: String,
    pid: u32,
    started_at: String,
    url: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    project_id: String,
    command: String,
    success: bool,
    exit_code: Option<i32>,
    output: String,
    started_at: String,
    finished_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServerInfo {
    project_id: String,
    command: String,
    pid: u32,
    status: String,
    started_at: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelDeployOptions {
    token: String,
    scope: Option<String>,
    project_name: Option<String>,
    target: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelDeploymentInfo {
    project_id: String,
    target: String,
    url: String,
    started_at: String,
    finished_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelUserInfo {
    username: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VercelProjectMetadata {
    project_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandOutputEvent {
    project_id: String,
    command: String,
    stream: String,
    line: String,
    timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandStatusEvent {
    project_id: String,
    command: String,
    status: String,
    exit_code: Option<i32>,
    message: Option<String>,
    timestamp: String,
    url: Option<String>,
}

#[derive(Clone, Copy)]
struct AllowedCommand {
    label: &'static str,
    package_manager: &'static str,
    args: &'static [&'static str],
}

#[tauri::command]
pub async fn run_command(
    app: AppHandle,
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

#[tauri::command]
pub fn start_dev_server(
    app: AppHandle,
    registry: State<'_, DevServerRegistry>,
    project_id: String,
) -> Result<DevServerInfo, String> {
    let project_dir = resolve_project_dir(&project_id)?;

    if let Some(info) = current_dev_server_info(&registry, &project_id)? {
        return Ok(info);
    }

    let allowed = preferred_dev_command(&project_dir);
    let command_label = allowed.label.to_string();
    let started_at = current_timestamp();
    let mut child = spawn_child(&project_dir, allowed)?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let url_state = Arc::new(Mutex::new(None));
    let (url_sender, url_receiver) = mpsc::channel::<String>();

    emit_status(
        &app,
        &project_id,
        &command_label,
        "started",
        None,
        Some(format!("pid {pid}")),
        None,
    );

    if let Some(stdout) = stdout {
        spawn_output_reader(
            app.clone(),
            project_id.clone(),
            command_label.clone(),
            "stdout",
            stdout,
            None,
            Some(url_sender.clone()),
            Some(url_state.clone()),
            None,
        );
    }

    if let Some(stderr) = stderr {
        spawn_output_reader(
            app.clone(),
            project_id.clone(),
            command_label.clone(),
            "stderr",
            stderr,
            None,
            Some(url_sender),
            Some(url_state.clone()),
            None,
        );
    }

    let servers = registry.servers.clone();
    {
        let mut servers = lock_servers(&registry)?;
        servers.insert(
            project_id.clone(),
            DevServerProcess {
                command: command_label.clone(),
                pid,
                started_at: started_at.clone(),
                url: url_state.clone(),
            },
        );
    }

    spawn_dev_server_watcher(
        app.clone(),
        servers,
        project_id.clone(),
        command_label.clone(),
        pid,
        child,
    );

    match url_receiver.recv_timeout(DEV_SERVER_START_TIMEOUT) {
        Ok(url) => {
            emit_status(
                &app,
                &project_id,
                &command_label,
                "ready",
                None,
                None,
                Some(url.clone()),
            );

            Ok(DevServerInfo {
                project_id,
                command: command_label,
                pid,
                status: "running".to_string(),
                started_at,
                url,
            })
        }
        Err(_) => {
            let is_still_running = lock_servers(&registry)?.contains_key(&project_id);

            if is_still_running {
                let _ = stop_dev_server(app.clone(), registry, project_id.clone());
            }

            Err(format!(
                "command: timed out waiting for {command_label} to print a local URL"
            ))
        }
    }
}

#[tauri::command]
pub fn stop_dev_server(
    app: AppHandle,
    registry: State<'_, DevServerRegistry>,
    project_id: String,
) -> Result<(), String> {
    let server = {
        let mut servers = lock_servers(&registry)?;
        servers.remove(&project_id)
    };

    if let Some(server) = server {
        kill_process_tree(server.pid)?;
        emit_status(
            &app,
            &project_id,
            &server.command,
            "stopped",
            None,
            Some(format!("stopped pid {}", server.pid)),
            None,
        );
    }

    Ok(())
}

#[tauri::command]
pub fn open_preview_in_browser(url: String) -> Result<(), String> {
    validate_preview_browser_url(&url)?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&url);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("preview: failed to open URL in browser: {error}"))?;

    Ok(())
}

#[tauri::command]
pub async fn deploy_to_vercel(
    app: AppHandle,
    project_id: String,
    options: VercelDeployOptions,
) -> Result<VercelDeploymentInfo, String> {
    validate_vercel_options(&options)?;
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
    .map_err(|error| {
        emit_status(
            &app,
            &project_id,
            "vercel deploy",
            "failed",
            None,
            Some(redact_secrets(&error, &[token_for_errors.as_str()])),
            None,
        );
        error
    })
}

#[tauri::command]
pub async fn test_vercel_token(token: String) -> Result<VercelUserInfo, String> {
    let token = normalize_secret(&token, "vercel: token is required")?;

    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(npx_executable())
            .args([
                "--yes",
                "vercel@latest",
                "whoami",
                "--token",
                &token,
                "--no-color",
            ])
            .env("CI", "1")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
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
            return Err(
                "vercel: token validation succeeded but no username was returned".to_string(),
            );
        }

        Ok(VercelUserInfo { username })
    })
    .await
    .map_err(|error| format!("vercel: failed to join token validation task: {error}"))?
}

fn run_command_blocking(
    app: AppHandle,
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

    let mut child = spawn_child(project_dir, allowed)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();

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
            None,
        ));
    }

    let status = child
        .wait()
        .map_err(|error| format!("command: failed to wait for {command_label}: {error}"))?;

    for reader in readers {
        let _ = reader.join();
    }

    let finished_at = current_timestamp();
    let mut success = status.success();
    let exit_code = status.code();
    let mut validation_message = None;

    if success {
        if let Err(error) = validate_post_command(project_dir, allowed) {
            success = false;
            validation_message = Some(error);
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

    Ok(CommandResult {
        project_id,
        command: command_label,
        success,
        exit_code,
        output,
        started_at,
        finished_at,
    })
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

    let mut child = spawn_vercel_deploy_child(project_dir, &options)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();

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
            Some(redactions.clone()),
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
            Some(redactions.clone()),
        ));
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
    let deployment_url = find_deployment_url(&captured_output, &options, project_dir);

    if !status.success() {
        let exit_code = status.code();
        let error_message = vercel_deploy_error_message(exit_code, &captured_output, &options);

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

fn current_dev_server_info(
    registry: &State<'_, DevServerRegistry>,
    project_id: &str,
) -> Result<Option<DevServerInfo>, String> {
    let servers = lock_servers(registry)?;
    let Some(server) = servers.get(project_id) else {
        return Ok(None);
    };
    let Some(url) = server
        .url
        .lock()
        .map_err(|_| "command: failed to read dev server URL".to_string())?
        .clone()
    else {
        return Ok(None);
    };

    Ok(Some(DevServerInfo {
        project_id: project_id.to_string(),
        command: server.command.clone(),
        pid: server.pid,
        status: "running".to_string(),
        started_at: server.started_at.clone(),
        url,
    }))
}

fn spawn_child(project_dir: &Path, allowed: AllowedCommand) -> Result<Child, String> {
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

fn spawn_vercel_deploy_child(
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

    let mut command = Command::new(npx_executable());
    command
        .args(args)
        .current_dir(project_dir)
        .env("CI", "1")
        .env("NO_COLOR", "1")
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
            "vercel: failed to start deploy in '{}': {error}",
            project_dir.display()
        )
    })
}

fn spawn_output_reader<R>(
    app: AppHandle,
    project_id: String,
    command: String,
    stream: &'static str,
    reader: R,
    output: Option<Arc<Mutex<String>>>,
    url_sender: Option<mpsc::Sender<String>>,
    url_state: Option<Arc<Mutex<Option<String>>>>,
    redactions: Option<Arc<Vec<String>>>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();

        loop {
            line.clear();

            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let clean_line = redact_secrets(
                        &strip_ansi_codes(line.trim_end_matches(['\r', '\n'])),
                        redactions.as_deref().map(Vec::as_slice).unwrap_or(&[]),
                    );

                    if let Some(output) = &output {
                        if let Ok(mut output) = output.lock() {
                            output.push('[');
                            output.push_str(stream);
                            output.push_str("] ");
                            output.push_str(&clean_line);
                            output.push('\n');
                        }
                    }

                    let _ = app.emit(
                        COMMAND_OUTPUT_EVENT,
                        CommandOutputEvent {
                            project_id: project_id.clone(),
                            command: command.clone(),
                            stream: stream.to_string(),
                            line: clean_line.clone(),
                            timestamp: current_timestamp(),
                        },
                    );

                    if let (Some(url_sender), Some(url_state)) = (&url_sender, &url_state) {
                        if let Some(url) = detect_local_url(&clean_line) {
                            if let Ok(mut current_url) = url_state.lock() {
                                if current_url.is_none() {
                                    *current_url = Some(url.clone());
                                    let _ = url_sender.send(url);
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        COMMAND_OUTPUT_EVENT,
                        CommandOutputEvent {
                            project_id: project_id.clone(),
                            command: command.clone(),
                            stream: "stderr".to_string(),
                            line: format!("command: failed to read {stream}: {error}"),
                            timestamp: current_timestamp(),
                        },
                    );
                    break;
                }
            }
        }
    })
}

fn spawn_dev_server_watcher(
    app: AppHandle,
    servers: Arc<Mutex<HashMap<String, DevServerProcess>>>,
    project_id: String,
    command: String,
    pid: u32,
    mut child: Child,
) {
    thread::spawn(move || {
        let exit_status = child.wait();
        let should_emit = servers
            .lock()
            .map(|mut servers| {
                let is_current = servers
                    .get(&project_id)
                    .is_some_and(|server| server.pid == pid);

                if is_current {
                    servers.remove(&project_id);
                }

                is_current
            })
            .unwrap_or(false);

        if !should_emit {
            return;
        }

        match exit_status {
            Ok(status) => emit_status(
                &app,
                &project_id,
                &command,
                if status.success() {
                    "stopped"
                } else {
                    "failed"
                },
                status.code(),
                None,
                None,
            ),
            Err(error) => emit_status(
                &app,
                &project_id,
                &command,
                "failed",
                None,
                Some(format!("failed to wait for dev server: {error}")),
                None,
            ),
        }
    });
}

fn parse_allowed_command(command: &str) -> Result<AllowedCommand, String> {
    let normalized = normalize_command(command);

    match normalized.as_str() {
        "npm install" => Ok(AllowedCommand {
            label: "npm install",
            package_manager: "npm",
            args: &["install"],
        }),
        "npm run dev" => Ok(AllowedCommand {
            label: "npm run dev",
            package_manager: "npm",
            args: &["run", "dev"],
        }),
        "npm run build" => Ok(AllowedCommand {
            label: "npm run build",
            package_manager: "npm",
            args: &["run", "build"],
        }),
        "pnpm install" => Ok(AllowedCommand {
            label: "pnpm install",
            package_manager: "pnpm",
            args: &["install"],
        }),
        "pnpm dev" => Ok(AllowedCommand {
            label: "pnpm dev",
            package_manager: "pnpm",
            args: &["dev"],
        }),
        "pnpm build" => Ok(AllowedCommand {
            label: "pnpm build",
            package_manager: "pnpm",
            args: &["build"],
        }),
        _ => Err(format!(
            "command: '{normalized}' is not allowed. Allowed commands: npm install, npm run dev, npm run build, pnpm install, pnpm dev, pnpm build"
        )),
    }
}

fn preferred_dev_command(project_dir: &Path) -> AllowedCommand {
    if project_dir.join("pnpm-lock.yaml").is_file() {
        parse_allowed_command("pnpm dev").expect("pnpm dev must be allowed")
    } else {
        parse_allowed_command("npm run dev").expect("npm run dev must be allowed")
    }
}

fn preferred_build_command(project_dir: &Path) -> AllowedCommand {
    if project_dir.join("pnpm-lock.yaml").is_file() {
        parse_allowed_command("pnpm build").expect("pnpm build must be allowed")
    } else {
        parse_allowed_command("npm run build").expect("npm run build must be allowed")
    }
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn package_manager_executable(package_manager: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{package_manager}.cmd")
    } else {
        package_manager.to_string()
    }
}

fn npx_executable() -> String {
    if cfg!(target_os = "windows") {
        "npx.cmd".to_string()
    } else {
        "npx".to_string()
    }
}

fn validate_vercel_options(options: &VercelDeployOptions) -> Result<(), String> {
    normalize_secret(&options.token, "vercel: token is required")?;

    if options.target != "preview" && options.target != "production" {
        return Err("vercel: target must be preview or production".to_string());
    }

    Ok(())
}

fn normalize_secret(value: &str, error_message: &str) -> Result<String, String> {
    let value = value.trim();

    if value.is_empty() {
        return Err(error_message.to_string());
    }

    Ok(value.to_string())
}

fn normalize_optional_cli_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn vercel_deploy_error_message(
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

fn detect_local_url(line: &str) -> Option<String> {
    ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"]
        .iter()
        .filter_map(|marker| {
            let start = line.find(marker)?;
            let tail = &line[start..];
            let url = tail
                .chars()
                .take_while(|character| {
                    !character.is_whitespace()
                        && *character != '"'
                        && *character != '\''
                        && *character != '<'
                        && *character != '>'
                })
                .collect::<String>();

            if url.is_empty() {
                None
            } else {
                Some(url)
            }
        })
        .next()
}

fn find_deployment_url(
    output: &str,
    options: &VercelDeployOptions,
    project_dir: &Path,
) -> Option<String> {
    let urls = output
        .split_whitespace()
        .filter_map(extract_https_url)
        .collect::<Vec<_>>();

    if options.target == "production" {
        if let Some(production_url) = output
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains("production"))
            .flat_map(extract_https_urls)
            .find(|url| !is_vercel_dashboard_url(url))
        {
            return Some(prefer_stable_production_url(&production_url, project_dir));
        }

        if let Some(url) = urls.iter().rev().find(|url| !is_vercel_dashboard_url(url)) {
            return Some(prefer_stable_production_url(url, project_dir));
        }
    }

    urls.iter()
        .rev()
        .find(|url| !is_vercel_dashboard_url(url))
        .cloned()
        .or_else(|| urls.into_iter().last())
}

fn extract_https_url(value: &str) -> Option<String> {
    let start = value.find("https://")?;
    let url = value[start..]
        .chars()
        .take_while(|character| {
            !character.is_whitespace()
                && *character != '"'
                && *character != '\''
                && *character != '<'
                && *character != '>'
                && *character != ')'
                && *character != ']'
                && *character != ','
        })
        .collect::<String>()
        .trim_end_matches(['.', ';', ':'])
        .to_string();

    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

fn extract_https_urls(line: &str) -> Vec<String> {
    line.split_whitespace()
        .filter_map(extract_https_url)
        .collect()
}

fn is_vercel_dashboard_url(url: &str) -> bool {
    url.starts_with("https://vercel.com/")
}

fn prefer_stable_production_url(url: &str, project_dir: &Path) -> String {
    stable_production_url_from_generated_url(url, project_dir).unwrap_or_else(|| url.to_string())
}

fn stable_production_url_from_generated_url(url: &str, project_dir: &Path) -> Option<String> {
    let host = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?
        .strip_suffix(".vercel.app")?;
    let project_name = read_vercel_project_name(project_dir)?;
    let tail = host.strip_prefix(&format!("{project_name}-"))?;
    let (unique_hash, scope_slug) = tail.split_once('-')?;

    if unique_hash.len() < 6
        || !unique_hash
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        || scope_slug.trim().is_empty()
    {
        return None;
    }

    Some(format!("https://{project_name}-{scope_slug}.vercel.app"))
}

fn read_vercel_project_name(project_dir: &Path) -> Option<String> {
    let metadata_path = project_dir.join(".vercel").join("project.json");
    let content = fs::read_to_string(metadata_path).ok()?;
    let metadata = serde_json::from_str::<VercelProjectMetadata>(&content).ok()?;
    let project_name = metadata.project_name?.trim().to_string();

    if project_name.is_empty() {
        None
    } else {
        Some(project_name)
    }
}

fn strip_ansi_codes(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek().is_some_and(|next| *next == '[') {
            chars.next();

            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }

    output
}

fn redact_secrets<S: AsRef<str>>(input: &str, secrets: &[S]) -> String {
    secrets
        .iter()
        .map(|secret| secret.as_ref().trim())
        .filter(|secret| secret.len() >= 8)
        .fold(input.to_string(), |current, secret| {
            current.replace(secret, "[redacted]")
        })
}

fn emit_status(
    app: &AppHandle,
    project_id: &str,
    command: &str,
    status: &str,
    exit_code: Option<i32>,
    message: Option<String>,
    url: Option<String>,
) {
    let _ = app.emit(
        COMMAND_STATUS_EVENT,
        CommandStatusEvent {
            project_id: project_id.to_string(),
            command: command.to_string(),
            status: status.to_string(),
            exit_code,
            message,
            timestamp: current_timestamp(),
            url,
        },
    );
}

fn kill_process_tree(pid: u32) -> Result<(), String> {
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

fn validate_preview_browser_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    let is_local_http = url.starts_with("http://localhost:")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://[::1]:");
    let is_https = url.starts_with("https://") && !url.chars().any(char::is_whitespace);

    if is_local_http || is_https {
        Ok(())
    } else {
        Err("preview: only local http or https preview URLs can be opened".to_string())
    }
}

fn lock_servers<'a>(
    registry: &'a State<'_, DevServerRegistry>,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, DevServerProcess>>, String> {
    registry
        .servers
        .lock()
        .map_err(|_| "command: failed to lock dev server registry".to_string())
}

fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn production_deploy_prefers_stable_project_domain() {
        let project_dir = create_temp_vercel_project("test");
        let options = VercelDeployOptions {
            token: "test-token".to_string(),
            scope: None,
            project_name: None,
            target: "production".to_string(),
        };
        let output = "\
Inspect: https://vercel.com/huwenlong-s-projects/test/abc
Production: https://test-4hl6el33y-huwenlong-s-projects.vercel.app
";

        let url = find_deployment_url(output, &options, &project_dir)
            .expect("deployment URL should be found");

        assert_eq!(url, "https://test-huwenlong-s-projects.vercel.app");

        let _ = fs::remove_dir_all(project_dir);
    }

    #[test]
    fn preview_deploy_keeps_specific_deployment_url() {
        let project_dir = create_temp_vercel_project("test");
        let options = VercelDeployOptions {
            token: "test-token".to_string(),
            scope: None,
            project_name: None,
            target: "preview".to_string(),
        };
        let output = "https://test-4hl6el33y-huwenlong-s-projects.vercel.app";

        let url = find_deployment_url(output, &options, &project_dir)
            .expect("deployment URL should be found");

        assert_eq!(
            url,
            "https://test-4hl6el33y-huwenlong-s-projects.vercel.app"
        );

        let _ = fs::remove_dir_all(project_dir);
    }

    fn create_temp_vercel_project(project_name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        let project_dir = std::env::temp_dir().join(format!("ai-web-builder-vercel-test-{nonce}"));
        let vercel_dir = project_dir.join(".vercel");

        fs::create_dir_all(&vercel_dir).expect("temp .vercel dir should be created");
        fs::write(
            vercel_dir.join("project.json"),
            format!(r#"{{"projectName":"{project_name}"}}"#),
        )
        .expect("temp project metadata should be written");

        project_dir
    }
}
