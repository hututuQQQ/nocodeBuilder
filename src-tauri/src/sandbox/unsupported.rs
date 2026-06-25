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
