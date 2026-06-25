use std::{collections::BTreeMap, ffi::OsString, fmt, path::PathBuf};

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxBackendKind {
    MacosSeatbelt,
    WindowsNative,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxPurpose {
    Install,
    Build,
    Test,
    Lint,
    DevServer,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SandboxNetworkPolicy {
    Denied,
    LocalServer {
        port: u16,
    },
    ManagedProxy {
        proxy_port: u16,
        allowed_hosts: Vec<String>,
    },
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxNetworkMode {
    Denied,
    LocalServer,
    ManagedProxy,
}

impl SandboxNetworkPolicy {
    pub fn mode(&self) -> SandboxNetworkMode {
        match self {
            Self::Denied => SandboxNetworkMode::Denied,
            Self::LocalServer { .. } => SandboxNetworkMode::LocalServer,
            Self::ManagedProxy { .. } => SandboxNetworkMode::ManagedProxy,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SandboxResourceLimits {
    pub timeout_seconds: Option<u64>,
    pub memory_bytes: u64,
    pub active_process_limit: u32,
    pub max_output_bytes: usize,
}

#[derive(Debug)]
pub struct SandboxRequest {
    pub command_label: String,
    pub purpose: SandboxPurpose,
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub working_dir: PathBuf,
    pub readable_roots: Vec<PathBuf>,
    pub writable_roots: Vec<PathBuf>,
    pub denied_roots: Vec<PathBuf>,
    pub environment: BTreeMap<OsString, OsString>,
    pub network: SandboxNetworkPolicy,
    pub limits: SandboxResourceLimits,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxMetadata {
    pub backend: SandboxBackendKind,
    pub policy_version: u32,
    pub network_mode: SandboxNetworkMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<SandboxTerminationReason>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxTerminationReason {
    Exit,
    Timeout,
    MemoryLimit,
    ProcessLimit,
    Cancelled,
    SandboxError,
}

#[derive(Clone, Debug)]
pub struct SandboxExit {
    pub code: Option<i32>,
    pub success: bool,
    pub termination_reason: SandboxTerminationReason,
}

#[derive(Clone, Debug)]
pub struct SandboxHealth {
    pub backend: SandboxBackendKind,
    pub policy_version: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxErrorKind {
    UnsupportedPlatform,
    SandboxUnavailable,
    SetupRequired,
    RepairRequired,
    PolicyDenied,
    SpawnFailed,
    Io,
    Timeout,
}

#[derive(Clone, Debug)]
pub struct SandboxError {
    pub kind: SandboxErrorKind,
    pub message: String,
}

impl SandboxError {
    pub fn new(kind: SandboxErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorKind::UnsupportedPlatform, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorKind::SandboxUnavailable, message)
    }

    pub fn policy_denied(message: impl Into<String>) -> Self {
        Self::new(SandboxErrorKind::PolicyDenied, message)
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "sandbox: {}", self.message)
    }
}

impl std::error::Error for SandboxError {}

impl From<std::io::Error> for SandboxError {
    fn from(error: std::io::Error) -> Self {
        Self::new(SandboxErrorKind::Io, error.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum SandboxStatus {
    Ready {
        backend: SandboxBackendKind,
        policy_version: u32,
        managed_node_version: String,
    },
    SetupRequired {
        reason: String,
    },
    RepairRequired {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}
