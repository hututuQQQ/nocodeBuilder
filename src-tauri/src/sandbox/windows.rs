use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{
    process::SandboxChild,
    types::{
        SandboxBackendKind, SandboxError, SandboxErrorKind, SandboxHealth, SandboxRequest,
        SandboxResourceLimits,
    },
    workspace::sandbox_root_dir,
};
use crate::{commands::node_runtime, sandbox::policy::SANDBOX_POLICY_VERSION};

const SETUP_SCHEMA_VERSION: u32 = 1;
const RUNNER_SCHEMA_VERSION: u32 = 1;
const SETUP_SIDECAR_NAME: &str = "ncb-sandbox-setup";
const RUNNER_SIDECAR_NAME: &str = "ncb-sandbox-runner";
// TODO(PR7-follow-up): derive these names from the Tauri app identifier so
// parallel dev, beta, prod, or fork installs do not share Windows credentials.
const SANDBOX_ACCOUNT_NAME: &str = "NCB_Sandbox";
const CREDENTIAL_SERVICE_NAME: &str = "AI Web Builder";
const SANDBOX_ACCOUNT_PASSWORD_KEY: &str = "windows-sandbox:NCB_Sandbox:password";

#[derive(Clone, Debug, Default)]
pub struct WindowsNativeBackend;

impl WindowsNativeBackend {
    pub fn health_check(&self) -> Result<SandboxHealth, SandboxError> {
        let health = call_setup_sidecar(SetupSidecarAction::Status)?;
        ensure_sandbox_account_password_available()?;
        Ok(health)
    }

    pub fn spawn(&self, request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
        self.health_check()?;
        invoke_runner_sidecar(request)
    }

    pub fn initialize(&self) -> Result<SandboxHealth, SandboxError> {
        call_setup_sidecar(SetupSidecarAction::Initialize)
    }

    pub fn repair(&self) -> Result<SandboxHealth, SandboxError> {
        call_setup_sidecar(SetupSidecarAction::Repair)
    }
}

pub fn expected_health() -> SandboxHealth {
    SandboxHealth {
        backend: SandboxBackendKind::WindowsNative,
        policy_version: SANDBOX_POLICY_VERSION,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupSidecarRequest {
    schema_version: u32,
    action: SetupSidecarAction,
    sandbox_root: PathBuf,
    node_runtime_root: PathBuf,
    workspace_root: PathBuf,
    launcher_user_sid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_account_password: Option<String>,
    policy_version: u32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SetupSidecarAction {
    Status,
    Initialize,
    Repair,
}

impl SetupSidecarAction {
    fn requires_elevation(self) -> bool {
        matches!(self, Self::Initialize | Self::Repair)
    }

    fn requires_account_password(self) -> bool {
        matches!(self, Self::Initialize | Self::Repair)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupSidecarResponse {
    ok: bool,
    state: String,
    message: String,
    policy_version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerSidecarRequest {
    schema_version: u32,
    command_label: String,
    executable: PathBuf,
    args: Vec<String>,
    working_dir: PathBuf,
    readable_roots: Vec<PathBuf>,
    writable_roots: Vec<PathBuf>,
    denied_roots: Vec<PathBuf>,
    environment: BTreeMap<String, String>,
    limits: RunnerSidecarLimits,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerSidecarLimits {
    memory_bytes: u64,
    active_process_limit: u32,
    timeout_seconds: Option<u64>,
}

impl TryFrom<SandboxRequest> for RunnerSidecarRequest {
    type Error = SandboxError;

    fn try_from(request: SandboxRequest) -> Result<Self, Self::Error> {
        let args = request
            .args
            .into_iter()
            .map(|arg| os_string_to_runner_string("argument", arg))
            .collect::<Result<Vec<_>, _>>()?;
        let environment = request
            .environment
            .into_iter()
            .map(|(key, value)| {
                Ok((
                    os_string_to_runner_string("environment variable name", key)?,
                    os_string_to_runner_string("environment variable value", value)?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>, SandboxError>>()?;

        Ok(Self {
            schema_version: RUNNER_SCHEMA_VERSION,
            command_label: request.command_label,
            executable: request.executable,
            args,
            working_dir: request.working_dir,
            readable_roots: request.readable_roots,
            writable_roots: request.writable_roots,
            denied_roots: request.denied_roots,
            environment,
            limits: RunnerSidecarLimits::from(request.limits),
        })
    }
}

fn os_string_to_runner_string(label: &str, value: OsString) -> Result<String, SandboxError> {
    value.into_string().map_err(|_| {
        SandboxError::policy_denied(format!(
            "Windows sandbox runner {label} must be valid Unicode"
        ))
    })
}

impl From<SandboxResourceLimits> for RunnerSidecarLimits {
    fn from(limits: SandboxResourceLimits) -> Self {
        Self {
            memory_bytes: limits.memory_bytes,
            active_process_limit: limits.active_process_limit,
            timeout_seconds: limits.timeout_seconds,
        }
    }
}

fn call_setup_sidecar(action: SetupSidecarAction) -> Result<SandboxHealth, SandboxError> {
    let request = build_setup_request(action)?;
    let response = if action.requires_elevation() {
        invoke_setup_sidecar_elevated(&request)?
    } else {
        invoke_setup_sidecar(&request)?
    };
    setup_response_to_health(response)
}

fn build_setup_request(action: SetupSidecarAction) -> Result<SetupSidecarRequest, SandboxError> {
    let sandbox_root = sandbox_root_dir()?;
    let node_runtime_root =
        node_runtime::managed_node_runtime_parent_dir().map_err(SandboxError::unavailable)?;

    Ok(SetupSidecarRequest {
        schema_version: SETUP_SCHEMA_VERSION,
        action,
        workspace_root: sandbox_root.join("workspaces"),
        sandbox_root,
        node_runtime_root,
        launcher_user_sid: current_process_user_sid()?,
        sandbox_account_password: if action.requires_account_password() {
            Some(resolve_sandbox_account_password()?)
        } else {
            None
        },
        policy_version: SANDBOX_POLICY_VERSION,
    })
}

fn invoke_setup_sidecar(
    request: &SetupSidecarRequest,
) -> Result<SetupSidecarResponse, SandboxError> {
    let sidecar = resolve_sidecar(SETUP_SIDECAR_NAME)?;
    let payload = serde_json::to_vec(request).map_err(|error| {
        SandboxError::unavailable(format!(
            "failed to serialize Windows setup request: {error}"
        ))
    })?;
    let mut command = Command::new(&sidecar);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "failed to launch Windows sandbox setup helper '{}': {error}",
                sidecar.display()
            ),
        )
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| SandboxError::unavailable("failed to open Windows setup helper stdin"))?;
    stdin.write_all(&payload).map_err(|error| {
        SandboxError::unavailable(format!("failed to write Windows setup request: {error}"))
    })?;
    drop(stdin);

    let output = child.wait_with_output().map_err(|error| {
        SandboxError::unavailable(format!(
            "failed to read Windows setup helper response: {error}"
        ))
    })?;
    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        SandboxError::unavailable(format!(
            "Windows setup helper returned invalid UTF-8: {error}"
        ))
    })?;

    serde_json::from_str::<SetupSidecarResponse>(stdout.trim()).map_err(|error| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "Windows sandbox setup helper did not return a valid status response: {error}; stderr: {}",
                stderr.trim()
            ),
        )
    })
}

fn invoke_runner_sidecar(request: SandboxRequest) -> Result<SandboxChild, SandboxError> {
    let sidecar = resolve_sidecar(RUNNER_SIDECAR_NAME)?;
    let payload =
        serde_json::to_vec(&RunnerSidecarRequest::try_from(request)?).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to serialize Windows runner request: {error}"
            ))
        })?;
    let mut command = Command::new(&sidecar);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "failed to launch Windows sandbox runner helper '{}': {error}",
                sidecar.display()
            ),
        )
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| SandboxError::unavailable("failed to open Windows sandbox runner stdin"))?;
    stdin.write_all(&payload).map_err(|error| {
        SandboxError::unavailable(format!("failed to write Windows runner request: {error}"))
    })?;
    drop(stdin);

    Ok(SandboxChild::from_spawned_child(
        child,
        SandboxBackendKind::WindowsNative,
    ))
}

#[cfg(target_os = "windows")]
fn invoke_setup_sidecar_elevated(
    request: &SetupSidecarRequest,
) -> Result<SetupSidecarResponse, SandboxError> {
    let sidecar = resolve_sidecar(SETUP_SIDECAR_NAME)?;
    let exchange = SetupExchangeFiles::create(request)?;
    let parameters = format!(
        "--request-file {} --response-file {}",
        quote_windows_arg(&exchange.request_path),
        quote_windows_arg(&exchange.response_path)
    );
    run_elevated_and_wait(&sidecar, &parameters)?;
    read_setup_response_file(&exchange.response_path)
}

#[cfg(not(target_os = "windows"))]
fn invoke_setup_sidecar_elevated(
    request: &SetupSidecarRequest,
) -> Result<SetupSidecarResponse, SandboxError> {
    invoke_setup_sidecar(request)
}

struct SetupExchangeFiles {
    root: PathBuf,
    request_path: PathBuf,
    response_path: PathBuf,
}

impl SetupExchangeFiles {
    fn create(request: &SetupSidecarRequest) -> Result<Self, SandboxError> {
        let parent = request.sandbox_root.join("state").join("setup-ipc");
        fs::create_dir_all(&parent).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to create Windows setup exchange parent directory '{}': {error}",
                parent.display()
            ))
        })?;

        let root = parent.join(format!(
            "ncb-sandbox-setup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to create Windows setup exchange directory '{}': {error}",
                root.display()
            ))
        })?;
        let request_path = root.join("request.json");
        let response_path = root.join("response.json");
        let payload = serde_json::to_vec(request).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to serialize elevated Windows setup request: {error}"
            ))
        })?;
        fs::write(&request_path, payload).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to write elevated Windows setup request '{}': {error}",
                request_path.display()
            ))
        })?;

        Ok(Self {
            root,
            request_path,
            response_path,
        })
    }
}

impl Drop for SetupExchangeFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn read_setup_response_file(path: &Path) -> Result<SetupSidecarResponse, SandboxError> {
    let content = fs::read(path).map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "Windows sandbox setup helper did not write response file '{}': {error}",
                path.display()
            ),
        )
    })?;

    serde_json::from_slice::<SetupSidecarResponse>(&content).map_err(|error| {
        SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!("Windows sandbox setup helper wrote an invalid response file: {error}"),
        )
    })
}

#[cfg(target_os = "windows")]
fn current_process_user_sid() -> Result<Option<String>, SandboxError> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let mut token: HANDLE = std::ptr::null_mut();
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };

    if opened == 0 {
        return Err(SandboxError::unavailable(format!(
            "failed to open process token for Windows setup ACL request: {}",
            std::io::Error::last_os_error()
        )));
    }

    let mut needed = 0u32;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }

    if needed == 0 {
        unsafe {
            CloseHandle(token);
        }
        return Err(SandboxError::unavailable(format!(
            "failed to size Windows setup ACL user SID: {}",
            std::io::Error::last_os_error()
        )));
    }

    let mut token_info = vec![0u8; needed as usize];
    let queried = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            token_info.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    unsafe {
        CloseHandle(token);
    }

    if queried == 0 {
        return Err(SandboxError::unavailable(format!(
            "failed to read Windows setup ACL user SID: {}",
            std::io::Error::last_os_error()
        )));
    }

    let token_user = unsafe { &*(token_info.as_ptr() as *const TOKEN_USER) };
    let mut string_sid = std::ptr::null_mut();
    let converted = unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut string_sid) };

    if converted == 0 {
        return Err(SandboxError::unavailable(format!(
            "failed to convert Windows setup ACL user SID: {}",
            std::io::Error::last_os_error()
        )));
    }

    let mut len = 0usize;
    unsafe {
        while *string_sid.add(len) != 0 {
            len += 1;
        }
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(string_sid, len) });
    unsafe {
        LocalFree(string_sid.cast());
    }

    Ok(Some(sid))
}

#[cfg(not(target_os = "windows"))]
fn current_process_user_sid() -> Result<Option<String>, SandboxError> {
    Ok(None)
}

#[cfg(target_os = "windows")]
fn run_elevated_and_wait(sidecar: &Path, parameters: &str) -> Result<(), SandboxError> {
    use std::{mem::size_of, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_FAILED},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        UI::WindowsAndMessaging::SW_SHOWNORMAL,
    };

    let verb = wide_null("runas");
    let file = sidecar
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let parameters = wide_null(parameters);
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_SHOWNORMAL;

    let launched = unsafe { ShellExecuteExW(&mut info) };

    if launched == 0 {
        return Err(SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "failed to launch elevated Windows sandbox setup helper '{}': {}",
                sidecar.display(),
                std::io::Error::last_os_error()
            ),
        ));
    }

    if info.hProcess.is_null() {
        return Err(SandboxError::unavailable(
            "elevated Windows setup helper did not return a process handle",
        ));
    }

    let wait_result = unsafe { WaitForSingleObject(info.hProcess, INFINITE) };

    if wait_result == WAIT_FAILED {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(info.hProcess);
        }
        return Err(SandboxError::unavailable(format!(
            "failed to wait for elevated Windows setup helper: {error}"
        )));
    }

    let mut exit_code = 0u32;
    let got_exit_code = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
    unsafe {
        CloseHandle(info.hProcess);
    }

    if got_exit_code == 0 {
        return Err(SandboxError::unavailable(format!(
            "failed to read elevated Windows setup helper exit code: {}",
            std::io::Error::last_os_error()
        )));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain([0])
        .collect()
}

fn quote_windows_arg(path: &Path) -> String {
    let value = path.to_string_lossy();
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');

    for character in value.chars() {
        if character == '"' {
            quoted.push('\\');
        }
        quoted.push(character);
    }

    quoted.push('"');
    quoted
}

fn setup_response_to_health(response: SetupSidecarResponse) -> Result<SandboxHealth, SandboxError> {
    if response.ok && response.state == "ready" {
        if response.policy_version == SANDBOX_POLICY_VERSION {
            return Ok(expected_health());
        }

        return Err(SandboxError::new(
            SandboxErrorKind::RepairRequired,
            format!(
                "Windows sandbox policy version mismatch: helper {}, app {}",
                response.policy_version, SANDBOX_POLICY_VERSION
            ),
        ));
    }

    let kind = match response.state.as_str() {
        "setup-required" => SandboxErrorKind::SetupRequired,
        "repair-required" => SandboxErrorKind::RepairRequired,
        "unsupported" => SandboxErrorKind::UnsupportedPlatform,
        _ => SandboxErrorKind::SandboxUnavailable,
    };

    Err(SandboxError::new(kind, response.message))
}

#[cfg(target_os = "windows")]
fn ensure_sandbox_account_password_available() -> Result<(), SandboxError> {
    match read_sandbox_account_password() {
        Ok(password) if validate_sandbox_account_password(&password) => Ok(()),
        Ok(_) => Err(SandboxError::new(
            SandboxErrorKind::RepairRequired,
            "Windows sandbox account password in the user credential store is invalid; run repair.",
        )),
        Err(error) => Err(SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!(
                "Windows sandbox account password is missing from the user credential store; run sandbox setup. ({error})"
            ),
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_sandbox_account_password_available() -> Result<(), SandboxError> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn resolve_sandbox_account_password() -> Result<String, SandboxError> {
    match read_sandbox_account_password() {
        Ok(password) if validate_sandbox_account_password(&password) => Ok(password),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let password = generate_sandbox_account_password()?;
            write_sandbox_account_password(&password)?;
            Ok(password)
        }
        Err(error) => Err(SandboxError::new(
            SandboxErrorKind::SetupRequired,
            format!("failed to read Windows sandbox account password from the user credential store: {error}"),
        )),
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_sandbox_account_password() -> Result<String, SandboxError> {
    Err(SandboxError::unsupported(
        "Windows sandbox account passwords are only available on Windows",
    ))
}

#[cfg(target_os = "windows")]
fn read_sandbox_account_password() -> Result<String, keyring::Error> {
    sandbox_account_password_entry()?.get_password()
}

#[cfg(target_os = "windows")]
fn write_sandbox_account_password(password: &str) -> Result<(), SandboxError> {
    sandbox_account_password_entry()
        .map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to open Windows sandbox account credential entry: {error}"
            ))
        })?
        .set_password(password)
        .map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to save Windows sandbox account password in the user credential store: {error}"
            ))
        })
}

#[cfg(target_os = "windows")]
fn sandbox_account_password_entry() -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(CREDENTIAL_SERVICE_NAME, SANDBOX_ACCOUNT_PASSWORD_KEY)
}

#[cfg(target_os = "windows")]
fn generate_sandbox_account_password() -> Result<String, SandboxError> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%+-_";

    for _ in 0..16 {
        let mut random = [0u8; 52];
        getrandom::fill(&mut random).map_err(|error| {
            SandboxError::unavailable(format!(
                "failed to generate Windows sandbox account password: {error}"
            ))
        })?;

        let mut password = String::from("Qz7!");
        for byte in random {
            password.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
        }

        if validate_sandbox_account_password(&password) {
            return Ok(password);
        }
    }

    Err(SandboxError::unavailable(
        "failed to generate a Windows sandbox account password compatible with local account policy",
    ))
}

fn validate_sandbox_account_password(password: &str) -> bool {
    password.len() >= 32
        && password.len() <= 128
        && password.bytes().all(|byte| byte.is_ascii_graphic())
        && password.chars().any(|ch| ch.is_ascii_uppercase())
        && password.chars().any(|ch| ch.is_ascii_lowercase())
        && password.chars().any(|ch| ch.is_ascii_digit())
        && password.chars().any(|ch| !ch.is_ascii_alphanumeric())
        && avoids_sandbox_account_name_fragments(password)
}

fn avoids_sandbox_account_name_fragments(password: &str) -> bool {
    let lower = password.to_ascii_lowercase();
    !lower.contains("ncb") && !lower.contains("sandbox")
}

fn resolve_sidecar(name: &str) -> Result<PathBuf, SandboxError> {
    sidecar_candidates(name)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            SandboxError::new(
                SandboxErrorKind::SetupRequired,
                format!(
                    "Windows sandbox setup helper '{}' was not found next to the app binary",
                    sidecar_file_name(name)
                ),
            )
        })
}

fn sidecar_candidates(name: &str) -> Vec<PathBuf> {
    let file_name = sidecar_file_name(name);
    let mut candidates = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join(&file_name));
            candidates.push(dir.join("sandbox-sidecars").join(&file_name));

            if dir
                .file_name()
                .is_some_and(|part| part == std::ffi::OsStr::new("deps"))
            {
                if let Some(parent) = dir.parent() {
                    candidates.push(parent.join(&file_name));
                    candidates.push(parent.join("sandbox-sidecars").join(&file_name));
                }
            }

            if let Some(parent) = dir.parent() {
                candidates.push(parent.join(&file_name));
                candidates.push(parent.join("sandbox-sidecars").join(&file_name));
            }
        }
    }

    candidates
}

fn sidecar_file_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::types::{SandboxNetworkPolicy, SandboxPurpose};

    #[test]
    fn setup_response_requires_policy_match_to_be_ready() {
        let response = SetupSidecarResponse {
            ok: true,
            state: "ready".to_string(),
            message: "ready".to_string(),
            policy_version: SANDBOX_POLICY_VERSION + 1,
        };

        let error = setup_response_to_health(response).unwrap_err();
        assert_eq!(error.kind, SandboxErrorKind::RepairRequired);
    }

    #[test]
    fn setup_response_maps_setup_required() {
        let response = SetupSidecarResponse {
            ok: false,
            state: "setup-required".to_string(),
            message: "needs setup".to_string(),
            policy_version: SANDBOX_POLICY_VERSION,
        };

        let error = setup_response_to_health(response).unwrap_err();
        assert_eq!(error.kind, SandboxErrorKind::SetupRequired);
    }

    #[test]
    fn only_mutating_setup_actions_require_elevation() {
        assert!(!SetupSidecarAction::Status.requires_elevation());
        assert!(SetupSidecarAction::Initialize.requires_elevation());
        assert!(SetupSidecarAction::Repair.requires_elevation());
    }

    #[test]
    fn quotes_windows_paths_for_file_exchange() {
        let path = PathBuf::from(r#"C:\Temp\quoted "path"\request.json"#);

        assert_eq!(
            quote_windows_arg(&path),
            r#""C:\Temp\quoted \"path\"\request.json""#
        );
    }

    #[test]
    fn elevated_setup_exchange_uses_sandbox_state_directory() {
        let sandbox_root = std::env::temp_dir().join(format!(
            "ncb-sandbox-windows-exchange-test-{}",
            std::process::id()
        ));
        let request = SetupSidecarRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupSidecarAction::Initialize,
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            workspace_root: sandbox_root.join("workspaces"),
            launcher_user_sid: Some("S-1-5-21-1000".to_string()),
            sandbox_account_password: Some("Ncb!9abcdefghijklmnopqrstuvwxyz12345".to_string()),
            policy_version: SANDBOX_POLICY_VERSION,
        };

        let exchange = SetupExchangeFiles::create(&request).unwrap();

        assert!(exchange
            .root
            .starts_with(sandbox_root.join("state").join("setup-ipc")));
        assert_eq!(exchange.request_path, exchange.root.join("request.json"));
        assert_eq!(exchange.response_path, exchange.root.join("response.json"));
        assert!(exchange.request_path.exists());

        drop(exchange);
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn runner_request_preserves_command_contract() {
        let request = SandboxRequest {
            command_label: "npm run build".to_string(),
            purpose: SandboxPurpose::Build,
            executable: PathBuf::from(r"C:\ncb\runtime\node\npm.cmd"),
            args: vec![OsString::from("run"), OsString::from("build")],
            working_dir: PathBuf::from(r"C:\ncb\sandbox\workspaces\p"),
            readable_roots: vec![
                PathBuf::from(r"C:\ncb\runtime\node"),
                PathBuf::from(r"C:\ncb\sandbox\workspaces\p"),
            ],
            writable_roots: vec![PathBuf::from(r"C:\ncb\sandbox\workspaces\p")],
            denied_roots: vec![PathBuf::from(r"C:\real\project")],
            environment: BTreeMap::from([(OsString::from("CI"), OsString::from("1"))]),
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(120),
                memory_bytes: 256 * 1024 * 1024,
                active_process_limit: 16,
                max_output_bytes: 64 * 1024,
            },
        };

        let runner = RunnerSidecarRequest::try_from(request).unwrap();

        assert_eq!(runner.schema_version, RUNNER_SCHEMA_VERSION);
        assert_eq!(runner.command_label, "npm run build");
        assert_eq!(runner.args, vec!["run".to_string(), "build".to_string()]);
        assert_eq!(runner.environment.get("CI"), Some(&"1".to_string()));
        assert_eq!(
            runner.readable_roots,
            vec![
                PathBuf::from(r"C:\ncb\runtime\node"),
                PathBuf::from(r"C:\ncb\sandbox\workspaces\p"),
            ]
        );
        assert_eq!(
            runner.writable_roots,
            vec![PathBuf::from(r"C:\ncb\sandbox\workspaces\p")]
        );
        assert_eq!(runner.denied_roots, vec![PathBuf::from(r"C:\real\project")]);
        assert_eq!(runner.limits.timeout_seconds, Some(120));
        assert_eq!(runner.limits.active_process_limit, 16);
    }
}
