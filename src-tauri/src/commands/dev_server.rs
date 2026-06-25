use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::AppHandle;

use crate::{
    projects::resolve_project_dir,
    sandbox::{SandboxChild, SandboxManager, SandboxWorkspace, SandboxedProcess},
};

use super::{
    command_whitelist::preferred_dev_command,
    events::{emit_output_line, emit_status, spawn_output_reader},
    time::current_timestamp,
    types::DevServerInfo,
};

const DEV_SERVER_START_TIMEOUT: Duration = Duration::from_secs(45);
const SOURCE_SYNC_INTERVAL: Duration = Duration::from_millis(750);

#[derive(Default, Clone)]
pub struct DevServerRegistry {
    servers: Arc<Mutex<HashMap<String, DevServerProcess>>>,
}

struct DevServerProcess {
    command: String,
    pid: u32,
    process: Arc<Mutex<SandboxChild>>,
    workspace: SandboxWorkspace,
    source_sync: SourceSyncHandle,
    started_at: String,
    url: Arc<Mutex<Option<String>>>,
}

struct SourceSyncHandle {
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

pub fn start_dev_server(
    app: AppHandle,
    registry: DevServerRegistry,
    sandbox_manager: SandboxManager,
    project_id: String,
) -> Result<DevServerInfo, String> {
    let project_dir = resolve_project_dir(&project_id)?;
    let allowed = preferred_dev_command(&project_dir);
    let command_label = allowed.label.to_string();
    let started_at = current_timestamp();
    let url_state = Arc::new(Mutex::new(None));
    let (url_sender, url_receiver) = mpsc::channel::<String>();
    let (child, pid, stdout, stderr) = {
        let mut servers = lock_servers(&registry)?;

        if let Some(server) = servers.get(&project_id) {
            if let Some(url) = server
                .url
                .lock()
                .map_err(|_| "command: failed to read dev server URL".to_string())?
                .clone()
            {
                return Ok(DevServerInfo {
                    project_id,
                    command: server.command.clone(),
                    pid: server.pid,
                    status: "running".to_string(),
                    started_at: server.started_at.clone(),
                    url,
                });
            }

            return Err("command: dev server is already starting".to_string());
        }

        let mut prepared = sandbox_manager
            .spawn_command(&project_id, &project_dir, allowed)
            .map_err(|error| error.to_string())?;
        let pid = prepared.child.native_pid().unwrap_or_default();
        let stdout = prepared.child.take_stdout();
        let stderr = prepared.child.take_stderr();
        let workspace = prepared.workspace.clone();
        let source_sync = spawn_source_sync(
            app.clone(),
            project_id.clone(),
            command_label.clone(),
            project_dir.clone(),
            workspace.clone(),
        );
        let child = Arc::new(Mutex::new(prepared.child));

        servers.insert(
            project_id.clone(),
            DevServerProcess {
                command: command_label.clone(),
                pid,
                process: child.clone(),
                workspace,
                source_sync,
                started_at: started_at.clone(),
                url: url_state.clone(),
            },
        );

        (child, pid, stdout, stderr)
    };

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
            None,
        );
    }

    spawn_dev_server_watcher(
        app.clone(),
        registry.servers.clone(),
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
                let _ = stop_dev_server(app.clone(), &registry, project_id.clone());
            }

            Err(format!(
                "command: timed out waiting for {command_label} to print a local URL"
            ))
        }
    }
}

pub fn stop_dev_server(
    app: AppHandle,
    registry: &DevServerRegistry,
    project_id: String,
) -> Result<(), String> {
    let server = {
        let mut servers = lock_servers(&registry)?;
        servers.remove(&project_id)
    };

    if let Some(server) = server {
        let terminate_result = server
            .process
            .lock()
            .map_err(|_| "command: failed to lock dev server process".to_string())
            .and_then(|mut process| process.terminate_tree().map_err(|error| error.to_string()));
        server.source_sync.stop();
        server.workspace.cleanup_tmp();
        terminate_result?;
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

pub fn stop_all_dev_servers(app: AppHandle, registry: &DevServerRegistry) -> Result<(), String> {
    let servers = {
        let mut servers = lock_servers(&registry)?;
        servers.drain().collect::<Vec<_>>()
    };

    for (project_id, server) in servers {
        let result = server
            .process
            .lock()
            .map_err(|_| "command: failed to lock dev server process".to_string())
            .and_then(|mut process| process.terminate_tree().map_err(|error| error.to_string()));

        server.source_sync.stop();
        server.workspace.cleanup_tmp();

        match result {
            Ok(()) => emit_status(
                &app,
                &project_id,
                &server.command,
                "stopped",
                None,
                Some(format!("stopped pid {}", server.pid)),
                None,
            ),
            Err(error) => emit_status(
                &app,
                &project_id,
                &server.command,
                "failed",
                None,
                Some(error),
                None,
            ),
        }
    }

    Ok(())
}

fn spawn_dev_server_watcher(
    app: AppHandle,
    servers: Arc<Mutex<HashMap<String, DevServerProcess>>>,
    project_id: String,
    command: String,
    pid: u32,
    child: Arc<Mutex<SandboxChild>>,
) {
    thread::spawn(move || {
        let exit_status = loop {
            let poll = child
                .lock()
                .map_err(|_| "failed to lock dev server process".to_string())
                .and_then(|mut child| child.try_wait().map_err(|error| error.to_string()));

            match poll {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(500)),
                Err(error) => break Err(error),
            }
        };
        let removed_server = servers
            .lock()
            .map(|mut servers| {
                let is_current = servers
                    .get(&project_id)
                    .is_some_and(|server| server.pid == pid);

                if is_current {
                    return servers.remove(&project_id);
                }

                None
            })
            .unwrap_or(None);

        let Some(server) = removed_server else {
            return;
        };
        server.source_sync.stop();
        server.workspace.cleanup_tmp();

        match exit_status {
            Ok(status) => emit_status(
                &app,
                &project_id,
                &command,
                if status.success { "stopped" } else { "failed" },
                status.code,
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

fn spawn_source_sync(
    app: AppHandle,
    project_id: String,
    command: String,
    project_dir: PathBuf,
    workspace: SandboxWorkspace,
) -> SourceSyncHandle {
    let shutdown = Arc::new(AtomicBool::new(false));
    let thread_shutdown = shutdown.clone();
    let handle = thread::spawn(move || {
        let mut last_error: Option<String> = None;

        while !thread_shutdown.load(Ordering::Relaxed) {
            if let Err(error) = workspace.sync_source_changes_from(&project_dir) {
                let error = error.to_string();

                if last_error.as_deref() != Some(error.as_str()) {
                    emit_output_line(
                        &app,
                        &project_id,
                        &command,
                        "stderr",
                        format!(
                            "sandbox: failed to sync source changes into dev workspace: {error}"
                        ),
                    );
                    last_error = Some(error);
                }
            } else {
                last_error = None;
            }

            sleep_until_next_sync(&thread_shutdown);
        }
    });

    SourceSyncHandle {
        shutdown,
        handle: Some(handle),
    }
}

fn sleep_until_next_sync(shutdown: &AtomicBool) {
    let mut slept = Duration::ZERO;

    while slept < SOURCE_SYNC_INTERVAL && !shutdown.load(Ordering::Relaxed) {
        let step = Duration::from_millis(100).min(SOURCE_SYNC_INTERVAL - slept);
        thread::sleep(step);
        slept += step;
    }
}

impl SourceSyncHandle {
    fn stop(mut self) {
        self.shutdown.store(true, Ordering::Relaxed);

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for SourceSyncHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);

        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn lock_servers<'a>(
    registry: &'a DevServerRegistry,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, DevServerProcess>>, String> {
    registry
        .servers
        .lock()
        .map_err(|_| "command: failed to lock dev server registry".to_string())
}
