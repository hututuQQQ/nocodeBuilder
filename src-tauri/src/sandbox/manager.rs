use std::{
    ffi::OsString,
    net::TcpListener,
    path::{Path, PathBuf},
};

use crate::commands::{
    node_runtime::{self, ResolvedCommand},
    types::AllowedCommand,
};

use super::{
    environment::build_sandbox_environment,
    macos::MacosSeatbeltBackend,
    network::{start_managed_proxy, ManagedProxy},
    policy::{policy_for_allowed_command, SandboxCommandPolicy, SANDBOX_POLICY_VERSION},
    process::SandboxChild,
    types::{
        SandboxError, SandboxErrorKind, SandboxHealth, SandboxMetadata, SandboxNetworkPolicy,
        SandboxRequest, SandboxStatus,
    },
    unsupported::UnsupportedBackend,
    windows::WindowsNativeBackend,
    workspace::{SandboxWorkspace, SandboxWorkspaceManager},
};

pub trait SandboxBackend: Send + Sync {
    fn health_check(&self) -> Result<SandboxHealth, SandboxError>;
    fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError>;
}

#[derive(Clone, Debug, Default)]
pub struct SandboxManager {
    workspace_manager: SandboxWorkspaceManager,
}

pub struct PreparedSandboxCommand {
    pub child: SandboxChild,
    pub workspace: SandboxWorkspace,
    pub metadata: SandboxMetadata,
    pub policy: SandboxCommandPolicy,
    #[allow(dead_code)]
    network_proxy: Option<ManagedProxy>,
}

impl SandboxManager {
    pub fn status(&self) -> SandboxStatus {
        match self.health_check() {
            Ok(health) => SandboxStatus::Ready {
                backend: health.backend,
                policy_version: health.policy_version,
                managed_node_version: node_runtime::managed_node_version()
                    .unwrap_or_else(|_| "unknown".to_string()),
            },
            Err(error) => match error.kind {
                SandboxErrorKind::SetupRequired => SandboxStatus::SetupRequired {
                    reason: error.message,
                },
                SandboxErrorKind::RepairRequired => SandboxStatus::RepairRequired {
                    reason: error.message,
                },
                SandboxErrorKind::UnsupportedPlatform => SandboxStatus::Unsupported {
                    reason: error.message,
                },
                _ => SandboxStatus::RepairRequired {
                    reason: error.message,
                },
            },
        }
    }

    pub fn spawn_command(
        &self,
        project_id: &str,
        project_dir: &Path,
        allowed: AllowedCommand,
    ) -> Result<PreparedSandboxCommand, SandboxError> {
        self.spawn_prepared_command(project_id, project_dir, allowed, false)
    }

    pub fn spawn_dev_server(
        &self,
        project_id: &str,
        project_dir: &Path,
        allowed: AllowedCommand,
    ) -> Result<PreparedSandboxCommand, SandboxError> {
        self.spawn_prepared_command(project_id, project_dir, allowed, true)
    }

    fn spawn_prepared_command(
        &self,
        project_id: &str,
        project_dir: &Path,
        allowed: AllowedCommand,
        dev_server_workspace: bool,
    ) -> Result<PreparedSandboxCommand, SandboxError> {
        let health = self.health_check()?;
        let mut policy = policy_for_allowed_command(allowed);

        let resolved =
            node_runtime::resolve_package_manager_command(allowed.package_manager, allowed.args)
                .map_err(SandboxError::unavailable)?;
        validate_managed_runtime(&resolved)?;

        let workspace = if dev_server_workspace {
            self.workspace_manager
                .prepare_dev_server(project_id, project_dir)?
        } else {
            self.workspace_manager
                .prepare_run(project_id, project_dir)?
        };
        let (network, network_proxy) =
            prepare_network_policy(policy.network, project_id, Some(&workspace.cache_root))?;
        policy.network = network;
        let environment = build_sandbox_environment(&resolved, &workspace, &policy.network)?;
        let request = SandboxRequest {
            command_label: allowed.label.to_string(),
            purpose: policy.purpose,
            executable: resolved.executable.clone(),
            args: resolved.args.iter().map(OsString::from).collect(),
            working_dir: workspace.workspace_root.clone(),
            readable_roots: readable_roots(&resolved, &workspace),
            writable_roots: writable_roots(&workspace),
            denied_roots: denied_roots(project_dir),
            environment,
            network: policy.network.clone(),
            limits: policy.limits,
        };
        let child = self.spawn_with_backend(request)?;
        let metadata = SandboxMetadata {
            backend: health.backend,
            policy_version: health.policy_version,
            network_mode: policy.network.mode(),
            workspace_path: Some(workspace.workspace_root.to_string_lossy().to_string()),
            termination_reason: None,
        };

        Ok(PreparedSandboxCommand {
            child,
            workspace,
            metadata,
            policy,
            network_proxy,
        })
    }

    pub fn reset_project(&self, project_id: &str) -> Result<(), SandboxError> {
        self.workspace_manager.reset_project(project_id)
    }

    pub fn initialize_windows(&self) -> Result<SandboxHealth, SandboxError> {
        #[cfg(target_os = "windows")]
        {
            return WindowsNativeBackend::default().initialize();
        }

        #[cfg(not(target_os = "windows"))]
        {
            Err(SandboxError::unsupported(
                "Windows sandbox initialization is only available on Windows",
            ))
        }
    }

    pub fn repair(&self) -> Result<SandboxHealth, SandboxError> {
        #[cfg(target_os = "windows")]
        {
            return WindowsNativeBackend::default().repair();
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.health_check()
        }
    }

    fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        #[cfg(target_os = "macos")]
        {
            return MacosSeatbeltBackend::default().health_check();
        }

        #[cfg(target_os = "windows")]
        {
            return WindowsNativeBackend::default().health_check();
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            UnsupportedBackend::default().health_check()
        }
    }

    fn spawn_with_backend(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        #[cfg(target_os = "macos")]
        {
            return MacosSeatbeltBackend::default().spawn(request);
        }

        #[cfg(target_os = "windows")]
        {
            return WindowsNativeBackend::default().spawn(request);
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            UnsupportedBackend::default().spawn(request)
        }
    }
}

impl SandboxBackend for MacosSeatbeltBackend {
    fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        MacosSeatbeltBackend::health_check(self)
    }

    fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        MacosSeatbeltBackend::spawn(self, request)
    }
}

impl SandboxBackend for WindowsNativeBackend {
    fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        WindowsNativeBackend::health_check(self)
    }

    fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        WindowsNativeBackend::spawn(self, request)
    }
}

impl SandboxBackend for UnsupportedBackend {
    fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        UnsupportedBackend::health_check(self)
    }

    fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        UnsupportedBackend::spawn(self, request)
    }
}

fn prepare_network_policy(
    network: SandboxNetworkPolicy,
    run_id: &str,
    cache_root: Option<&Path>,
) -> Result<(SandboxNetworkPolicy, Option<ManagedProxy>), SandboxError> {
    match network {
        SandboxNetworkPolicy::LocalServer { port: 0 } => Ok((
            SandboxNetworkPolicy::LocalServer {
                port: allocate_localhost_port()?,
            },
            None,
        )),
        SandboxNetworkPolicy::ManagedProxy {
            proxy_port: 0,
            allowed_hosts,
        } => {
            let audit_log_path =
                cache_root.map(|root| root.join("network").join("install-proxy-audit.jsonl"));
            let proxy =
                start_managed_proxy(run_id.to_string(), allowed_hosts.clone(), audit_log_path)?;
            let proxy_port = proxy.port();

            Ok((
                SandboxNetworkPolicy::ManagedProxy {
                    proxy_port,
                    allowed_hosts,
                },
                Some(proxy),
            ))
        }
        other => Ok((other, None)),
    }
}

fn allocate_localhost_port() -> Result<u16, SandboxError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        SandboxError::unavailable(format!(
            "failed to allocate localhost dev-server port: {error}"
        ))
    })?;
    let port = listener
        .local_addr()
        .map_err(|error| {
            SandboxError::unavailable(format!("failed to read localhost dev-server port: {error}"))
        })?
        .port();
    Ok(port)
}

fn validate_managed_runtime(resolved: &ResolvedCommand) -> Result<(), SandboxError> {
    if resolved.runtime_root.as_os_str().is_empty() || !resolved.executable.is_absolute() {
        return Err(SandboxError::policy_denied(
            "sandboxed npm/pnpm commands must use nocodeBuilder managed Node, not host PATH",
        ));
    }

    Ok(())
}

fn readable_roots(resolved: &ResolvedCommand, workspace: &SandboxWorkspace) -> Vec<PathBuf> {
    vec![
        resolved.runtime_root.clone(),
        resolved.runtime_bin.clone(),
        workspace.workspace_root.clone(),
    ]
}

fn writable_roots(workspace: &SandboxWorkspace) -> Vec<PathBuf> {
    vec![
        workspace.workspace_root.clone(),
        workspace.cache_root.clone(),
        workspace.tmp_root.clone(),
    ]
}

fn denied_roots(project_dir: &Path) -> Vec<PathBuf> {
    let mut denied = Vec::new();
    push_unique_root(&mut denied, project_dir.to_path_buf());
    push_unique_root(&mut denied, project_dir.join(".aibuilder"));
    push_unique_root(&mut denied, project_dir.join(".env"));

    for home_key in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(home_key) {
            let home = PathBuf::from(home);
            for sensitive in [
                ".ssh", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".netrc",
            ] {
                push_unique_root(&mut denied, home.join(sensitive));
            }
            push_unique_root(&mut denied, home.join(".config").join("gcloud"));
        }
    }

    for app_data_key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(app_data) = std::env::var_os(app_data_key) {
            let app_data = PathBuf::from(app_data);
            for sensitive in [
                PathBuf::from("gcloud"),
                PathBuf::from("Google").join("Cloud SDK"),
                PathBuf::from("Microsoft").join("Azure"),
                PathBuf::from("Microsoft").join("UserSecrets"),
                PathBuf::from("Docker"),
                PathBuf::from("NuGet").join("NuGet.Config"),
            ] {
                push_unique_root(&mut denied, app_data.join(sensitive));
            }
        }
    }

    denied
}

fn push_unique_root(roots: &mut Vec<PathBuf>, root: PathBuf) {
    if !roots.iter().any(|existing| existing == &root) {
        roots.push(root);
    }
}

#[allow(dead_code)]
fn _policy_version() -> u32 {
    SANDBOX_POLICY_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn rejects_host_path_node_runtime_resolution() {
        let resolved = ResolvedCommand {
            args: vec!["run".to_string(), "build".to_string()],
            executable: PathBuf::from("npm"),
            path_prepend: Vec::new(),
            runtime_root: PathBuf::new(),
            runtime_bin: PathBuf::new(),
            runtime_version: "host-override".to_string(),
        };

        let error = validate_managed_runtime(&resolved).expect_err("host PATH runtime rejected");

        assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
        assert!(error.message.contains("managed Node"));
    }

    #[test]
    fn accepts_absolute_managed_node_runtime_resolution() {
        let root = std::env::temp_dir().join("ncb-managed-runtime-test");
        let resolved = ResolvedCommand {
            args: vec!["run".to_string(), "build".to_string()],
            executable: root.join("bin").join("npm.cmd"),
            path_prepend: vec![root.join("bin")],
            runtime_root: root.clone(),
            runtime_bin: root.join("bin"),
            runtime_version: "v-test".to_string(),
        };

        validate_managed_runtime(&resolved).expect("managed runtime accepted");
    }

    #[test]
    fn denied_roots_do_not_cover_home_or_sandbox_root() {
        crate::test_support::with_env_lock(|| {
            let _env = EnvGuard::capture();
            let root = std::env::temp_dir().join(format!(
                "ncb-sandbox-denied-roots-{}",
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            let home = root.join("home");
            let local_app_data = home.join("AppData").join("Local");
            let app_data = home.join("AppData").join("Roaming");
            let project = home.join("projects").join("app");
            let sandbox_root = local_app_data.join("nocodeBuilder").join("sandbox");
            std::fs::create_dir_all(&project).unwrap();
            std::env::set_var("HOME", &home);
            std::env::set_var("USERPROFILE", &home);
            std::env::set_var("LOCALAPPDATA", &local_app_data);
            std::env::set_var("APPDATA", &app_data);

            let denied = denied_roots(&project);

            assert!(!denied.contains(&home));
            assert!(!denied.contains(&local_app_data));
            assert!(!denied.contains(&app_data));
            assert!(!denied.iter().any(|root| root == &sandbox_root));
            assert!(denied.contains(&project));
            assert!(denied.contains(&project.join(".aibuilder")));
            assert!(denied.contains(&project.join(".env")));
            assert!(denied.contains(&home.join(".ssh")));
            assert!(denied.contains(&home.join(".aws")));
            assert!(denied.contains(&home.join(".config").join("gcloud")));
            assert!(denied.contains(&home.join(".npmrc")));

            let _ = std::fs::remove_dir_all(root);
        });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn status_reports_unsupported_on_compile_only_platforms() {
        let status = SandboxManager::default().status();

        match status {
            SandboxStatus::Unsupported { reason } => {
                assert!(reason.contains("Windows and macOS"));
            }
            other => panic!("expected unsupported sandbox status, got {other:?}"),
        }
    }

    struct EnvGuard {
        old_home: Option<OsString>,
        old_userprofile: Option<OsString>,
        old_localappdata: Option<OsString>,
        old_appdata: Option<OsString>,
    }

    impl EnvGuard {
        fn capture() -> Self {
            Self {
                old_home: std::env::var_os("HOME"),
                old_userprofile: std::env::var_os("USERPROFILE"),
                old_localappdata: std::env::var_os("LOCALAPPDATA"),
                old_appdata: std::env::var_os("APPDATA"),
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            restore_env("HOME", self.old_home.take());
            restore_env("USERPROFILE", self.old_userprofile.take());
            restore_env("LOCALAPPDATA", self.old_localappdata.take());
            restore_env("APPDATA", self.old_appdata.take());
        }
    }

    fn restore_env(key: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}
