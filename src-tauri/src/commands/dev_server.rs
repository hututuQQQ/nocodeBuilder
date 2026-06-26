use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::AppHandle;

use crate::{
    projects::resolve_project_dir,
    sandbox::{
        SandboxChild, SandboxManager, SandboxNetworkPolicy, SandboxWorkspace, SandboxedProcess,
    },
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

struct DevServerStopResult {
    project_id: String,
    command: String,
    pid: u32,
    result: Result<(), String>,
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
    let (child, pid, stdout, stderr, url) = {
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
            .spawn_dev_server(&project_id, &project_dir, allowed)
            .map_err(|error| error.to_string())?;
        let url = dev_server_url_from_policy(&prepared.policy.network)?;
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

        (child, pid, stdout, stderr, url)
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
            None,
            None,
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
            None,
            None,
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
        child.clone(),
    );

    match wait_for_dev_server_http_ready(&url, &child, DEV_SERVER_START_TIMEOUT) {
        Ok(()) => {
            set_dev_server_url(&url_state, url.clone())?;
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
        Err(error) => {
            let is_still_running = lock_servers(&registry)?.contains_key(&project_id);

            if is_still_running {
                let _ = stop_dev_server(app.clone(), &registry, project_id.clone());
            }

            Err(format!(
                "command: timed out waiting for {command_label} to become reachable at {url}: {error}"
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
        let command = server.command.clone();
        let pid = server.pid;
        terminate_and_cleanup_dev_server(server)?;
        emit_status(
            &app,
            &project_id,
            &command,
            "stopped",
            None,
            Some(format!("stopped pid {pid}")),
            None,
        );
    }

    Ok(())
}

pub fn stop_all_dev_servers(app: AppHandle, registry: &DevServerRegistry) -> Result<(), String> {
    for stopped in stop_all_dev_servers_inner(registry)? {
        match stopped.result {
            Ok(()) => emit_status(
                &app,
                &stopped.project_id,
                &stopped.command,
                "stopped",
                None,
                Some(format!("stopped pid {}", stopped.pid)),
                None,
            ),
            Err(error) => emit_status(
                &app,
                &stopped.project_id,
                &stopped.command,
                "failed",
                None,
                Some(error),
                None,
            ),
        }
    }

    Ok(())
}

fn stop_all_dev_servers_inner(
    registry: &DevServerRegistry,
) -> Result<Vec<DevServerStopResult>, String> {
    let servers = {
        let mut servers = lock_servers(&registry)?;
        servers.drain().collect::<Vec<_>>()
    };
    let mut stopped = Vec::with_capacity(servers.len());

    for (project_id, server) in servers {
        let command = server.command.clone();
        let pid = server.pid;
        let result = terminate_and_cleanup_dev_server(server);

        stopped.push(DevServerStopResult {
            project_id,
            command,
            pid,
            result,
        });
    }

    Ok(stopped)
}

fn terminate_and_cleanup_dev_server(server: DevServerProcess) -> Result<(), String> {
    let terminate_result = server
        .process
        .lock()
        .map_err(|_| "command: failed to lock dev server process".to_string())
        .and_then(|mut process| process.terminate_tree().map_err(|error| error.to_string()));

    server.source_sync.stop();
    server.workspace.cleanup_after_dev_server();

    terminate_result
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
        server.workspace.cleanup_after_dev_server();

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

fn dev_server_url_from_policy(network: &SandboxNetworkPolicy) -> Result<String, String> {
    match network {
        SandboxNetworkPolicy::LocalServer { port } if *port > 0 => {
            Ok(format!("http://127.0.0.1:{port}/"))
        }
        _ => {
            Err("command: dev server sandbox policy did not allocate a localhost port".to_string())
        }
    }
}

fn set_dev_server_url(url_state: &Arc<Mutex<Option<String>>>, url: String) -> Result<(), String> {
    let mut current = url_state
        .lock()
        .map_err(|_| "command: failed to store dev server URL".to_string())?;
    *current = Some(url);
    Ok(())
}

fn wait_for_dev_server_http_ready(
    url: &str,
    child: &Arc<Mutex<SandboxChild>>,
    timeout: Duration,
) -> Result<(), String> {
    let started = Instant::now();
    let mut last_error = "not probed yet".to_string();

    while started.elapsed() < timeout {
        match probe_local_http_url(url) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }

        let exited = child
            .lock()
            .map_err(|_| "failed to lock dev server process".to_string())?
            .try_wait()
            .map_err(|error| error.to_string())?;

        if let Some(status) = exited {
            return Err(format!(
                "process exited before readiness probe succeeded (code {:?})",
                status.code
            ));
        }

        thread::sleep(Duration::from_millis(250));
    }

    Err(last_error)
}

fn probe_local_http_url(url: &str) -> Result<(), String> {
    let (host, port) = parse_local_http_url(url)?;
    let mut stream = TcpStream::connect_timeout(
        &(host.as_str(), port)
            .to_socket_addrs()
            .map_err(|error| format!("invalid readiness probe address: {error}"))?
            .next()
            .ok_or_else(|| "readiness probe address did not resolve".to_string())?,
        Duration::from_millis(500),
    )
    .map_err(|error| format!("HTTP probe connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("HTTP probe read timeout setup failed: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("HTTP probe write timeout setup failed: {error}"))?;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("HTTP probe write failed: {error}"))?;

    let mut buffer = [0u8; 12];
    let read = stream
        .read(&mut buffer)
        .map_err(|error| format!("HTTP probe read failed: {error}"))?;

    if read > 0 && buffer[..read].starts_with(b"HTTP/") {
        Ok(())
    } else {
        Err("HTTP probe did not receive an HTTP response".to_string())
    }
}

fn parse_local_http_url(url: &str) -> Result<(String, u16), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "dev server URL must use http://".to_string())?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "dev server URL must include a port".to_string())?;

    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err("dev server URL must be localhost-only".to_string());
    }

    let port = port
        .parse::<u16>()
        .map_err(|_| "dev server URL port is invalid".to_string())?;

    Ok((
        if host == "[::1]" {
            "::1".to_string()
        } else {
            host.to_string()
        },
        port,
    ))
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

impl DevServerRegistry {
    pub fn is_project_running(&self, project_id: &str) -> Result<bool, String> {
        Ok(lock_servers(self)?.contains_key(project_id)
            || test_project_is_marked_running(self, project_id))
    }

    #[cfg(test)]
    pub(crate) fn mark_project_running_for_test(&self, project_id: &str) {
        test_running_projects(self)
            .lock()
            .unwrap()
            .insert(project_id.to_string());
    }
}

#[cfg(test)]
fn test_project_is_marked_running(registry: &DevServerRegistry, project_id: &str) -> bool {
    test_running_projects(registry)
        .lock()
        .unwrap()
        .contains(project_id)
}

#[cfg(not(test))]
fn test_project_is_marked_running(_registry: &DevServerRegistry, _project_id: &str) -> bool {
    false
}

#[cfg(test)]
fn test_running_projects(
    _registry: &DevServerRegistry,
) -> &'static Mutex<std::collections::HashSet<String>> {
    use std::sync::OnceLock;

    static RUNNING: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn lock_servers<'a>(
    registry: &'a DevServerRegistry,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, DevServerProcess>>, String> {
    registry
        .servers
        .lock()
        .map_err(|_| "command: failed to lock dev server registry".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{SandboxBackendKind, SandboxResourceLimits};
    use std::{
        fs,
        net::TcpListener,
        process::{Command, Stdio},
    };

    #[test]
    fn stop_all_dev_servers_drains_registry_and_cleans_dev_workspaces() {
        let registry = DevServerRegistry::default();
        let root = std::env::temp_dir().join(format!(
            "ncb-dev-server-stop-all-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let workspace_root = root.join("workspace");
        let tmp_root = root.join("tmp");
        let source_manifest_path = root.join("state").join("source-manifest.json");
        fs::create_dir_all(&workspace_root).unwrap();
        fs::create_dir_all(&tmp_root).unwrap();
        fs::create_dir_all(source_manifest_path.parent().unwrap()).unwrap();
        fs::write(workspace_root.join("marker.txt"), "dev").unwrap();
        fs::write(tmp_root.join("marker.txt"), "tmp").unwrap();
        fs::write(&source_manifest_path, "{}").unwrap();

        let child = SandboxChild::new(
            long_running_command(),
            SandboxBackendKind::Unsupported,
            SandboxResourceLimits {
                timeout_seconds: None,
                memory_bytes: 128 * 1024 * 1024,
                active_process_limit: 8,
                max_output_bytes: 1024,
            },
        )
        .unwrap();
        let pid = child.native_pid().unwrap_or_default();
        let source_sync_shutdown = Arc::new(AtomicBool::new(false));
        let project_id = "stop-all-dev-project".to_string();

        registry.servers.lock().unwrap().insert(
            project_id.clone(),
            DevServerProcess {
                command: "npm run dev".to_string(),
                pid,
                process: Arc::new(Mutex::new(child)),
                workspace: SandboxWorkspace {
                    project_id: project_id.clone(),
                    kind: crate::sandbox::SandboxWorkspaceKind::DevServer,
                    workspace_root: workspace_root.clone(),
                    cache_root: root.join("cache"),
                    tmp_root: tmp_root.clone(),
                    source_manifest_path: source_manifest_path.clone(),
                },
                source_sync: SourceSyncHandle {
                    shutdown: source_sync_shutdown.clone(),
                    handle: None,
                },
                started_at: current_timestamp(),
                url: Arc::new(Mutex::new(Some("http://127.0.0.1:5173/".to_string()))),
            },
        );

        let stopped = stop_all_dev_servers_inner(&registry).unwrap();

        assert_eq!(stopped.len(), 1);
        assert_eq!(stopped[0].project_id, project_id);
        assert_eq!(stopped[0].command, "npm run dev");
        assert!(stopped[0].result.is_ok());
        assert!(!registry.servers.lock().unwrap().contains_key(&project_id));
        assert!(source_sync_shutdown.load(Ordering::Relaxed));
        assert!(!workspace_root.exists());
        assert!(!tmp_root.exists());
        assert!(!source_manifest_path.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn readiness_probe_rejects_public_hosts() {
        assert!(parse_local_http_url("http://0.0.0.0:5173/").is_err());
        assert!(parse_local_http_url("http://192.168.1.10:5173/").is_err());
    }

    #[test]
    fn readiness_probe_accepts_local_http_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 128];
            let _ = stream.read(&mut buffer);
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });

        probe_local_http_url(&format!("http://127.0.0.1:{port}/")).unwrap();
        handle.join().unwrap();
    }

    fn long_running_command() -> Command {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
            command
        };

        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("30");
            command
        };

        #[cfg(target_os = "macos")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        command.stdin(Stdio::null());
        command
    }
}
