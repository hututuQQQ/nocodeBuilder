use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

use crate::commands::node_runtime::ResolvedCommand;

use super::{
    types::{SandboxError, SandboxNetworkPolicy},
    workspace::SandboxWorkspace,
};

pub fn build_sandbox_environment(
    resolved: &ResolvedCommand,
    workspace: &SandboxWorkspace,
    network: &SandboxNetworkPolicy,
) -> Result<BTreeMap<OsString, OsString>, SandboxError> {
    let temp_home = workspace.tmp_root.join("home");
    let temp_dir = workspace.tmp_root.join("tmp");
    let npm_cache = workspace.cache_root.join("npm");
    let corepack_home = workspace.cache_root.join("corepack");

    for directory in [&temp_home, &temp_dir, &npm_cache, &corepack_home] {
        fs::create_dir_all(directory)?;
    }

    let mut environment = BTreeMap::new();
    environment.insert(
        OsString::from("PATH"),
        join_path_list(sandbox_path_entries(resolved, workspace))?,
    );
    environment.insert(OsString::from("HOME"), temp_home.as_os_str().to_os_string());
    environment.insert(
        OsString::from("USERPROFILE"),
        temp_home.as_os_str().to_os_string(),
    );
    environment.insert(OsString::from("TEMP"), temp_dir.as_os_str().to_os_string());
    environment.insert(OsString::from("TMP"), temp_dir.as_os_str().to_os_string());
    environment.insert(
        OsString::from("NPM_CONFIG_CACHE"),
        npm_cache.as_os_str().to_os_string(),
    );
    environment.insert(
        OsString::from("COREPACK_HOME"),
        corepack_home.as_os_str().to_os_string(),
    );
    environment.insert(
        OsString::from("COREPACK_ENABLE_DOWNLOAD_PROMPT"),
        OsString::from("0"),
    );
    environment.insert(OsString::from("CI"), OsString::from("1"));
    environment.insert(OsString::from("NO_COLOR"), OsString::from("1"));
    add_platform_system_environment(&mut environment);

    match network {
        SandboxNetworkPolicy::ManagedProxy { proxy_port, .. } if *proxy_port > 0 => {
            let proxy = format!("http://127.0.0.1:{proxy_port}");
            environment.insert(OsString::from("HTTP_PROXY"), OsString::from(&proxy));
            environment.insert(OsString::from("HTTPS_PROXY"), OsString::from(proxy));
        }
        SandboxNetworkPolicy::LocalServer { port } if *port > 0 => {
            environment.insert(OsString::from("HOST"), OsString::from("127.0.0.1"));
            environment.insert(OsString::from("HOSTNAME"), OsString::from("127.0.0.1"));
            environment.insert(OsString::from("PORT"), OsString::from(port.to_string()));
        }
        _ => {}
    }

    Ok(environment)
}

#[cfg(target_os = "windows")]
fn add_platform_system_environment(environment: &mut BTreeMap<OsString, OsString>) {
    for key in ["SystemRoot", "WINDIR", "ComSpec"] {
        if let Some(value) = std::env::var_os(key) {
            if !value.is_empty() {
                environment.insert(OsString::from(key), value);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn add_platform_system_environment(_environment: &mut BTreeMap<OsString, OsString>) {}

fn sandbox_path_entries(resolved: &ResolvedCommand, workspace: &SandboxWorkspace) -> Vec<PathBuf> {
    let mut paths = resolved.path_prepend.clone();
    paths.push(workspace_node_bin(&workspace.workspace_root));
    paths
}

fn workspace_node_bin(workspace_root: &Path) -> PathBuf {
    workspace_root.join("node_modules").join(".bin")
}

fn join_path_list(paths: Vec<PathBuf>) -> Result<OsString, SandboxError> {
    std::env::join_paths(paths).map_err(|error| {
        SandboxError::unavailable(format!("failed to build sandbox PATH: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::workspace::SandboxWorkspaceKind;

    #[test]
    fn environment_uses_minimal_keys_without_host_secrets() {
        crate::test_support::with_env_lock(|| {
            let root = std::env::temp_dir().join("ncb-sandbox-env-test");
            let workspace = test_workspace(&root, SandboxWorkspaceKind::Run);
            let resolved = test_resolved_command(&root);
            let _openai = EnvVarGuard::set("OPENAI_API_KEY", "secret");

            let env =
                build_sandbox_environment(&resolved, &workspace, &SandboxNetworkPolicy::Denied)
                    .expect("environment");

            assert!(env.contains_key(&OsString::from("PATH")));
            assert!(env.contains_key(&OsString::from("HOME")));
            assert!(!env.contains_key(&OsString::from("OPENAI_API_KEY")));
            assert!(!env.contains_key(&OsString::from("GITHUB_TOKEN")));

            let _ = fs::remove_dir_all(root);
        });
    }

    #[test]
    fn local_server_environment_forces_loopback_host_and_port() {
        let root = std::env::temp_dir().join("ncb-sandbox-dev-env-test");
        let workspace = test_workspace(&root, SandboxWorkspaceKind::DevServer);
        let resolved = test_resolved_command(&root);

        let env = build_sandbox_environment(
            &resolved,
            &workspace,
            &SandboxNetworkPolicy::LocalServer { port: 5173 },
        )
        .expect("environment");

        assert_eq!(
            env.get(&OsString::from("HOST")),
            Some(&OsString::from("127.0.0.1"))
        );
        assert_eq!(
            env.get(&OsString::from("HOSTNAME")),
            Some(&OsString::from("127.0.0.1"))
        );
        assert_eq!(
            env.get(&OsString::from("PORT")),
            Some(&OsString::from("5173"))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn proxy_environment_is_only_added_for_managed_proxy_policy() {
        crate::test_support::with_env_lock(|| {
            let root = std::env::temp_dir().join("ncb-sandbox-proxy-env-test");
            let workspace = test_workspace(&root, SandboxWorkspaceKind::Run);
            let resolved = test_resolved_command(&root);
            let _http_proxy = EnvVarGuard::set("HTTP_PROXY", "http://proxy.example.invalid:8080");
            let _https_proxy = EnvVarGuard::set("HTTPS_PROXY", "http://proxy.example.invalid:8080");

            let denied =
                build_sandbox_environment(&resolved, &workspace, &SandboxNetworkPolicy::Denied)
                    .expect("denied environment");
            assert!(!denied.contains_key(&OsString::from("HTTP_PROXY")));
            assert!(!denied.contains_key(&OsString::from("HTTPS_PROXY")));

            let proxied = build_sandbox_environment(
                &resolved,
                &workspace,
                &SandboxNetworkPolicy::ManagedProxy {
                    proxy_port: 4873,
                    allowed_hosts: vec!["registry.npmjs.org".to_string()],
                },
            )
            .expect("managed proxy environment");
            assert_eq!(
                proxied.get(&OsString::from("HTTP_PROXY")),
                Some(&OsString::from("http://127.0.0.1:4873"))
            );
            assert_eq!(
                proxied.get(&OsString::from("HTTPS_PROXY")),
                Some(&OsString::from("http://127.0.0.1:4873"))
            );

            let _ = fs::remove_dir_all(root);
        });
    }

    fn test_workspace(root: &Path, kind: SandboxWorkspaceKind) -> SandboxWorkspace {
        SandboxWorkspace {
            project_id: "p".to_string(),
            kind,
            workspace_root: root.join("workspace"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
        }
    }

    fn test_resolved_command(root: &Path) -> ResolvedCommand {
        ResolvedCommand {
            args: vec!["run".to_string(), "build".to_string()],
            executable: root.join("node").join("npm"),
            path_prepend: vec![root.join("node").join("bin")],
            runtime_root: root.join("node"),
            runtime_bin: root.join("node").join("bin"),
            runtime_version: "v24.18.0".to_string(),
        }
    }

    struct EnvVarGuard {
        key: &'static str,
        old_value: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old_value = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, old_value }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}
