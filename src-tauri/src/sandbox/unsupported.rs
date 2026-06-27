use super::{
    process::SandboxChild,
    types::{SandboxError, SandboxErrorKind, SandboxHealth, SandboxRequest},
};

#[derive(Clone, Debug, Default)]
pub struct UnsupportedBackend;

impl UnsupportedBackend {
    pub fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        Err(SandboxError::new(
            SandboxErrorKind::UnsupportedPlatform,
            format!(
                "native sandbox execution is only implemented for Windows and macOS, not {}",
                std::env::consts::OS
            ),
        ))
    }

    pub fn spawn(&self, _request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        Err(SandboxError::new(
            SandboxErrorKind::UnsupportedPlatform,
            format!(
                "native sandbox execution is unsupported on {}; refusing host execution fallback",
                std::env::consts::OS
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::types::{SandboxNetworkPolicy, SandboxPurpose, SandboxResourceLimits};
    use std::{collections::BTreeMap, path::PathBuf};

    #[test]
    fn health_check_reports_unsupported_platform() {
        let error = UnsupportedBackend::default()
            .health_check()
            .expect_err("unsupported backend health check should fail");

        assert_eq!(error.kind, SandboxErrorKind::UnsupportedPlatform);
        assert!(error.message.contains("Windows and macOS"));
    }

    #[test]
    fn spawn_refuses_host_execution_fallback() {
        let request = SandboxRequest {
            command_label: "npm run build".to_string(),
            purpose: SandboxPurpose::Build,
            executable: PathBuf::from("/managed/node/bin/npm"),
            args: vec!["run".into(), "build".into()],
            working_dir: PathBuf::from("/sandbox/workspace"),
            readable_roots: vec![PathBuf::from("/managed/node")],
            writable_roots: vec![PathBuf::from("/sandbox/workspace")],
            denied_roots: vec![PathBuf::from("/real/project")],
            environment: BTreeMap::new(),
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(60),
                memory_bytes: 1024 * 1024,
                active_process_limit: 4,
                max_output_bytes: 1024,
            },
        };

        let error = match UnsupportedBackend::default().spawn(request) {
            Ok(_) => panic!("unsupported backend spawn should fail closed"),
            Err(error) => error,
        };

        assert_eq!(error.kind, SandboxErrorKind::UnsupportedPlatform);
        assert!(error.message.contains("refusing host execution fallback"));
    }
}
