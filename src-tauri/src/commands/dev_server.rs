use std::{
    collections::HashMap,
    process::Child,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use tauri::{AppHandle, State};

use crate::projects::resolve_project_dir;

use super::{
    command_whitelist::preferred_dev_command,
    events::{emit_status, spawn_output_reader},
    process::{kill_process_tree, spawn_child},
    time::current_timestamp,
    types::DevServerInfo,
};

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

fn lock_servers<'a>(
    registry: &'a State<'_, DevServerRegistry>,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, DevServerProcess>>, String> {
    registry
        .servers
        .lock()
        .map_err(|_| "command: failed to lock dev server registry".to_string())
}
