use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
};

use super::{
    process::SandboxChild,
    types::{
        SandboxBackendKind, SandboxError, SandboxErrorKind, SandboxHealth, SandboxNetworkPolicy,
        SandboxRequest,
    },
};
use crate::sandbox::policy::SANDBOX_POLICY_VERSION;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

#[derive(Clone, Debug, Default)]
pub struct MacosSeatbeltBackend;

impl MacosSeatbeltBackend {
    pub fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        if !Path::new(SANDBOX_EXEC).is_file() {
            return Err(SandboxError::unavailable(format!(
                "{SANDBOX_EXEC} is not available; refusing host execution fallback"
            )));
        }

        Ok(SandboxHealth {
            backend: SandboxBackendKind::MacosSeatbelt,
            policy_version: SANDBOX_POLICY_VERSION,
        })
    }

    pub fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        self.health_check()?;
        validate_request(&request)?;

        let profile = build_profile(&request);
        let mut command = Command::new(SANDBOX_EXEC);
        command.arg("-p").arg(profile).arg("--");
        command.arg(&request.executable);
        command.args(request.args.iter().map(OsString::as_os_str));
        command.current_dir(&request.working_dir).env_clear();

        for (key, value) in &request.environment {
            command.env(key, value);
        }

        #[cfg(target_os = "macos")]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            configure_process_limits(&mut command, request.limits);
        }

        SandboxChild::new(command, SandboxBackendKind::MacosSeatbelt, request.limits)
    }
}

#[cfg(target_os = "macos")]
fn configure_process_limits(command: &mut Command, limits: super::types::SandboxResourceLimits) {
    use std::{io, os::unix::process::CommandExt};

    command.pre_exec(move || {
        if let Some(timeout_seconds) = limits.timeout_seconds {
            set_resource_limit(
                libc::RLIMIT_CPU,
                timeout_seconds,
                timeout_seconds.saturating_add(5),
            )?;
        }

        set_resource_limit(libc::RLIMIT_FSIZE, 512 * 1024 * 1024, 512 * 1024 * 1024)?;
        set_resource_limit(libc::RLIMIT_NOFILE, 256, 256)?;

        Ok(())
    });

    fn set_resource_limit(resource: libc::c_int, soft: u64, hard: u64) -> io::Result<()> {
        let limit = libc::rlimit {
            rlim_cur: soft as libc::rlim_t,
            rlim_max: hard as libc::rlim_t,
        };
        let result = unsafe { libc::setrlimit(resource, &limit) };

        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

fn validate_request(request: &SandboxRequest) -> Result<(), SandboxError> {
    if !request.executable.is_absolute() {
        return Err(SandboxError::policy_denied(
            "macOS sandbox executable must be an absolute managed path",
        ));
    }

    if !request.working_dir.is_absolute() {
        return Err(SandboxError::policy_denied(
            "macOS sandbox working directory must be absolute",
        ));
    }

    Ok(())
}

fn build_profile(request: &SandboxRequest) -> String {
    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow file-read-metadata)".to_string(),
        read_rule(Path::new("/dev/null"), true),
        read_rule(Path::new("/System/Library"), false),
        read_rule(Path::new("/usr/lib"), false),
        read_rule(Path::new("/usr/share"), false),
        read_rule(Path::new("/bin"), false),
        read_rule(Path::new("/usr/bin"), false),
    ];

    for root in &request.readable_roots {
        lines.push(read_rule(root, false));
    }

    for root in &request.writable_roots {
        lines.push(read_rule(root, false));
        lines.push(write_rule(root));
    }

    match &request.network {
        SandboxNetworkPolicy::Denied => {}
        SandboxNetworkPolicy::LocalServer { port } => {
            lines.push(format!(
                "(allow network-bind (local tcp \"127.0.0.1:{}\"))",
                port
            ));
            lines.push(format!(
                "(allow network-inbound (local tcp \"127.0.0.1:{}\"))",
                port
            ));
        }
        SandboxNetworkPolicy::ManagedProxy { proxy_port, .. } => {
            lines.push(format!(
                "(allow network-outbound (remote tcp \"127.0.0.1:{}\"))",
                proxy_port
            ));
        }
    }

    for root in &request.denied_roots {
        lines.push(format!("(deny file* (subpath \"{}\"))", sbpl_path(root)));
    }

    lines.join("\n")
}

fn read_rule(path: &Path, literal: bool) -> String {
    if literal {
        format!("(allow file-read* (literal \"{}\"))", sbpl_path(path))
    } else {
        format!("(allow file-read* (subpath \"{}\"))", sbpl_path(path))
    }
}

fn write_rule(path: &Path) -> String {
    format!("(allow file-write* (subpath \"{}\"))", sbpl_path(path))
}

fn sbpl_path(path: &Path) -> String {
    path_to_absolute(path)
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

fn path_to_absolute(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(not(target_os = "macos"))]
impl MacosSeatbeltBackend {
    pub fn unavailable() -> SandboxError {
        SandboxError::new(
            SandboxErrorKind::UnsupportedPlatform,
            "macOS Seatbelt backend is only available on macOS",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::types::{SandboxPurpose, SandboxResourceLimits};
    use std::collections::BTreeMap;

    #[test]
    fn generated_profile_denies_by_default_and_mentions_denied_roots() {
        let request = SandboxRequest {
            command_label: "npm run build".to_string(),
            purpose: SandboxPurpose::Build,
            executable: PathBuf::from("/managed/node/bin/npm"),
            args: vec![],
            working_dir: PathBuf::from("/sandbox/workspace"),
            readable_roots: vec![PathBuf::from("/managed/node")],
            writable_roots: vec![PathBuf::from("/sandbox/workspace")],
            denied_roots: vec![PathBuf::from("/real/project")],
            environment: BTreeMap::new(),
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(1),
                memory_bytes: 1,
                active_process_limit: 1,
                max_output_bytes: 1024,
            },
        };
        let profile = build_profile(&request);

        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("/managed/node"));
        assert!(profile.contains("/real/project"));
    }
}
