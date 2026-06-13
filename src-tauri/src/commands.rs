use crate::projects::resolve_project_dir;
use chrono::Utc;
use serde::Serialize;
use std::{
    collections::HashMap,
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
    validate_local_http_url(&url)?;

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
        ));
    }

    let status = child
        .wait()
        .map_err(|error| format!("command: failed to wait for {command_label}: {error}"))?;

    for reader in readers {
        let _ = reader.join();
    }

    let finished_at = current_timestamp();
    let success = status.success();
    let exit_code = status.code();

    emit_status(
        &app,
        &project_id,
        &command_label,
        if success { "succeeded" } else { "failed" },
        exit_code,
        None,
        None,
    );
    let output = output
        .lock()
        .map_err(|_| "command: failed to read command output".to_string())?
        .clone();

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

fn spawn_output_reader<R>(
    app: AppHandle,
    project_id: String,
    command: String,
    stream: &'static str,
    reader: R,
    output: Option<Arc<Mutex<String>>>,
    url_sender: Option<mpsc::Sender<String>>,
    url_state: Option<Arc<Mutex<Option<String>>>>,
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
                    let clean_line = strip_ansi_codes(line.trim_end_matches(['\r', '\n']));

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

fn validate_local_http_url(url: &str) -> Result<(), String> {
    let is_local_http = url.starts_with("http://localhost:")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://[::1]:");

    if is_local_http {
        Ok(())
    } else {
        Err("preview: only local http preview URLs can be opened".to_string())
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
