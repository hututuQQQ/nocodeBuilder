use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};

const MAX_INPUT_BYTES: usize = 64 * 1024;
const SETUP_SCHEMA_VERSION: u32 = 1;
const SANDBOX_ACCOUNT_NAME: &str = "NCB_Sandbox";
const SANDBOX_GROUP_NAME: &str = "NoCodeBuilderSandboxUsers";
#[cfg(all(target_os = "windows", not(test)))]
const SANDBOX_ACCOUNT_DESCRIPTION: &str =
    "Low-privilege account reserved for nocodeBuilder native sandbox runs.";
#[cfg(all(target_os = "windows", not(test)))]
const SANDBOX_GROUP_DESCRIPTION: &str =
    "Local group containing nocodeBuilder native sandbox identities.";
const SETUP_PROGRESS_FILE: &str = "windows-setup-progress.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    schema_version: u32,
    action: SetupAction,
    sandbox_root: PathBuf,
    node_runtime_root: PathBuf,
    workspace_root: PathBuf,
    #[serde(default)]
    launcher_user_sid: Option<String>,
    #[serde(default)]
    sandbox_account_password: Option<String>,
    policy_version: u32,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SetupAction {
    Status,
    Initialize,
    Repair,
    Upgrade,
    Uninstall,
}

impl SetupAction {
    fn requires_account_password(self) -> bool {
        matches!(self, Self::Initialize | Self::Repair | Self::Upgrade)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupResponse {
    ok: bool,
    state: &'static str,
    message: String,
    policy_version: u32,
}

struct SetupInvocation {
    request: SetupRequest,
    response_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgressMarker {
    schema_version: u32,
    policy_version: u32,
    sandbox_root: PathBuf,
    node_runtime_root: PathBuf,
    workspace_root: PathBuf,
    sandbox_account: String,
    sandbox_group: String,
    directories_provisioned: bool,
    account_configured: bool,
    acls_configured: bool,
    network_filtering_configured: bool,
    updated_at: String,
}

fn main() {
    let mut response_path = None;
    let response = match read_setup_invocation() {
        Ok(invocation) => {
            response_path = invocation.response_path;
            handle_setup_request(invocation.request).unwrap_or_else(|message| SetupResponse {
                ok: false,
                state: "error",
                message,
                policy_version: SETUP_SCHEMA_VERSION,
            })
        }
        Err(message) => SetupResponse {
            ok: false,
            state: "error",
            message,
            policy_version: SETUP_SCHEMA_VERSION,
        },
    };

    if let Err(error) = emit_setup_response(response_path.as_deref(), &response) {
        eprintln!("{error}");
        std::process::exit(1);
    }

    if !response.ok {
        std::process::exit(1);
    }
}

fn read_setup_invocation() -> Result<SetupInvocation, String> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    read_setup_invocation_from_args(&args)
}

fn read_setup_invocation_from_args(args: &[OsString]) -> Result<SetupInvocation, String> {
    if args.is_empty() {
        return Ok(SetupInvocation {
            request: parse_setup_request_bytes(read_stdin_bytes()?)?,
            response_path: None,
        });
    }

    if args.len() != 4
        || args[0] != OsStr::new("--request-file")
        || args[2] != OsStr::new("--response-file")
    {
        return Err("unsupported setup helper arguments".to_string());
    }

    let request_path = PathBuf::from(&args[1]);
    let response_path = PathBuf::from(&args[3]);
    validate_absolute_path("requestFile", &request_path)?;
    validate_absolute_path("responseFile", &response_path)?;

    let content = fs::read(&request_path).map_err(|error| {
        format!(
            "failed to read setup request file '{}': {error}",
            request_path.display()
        )
    })?;

    if content.len() > MAX_INPUT_BYTES {
        return Err("setup request is too large".to_string());
    }

    Ok(SetupInvocation {
        request: parse_setup_request_bytes(content)?,
        response_path: Some(response_path),
    })
}

fn read_stdin_bytes() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("failed to read setup request: {error}"))?;

    if input.len() > MAX_INPUT_BYTES {
        return Err("setup request is too large".to_string());
    }

    Ok(input)
}

fn parse_setup_request_bytes(input: Vec<u8>) -> Result<SetupRequest, String> {
    serde_json::from_slice::<SetupRequest>(&input)
        .map_err(|error| format!("failed to parse setup request JSON: {error}"))
}

fn emit_setup_response(
    response_path: Option<&Path>,
    response: &SetupResponse,
) -> Result<(), String> {
    let content = serde_json::to_vec(response)
        .map_err(|error| format!("failed to serialize setup response: {error}"))?;

    let Some(response_path) = response_path else {
        println!("{}", String::from_utf8_lossy(&content));
        return Ok(());
    };

    validate_absolute_path("responseFile", response_path)?;
    write_file_atomically(response_path, &content, "setup response")
}

fn handle_setup_request(request: SetupRequest) -> Result<SetupResponse, String> {
    validate_request(&request)?;

    match request.action {
        SetupAction::Status => status_response(&request),
        SetupAction::Initialize | SetupAction::Repair | SetupAction::Upgrade => {
            require_elevated_setup_token()?;
            initialize_or_repair(&request)
        }
        SetupAction::Uninstall => {
            require_elevated_setup_token()?;
            uninstall_progress(&request)
        }
    }
}

fn validate_request(request: &SetupRequest) -> Result<(), String> {
    if request.schema_version != SETUP_SCHEMA_VERSION {
        return Err(format!(
            "unsupported setup schema version {}",
            request.schema_version
        ));
    }

    validate_absolute_path("sandboxRoot", &request.sandbox_root)?;
    validate_absolute_path("nodeRuntimeRoot", &request.node_runtime_root)?;
    validate_absolute_path("workspaceRoot", &request.workspace_root)?;
    if let Some(sid) = &request.launcher_user_sid {
        validate_sid_string("launcherUserSid", sid)?;
    }
    if request.action.requires_account_password() {
        let password = request.sandbox_account_password.as_deref().ok_or_else(|| {
            "Windows sandbox setup request is missing the sandbox account password".to_string()
        })?;
        validate_sandbox_account_password(password)?;
    } else if let Some(password) = &request.sandbox_account_password {
        validate_sandbox_account_password(password)?;
    }
    ensure_child_path(
        "workspaceRoot",
        &request.sandbox_root,
        &request.workspace_root,
    )?;

    Ok(())
}

fn validate_sandbox_account_password(password: &str) -> Result<(), String> {
    let valid = password.len() >= 32
        && password.len() <= 128
        && password.bytes().all(|byte| byte.is_ascii_graphic())
        && password.chars().any(|ch| ch.is_ascii_uppercase())
        && password.chars().any(|ch| ch.is_ascii_lowercase())
        && password.chars().any(|ch| ch.is_ascii_digit())
        && password.chars().any(|ch| !ch.is_ascii_alphanumeric());

    if valid {
        Ok(())
    } else {
        Err("sandboxAccountPassword is invalid".to_string())
    }
}

fn validate_sid_string(label: &str, sid: &str) -> Result<(), String> {
    let mut parts = sid.split('-');
    let valid = sid.len() <= 184
        && parts.next() == Some("S")
        && parts.clone().count() >= 2
        && parts.all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()));

    if valid {
        Ok(())
    } else {
        Err(format!("{label} is invalid"))
    }
}

fn validate_absolute_path(label: &str, path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }

    let text = path.to_string_lossy();

    if text.len() > 512
        || text.contains('\0')
        || path.components().any(|component| {
            !matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::Normal(_)
            )
        })
    {
        return Err(format!("{label} is invalid"));
    }

    Ok(())
}

fn ensure_child_path(label: &str, parent: &Path, child: &Path) -> Result<(), String> {
    if child.starts_with(parent) {
        return Ok(());
    }

    Err(format!("{label} must stay inside sandboxRoot"))
}

fn status_response(request: &SetupRequest) -> Result<SetupResponse, String> {
    let marker_path = progress_marker_path(request);

    if !marker_path.exists() {
        return Ok(setup_required_response(
            request,
            "Windows sandbox setup helper is present, but setup has not been initialized.",
        ));
    }

    let marker = match read_progress_marker(&marker_path) {
        Ok(marker) => marker,
        Err(error) => return Ok(repair_required_response(request, error)),
    };

    if let Err(error) = validate_marker_matches_request(request, &marker) {
        return Ok(repair_required_response(request, error));
    }

    if marker.account_configured {
        if let Err(error) = verify_sandbox_account() {
            return Ok(repair_required_response(request, error));
        }
    }

    if marker.acls_configured {
        if let Err(error) = verify_sandbox_acls(request) {
            return Ok(repair_required_response(request, error));
        }
    }

    if marker.network_filtering_configured {
        if let Err(error) = verify_network_filtering() {
            return Ok(repair_required_response(request, error));
        }
    }

    if marker.account_configured && marker.acls_configured && marker.network_filtering_configured {
        return Ok(SetupResponse {
            ok: true,
            state: "ready",
            message: "Windows sandbox account, logon rights, ACLs, loopback allow filters, default network block filters, and runner launch prerequisites are provisioned.".to_string(),
            policy_version: request.policy_version,
        });
    }

    Ok(setup_required_response(
        request,
        incomplete_setup_message(&marker),
    ))
}

fn initialize_or_repair(request: &SetupRequest) -> Result<SetupResponse, String> {
    provision_app_owned_directories(request)?;
    configure_sandbox_account(request)?;
    configure_sandbox_acls(request)?;
    configure_network_filtering()?;
    let marker = SetupProgressMarker {
        schema_version: SETUP_SCHEMA_VERSION,
        policy_version: request.policy_version,
        sandbox_root: request.sandbox_root.clone(),
        node_runtime_root: request.node_runtime_root.clone(),
        workspace_root: request.workspace_root.clone(),
        sandbox_account: SANDBOX_ACCOUNT_NAME.to_string(),
        sandbox_group: SANDBOX_GROUP_NAME.to_string(),
        directories_provisioned: true,
        account_configured: true,
        acls_configured: true,
        network_filtering_configured: true,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_progress_marker(&progress_marker_path(request), &marker)?;

    Ok(SetupResponse {
        ok: true,
        state: "ready",
        message: "Windows sandbox directories, low-privilege account with restricted logon rights, app-owned ACLs, loopback allow filters, and default network block filters were provisioned.".to_string(),
        policy_version: request.policy_version,
    })
}

fn uninstall_progress(request: &SetupRequest) -> Result<SetupResponse, String> {
    let marker_path = progress_marker_path(request);
    remove_network_filtering()?;
    remove_sandbox_account()?;

    if marker_path.exists() {
        fs::remove_file(&marker_path).map_err(|error| {
            format!(
                "failed to remove Windows sandbox setup progress marker '{}': {error}",
                marker_path.display()
            )
        })?;
    }

    Ok(setup_required_response(
        request,
        "Windows sandbox setup progress marker, sandbox account, sandbox local group, loopback allow filters, and default network block filters were removed. App-owned sandbox directories are left in place for project reset/manual cache cleanup.",
    ))
}

fn provision_app_owned_directories(request: &SetupRequest) -> Result<(), String> {
    for path in [
        request.sandbox_root.as_path(),
        request.workspace_root.as_path(),
        &request.sandbox_root.join("cache"),
        &request.sandbox_root.join("tmp"),
        &request.sandbox_root.join("state"),
        request.node_runtime_root.as_path(),
    ] {
        fs::create_dir_all(path)
            .map_err(|error| format!("failed to create directory '{}': {error}", path.display()))?;
    }

    Ok(())
}

#[cfg(all(target_os = "windows", not(test)))]
fn configure_sandbox_account(request: &SetupRequest) -> Result<(), String> {
    let password = request.sandbox_account_password.as_deref().ok_or_else(|| {
        "Windows sandbox account password is required for account provisioning".to_string()
    })?;
    windows_account::configure_sandbox_account(password)
}

#[cfg(test)]
fn configure_sandbox_account(_request: &SetupRequest) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn configure_sandbox_account(_request: &SetupRequest) -> Result<(), String> {
    Err("Windows sandbox account provisioning is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn verify_sandbox_account() -> Result<(), String> {
    windows_account::verify_sandbox_account()
}

#[cfg(test)]
fn verify_sandbox_account() -> Result<(), String> {
    if matches!(std::env::var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT"), Ok(value) if value == "0") {
        return Err("mock account verification failed".to_string());
    }

    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn verify_sandbox_account() -> Result<(), String> {
    Err("Windows sandbox account verification is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn configure_sandbox_acls(request: &SetupRequest) -> Result<(), String> {
    windows_acl::configure_sandbox_acls(request)
}

#[cfg(test)]
fn configure_sandbox_acls(_request: &SetupRequest) -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn configure_sandbox_acls(_request: &SetupRequest) -> Result<(), String> {
    Err("Windows sandbox ACL provisioning is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn verify_sandbox_acls(request: &SetupRequest) -> Result<(), String> {
    windows_acl::verify_sandbox_acls(request)
}

#[cfg(test)]
fn verify_sandbox_acls(_request: &SetupRequest) -> Result<(), String> {
    if matches!(std::env::var("NCB_SANDBOX_TEST_VERIFY_ACLS"), Ok(value) if value == "0") {
        return Err("mock ACL verification failed".to_string());
    }

    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn verify_sandbox_acls(_request: &SetupRequest) -> Result<(), String> {
    Err("Windows sandbox ACL verification is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn configure_network_filtering() -> Result<(), String> {
    windows_network::configure_network_filtering()
}

#[cfg(test)]
fn configure_network_filtering() -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn configure_network_filtering() -> Result<(), String> {
    Err("Windows sandbox network filtering is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn verify_network_filtering() -> Result<(), String> {
    windows_network::verify_network_filtering()
}

#[cfg(test)]
fn verify_network_filtering() -> Result<(), String> {
    if matches!(std::env::var("NCB_SANDBOX_TEST_VERIFY_NETWORK"), Ok(value) if value == "0") {
        return Err("mock network verification failed".to_string());
    }

    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn verify_network_filtering() -> Result<(), String> {
    Err("Windows sandbox network filtering verification is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn remove_network_filtering() -> Result<(), String> {
    windows_network::remove_network_filtering()
}

#[cfg(test)]
fn remove_network_filtering() -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn remove_network_filtering() -> Result<(), String> {
    Err("Windows sandbox network filtering removal is only supported on Windows".to_string())
}

#[cfg(all(target_os = "windows", not(test)))]
fn remove_sandbox_account() -> Result<(), String> {
    windows_account::remove_sandbox_account()
}

#[cfg(test)]
fn remove_sandbox_account() -> Result<(), String> {
    Ok(())
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn remove_sandbox_account() -> Result<(), String> {
    Err("Windows sandbox account removal is only supported on Windows".to_string())
}

fn progress_marker_path(request: &SetupRequest) -> PathBuf {
    request.sandbox_root.join("state").join(SETUP_PROGRESS_FILE)
}

fn read_progress_marker(path: &Path) -> Result<SetupProgressMarker, String> {
    let content = fs::read(path).map_err(|error| {
        format!(
            "failed to read Windows sandbox setup progress marker '{}': {error}",
            path.display()
        )
    })?;
    serde_json::from_slice::<SetupProgressMarker>(&content).map_err(|error| {
        format!(
            "failed to parse Windows sandbox setup progress marker '{}': {error}",
            path.display()
        )
    })
}

fn write_progress_marker(path: &Path, marker: &SetupProgressMarker) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("failed to serialize setup progress marker: {error}"))?;
    write_file_atomically(path, &content, "setup progress marker")
}

fn write_file_atomically(path: &Path, content: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid {label} path"))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create {label} directory '{}': {error}",
            parent.display()
        )
    })?;
    let temp_path = path.with_extension("tmp");

    fs::write(&temp_path, content)
        .map_err(|error| format!("failed to write {label} '{}': {error}", temp_path.display()))?;

    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("failed to replace {label} '{}': {error}", path.display()))?;
    }

    fs::rename(&temp_path, path)
        .map_err(|error| format!("failed to finalize {label} '{}': {error}", path.display()))?;

    Ok(())
}

fn validate_marker_matches_request(
    request: &SetupRequest,
    marker: &SetupProgressMarker,
) -> Result<(), String> {
    if marker.schema_version != SETUP_SCHEMA_VERSION {
        return Err(format!(
            "Windows sandbox setup progress marker uses unsupported schema version {}",
            marker.schema_version
        ));
    }

    if marker.policy_version != request.policy_version {
        return Err(format!(
            "Windows sandbox setup progress marker policy version {} does not match app policy version {}",
            marker.policy_version, request.policy_version
        ));
    }

    if marker.sandbox_root != request.sandbox_root
        || marker.node_runtime_root != request.node_runtime_root
        || marker.workspace_root != request.workspace_root
    {
        return Err(
            "Windows sandbox setup progress marker paths do not match this app instance"
                .to_string(),
        );
    }

    Ok(())
}

fn setup_required_response(request: &SetupRequest, message: impl Into<String>) -> SetupResponse {
    SetupResponse {
        ok: false,
        state: "setup-required",
        message: message.into(),
        policy_version: request.policy_version,
    }
}

fn repair_required_response(request: &SetupRequest, message: impl Into<String>) -> SetupResponse {
    SetupResponse {
        ok: false,
        state: "repair-required",
        message: message.into(),
        policy_version: request.policy_version,
    }
}

fn incomplete_setup_message(marker: &SetupProgressMarker) -> &'static str {
    if !marker.directories_provisioned {
        return "Windows sandbox directories are not provisioned.";
    }

    if !marker.account_configured {
        return "Windows sandbox directories are provisioned, but the low-privilege account, ACLs, and network filtering are not complete.";
    }

    if !marker.acls_configured && !marker.network_filtering_configured {
        return "Windows sandbox account is provisioned, but ACLs and network filtering are not complete.";
    }

    if !marker.acls_configured {
        return "Windows sandbox account is provisioned, but ACLs are not complete.";
    }

    "Windows sandbox account and ACLs are provisioned, but network filtering is not complete."
}

fn require_elevated_setup_token() -> Result<(), String> {
    if is_process_elevated()? {
        return Ok(());
    }

    Err(
        "Windows sandbox setup must be run elevated before it can create or repair sandbox-owned system resources."
            .to_string(),
    )
}

#[cfg(target_os = "windows")]
fn is_process_elevated() -> Result<bool, String> {
    use std::{mem::size_of, ptr::null_mut};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    #[cfg(test)]
    if let Some(override_value) = test_elevation_override() {
        return Ok(override_value);
    }

    let mut token: HANDLE = null_mut();
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };

    if opened == 0 {
        return Err(format!(
            "failed to open current process token: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0u32;
    let queried = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    unsafe {
        CloseHandle(token);
    }

    if queried == 0 {
        return Err(format!(
            "failed to read process elevation token: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(elevation.TokenIsElevated != 0)
}

#[cfg(not(target_os = "windows"))]
fn is_process_elevated() -> Result<bool, String> {
    #[cfg(test)]
    if let Some(override_value) = test_elevation_override() {
        return Ok(override_value);
    }

    Ok(true)
}

#[cfg(all(target_os = "windows", not(test)))]
mod windows_account {
    use std::collections::BTreeSet;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::{
        Foundation::{
            GetLastError, ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_MEMBER_IN_ALIAS,
            STATUS_OBJECT_NAME_NOT_FOUND,
        },
        NetworkManagement::NetManagement::{
            NERR_GroupExists, NERR_GroupNotFound, NERR_Success, NERR_UserExists, NERR_UserNotFound,
            NetApiBufferFree, NetLocalGroupAdd, NetLocalGroupAddMembers, NetLocalGroupDel,
            NetLocalGroupGetInfo, NetUserAdd, NetUserDel, NetUserGetInfo, NetUserGetLocalGroups,
            NetUserSetInfo, LOCALGROUP_INFO_1, LOCALGROUP_MEMBERS_INFO_3, LOCALGROUP_USERS_INFO_0,
            MAX_PREFERRED_LENGTH, UF_ACCOUNTDISABLE, UF_DONT_EXPIRE_PASSWD, UF_PASSWD_NOTREQD,
            UF_SCRIPT, USER_INFO_1, USER_INFO_1003, USER_INFO_1008, USER_PRIV_USER,
        },
        Security::{
            Authentication::Identity::{
                LsaAddAccountRights, LsaClose, LsaEnumerateAccountRights, LsaFreeMemory,
                LsaNtStatusToWinError, LsaOpenPolicy, LsaRemoveAccountRights, LSA_HANDLE,
                LSA_OBJECT_ATTRIBUTES, LSA_UNICODE_STRING, POLICY_CREATE_ACCOUNT,
                POLICY_LOOKUP_NAMES, POLICY_VIEW_LOCAL_INFORMATION,
            },
            LookupAccountNameW, PSID, SID_NAME_USE,
        },
        System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY,
            HKEY_LOCAL_MACHINE, KEY_SET_VALUE, REG_DWORD, REG_OPTION_NON_VOLATILE,
        },
    };

    use super::{
        SANDBOX_ACCOUNT_DESCRIPTION, SANDBOX_ACCOUNT_NAME, SANDBOX_GROUP_DESCRIPTION,
        SANDBOX_GROUP_NAME,
    };

    const REQUIRED_ACCOUNT_RIGHTS: [&str; 4] = [
        "SeBatchLogonRight",
        "SeDenyInteractiveLogonRight",
        "SeDenyRemoteInteractiveLogonRight",
        "SeDenyNetworkLogonRight",
    ];
    const FORBIDDEN_ACCOUNT_RIGHTS: [&str; 1] = ["SeDenyBatchLogonRight"];
    const MANAGED_ACCOUNT_RIGHTS: [&str; 5] = [
        "SeBatchLogonRight",
        "SeDenyInteractiveLogonRight",
        "SeDenyRemoteInteractiveLogonRight",
        "SeDenyNetworkLogonRight",
        "SeDenyBatchLogonRight",
    ];

    pub fn configure_sandbox_account(password: &str) -> Result<(), String> {
        ensure_local_group()?;
        ensure_launchable_local_user(password)?;
        ensure_group_membership()?;
        ensure_account_logon_rights()?;
        hide_account_from_logon_ui()?;
        Ok(())
    }

    pub fn verify_sandbox_account() -> Result<(), String> {
        verify_local_group()?;
        verify_launchable_local_user()?;
        verify_group_membership()?;
        verify_account_logon_rights()
    }

    pub fn remove_sandbox_account() -> Result<(), String> {
        if local_user_exists()? {
            remove_account_logon_rights()?;
        }
        delete_local_user()?;
        delete_local_group()?;
        remove_account_from_logon_ui_list()
    }

    fn verify_local_group() -> Result<(), String> {
        let group_name = wide_null(SANDBOX_GROUP_NAME);
        let mut buffer = std::ptr::null_mut::<u8>();
        let status =
            unsafe { NetLocalGroupGetInfo(std::ptr::null(), group_name.as_ptr(), 1, &mut buffer) };

        if status == NERR_Success {
            unsafe {
                NetApiBufferFree(buffer.cast());
            }
            Ok(())
        } else {
            Err(format!(
                "Windows sandbox local group '{SANDBOX_GROUP_NAME}' is missing or unreadable (status {status})"
            ))
        }
    }

    fn verify_launchable_local_user() -> Result<(), String> {
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut buffer = std::ptr::null_mut::<u8>();
        let status =
            unsafe { NetUserGetInfo(std::ptr::null(), account_name.as_ptr(), 1, &mut buffer) };

        if status != NERR_Success {
            return Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' is missing or unreadable (status {status})"
            ));
        }

        let user = unsafe { *(buffer as *const USER_INFO_1) };
        unsafe {
            NetApiBufferFree(buffer.cast());
        }

        if user.usri1_flags & UF_ACCOUNTDISABLE != 0 {
            return Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' is disabled"
            ));
        }

        if user.usri1_flags & UF_PASSWD_NOTREQD != 0 {
            return Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' does not require a password"
            ));
        }

        Ok(())
    }

    fn local_user_exists() -> Result<bool, String> {
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut buffer = std::ptr::null_mut::<u8>();
        let status =
            unsafe { NetUserGetInfo(std::ptr::null(), account_name.as_ptr(), 1, &mut buffer) };

        if status == NERR_Success {
            unsafe {
                NetApiBufferFree(buffer.cast());
            }
            Ok(true)
        } else if status == NERR_UserNotFound {
            Ok(false)
        } else {
            Err(format!(
                "failed to inspect Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' before removal (status {status})"
            ))
        }
    }

    fn verify_group_membership() -> Result<(), String> {
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut buffer = std::ptr::null_mut::<u8>();
        let mut entries_read = 0u32;
        let mut total_entries = 0u32;
        let status = unsafe {
            NetUserGetLocalGroups(
                std::ptr::null(),
                account_name.as_ptr(),
                0,
                0,
                &mut buffer,
                MAX_PREFERRED_LENGTH,
                &mut entries_read,
                &mut total_entries,
            )
        };

        if status != NERR_Success {
            return Err(format!(
                "failed to enumerate Windows sandbox account local groups (status {status})"
            ));
        }

        let groups = unsafe {
            std::slice::from_raw_parts(
                buffer as *const LOCALGROUP_USERS_INFO_0,
                entries_read as usize,
            )
        };
        let found = groups.iter().any(|group| {
            wide_ptr_to_string(group.lgrui0_name)
                .is_some_and(|name| name.eq_ignore_ascii_case(SANDBOX_GROUP_NAME))
        });
        unsafe {
            NetApiBufferFree(buffer.cast());
        }

        if found {
            Ok(())
        } else {
            Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' is not a member of '{SANDBOX_GROUP_NAME}'"
            ))
        }
    }

    fn ensure_local_group() -> Result<(), String> {
        let group_name = wide_null(SANDBOX_GROUP_NAME);
        let group_comment = wide_null(SANDBOX_GROUP_DESCRIPTION);
        let mut buffer = std::ptr::null_mut::<u8>();
        let existing =
            unsafe { NetLocalGroupGetInfo(std::ptr::null(), group_name.as_ptr(), 1, &mut buffer) };

        if existing == NERR_Success {
            unsafe {
                NetApiBufferFree(buffer.cast());
            }
            return Ok(());
        }

        let info = LOCALGROUP_INFO_1 {
            lgrpi1_name: group_name.as_ptr() as *mut _,
            lgrpi1_comment: group_comment.as_ptr() as *mut _,
        };
        let mut parameter_error = 0u32;
        let status = unsafe {
            NetLocalGroupAdd(
                std::ptr::null(),
                1,
                &info as *const _ as *const u8,
                &mut parameter_error,
            )
        };

        if status == NERR_Success || status == NERR_GroupExists {
            Ok(())
        } else {
            Err(format!(
                "failed to create Windows sandbox local group '{SANDBOX_GROUP_NAME}' (status {status}, parameter {parameter_error})"
            ))
        }
    }

    fn ensure_launchable_local_user(password: &str) -> Result<(), String> {
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut buffer = std::ptr::null_mut::<u8>();
        let existing =
            unsafe { NetUserGetInfo(std::ptr::null(), account_name.as_ptr(), 1, &mut buffer) };

        if existing == NERR_Success {
            unsafe {
                NetApiBufferFree(buffer.cast());
            }
            set_user_password(&account_name, password)?;
            return set_launchable_user_flags(&account_name);
        }

        let password_wide = wide_null(password);
        let account_comment = wide_null(SANDBOX_ACCOUNT_DESCRIPTION);
        let flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD;
        let info = USER_INFO_1 {
            usri1_name: account_name.as_ptr() as *mut _,
            usri1_password: password_wide.as_ptr() as *mut _,
            usri1_password_age: 0,
            usri1_priv: USER_PRIV_USER,
            usri1_home_dir: std::ptr::null_mut(),
            usri1_comment: account_comment.as_ptr() as *mut _,
            usri1_flags: flags,
            usri1_script_path: std::ptr::null_mut(),
        };
        let mut parameter_error = 0u32;
        let status = unsafe {
            NetUserAdd(
                std::ptr::null(),
                1,
                &info as *const _ as *const u8,
                &mut parameter_error,
            )
        };

        if status == NERR_Success {
            set_launchable_user_flags(&account_name)?;
            Ok(())
        } else if status == NERR_UserExists {
            set_user_password(&account_name, password)?;
            set_launchable_user_flags(&account_name)?;
            Ok(())
        } else {
            Err(format!(
                "failed to create Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' (status {status}, parameter {parameter_error})"
            ))
        }
    }

    fn set_user_password(account_name: &[u16], password: &str) -> Result<(), String> {
        let password = wide_null(password);
        let info = USER_INFO_1003 {
            usri1003_password: password.as_ptr() as *mut _,
        };
        let mut parameter_error = 0u32;
        let status = unsafe {
            NetUserSetInfo(
                std::ptr::null(),
                account_name.as_ptr(),
                1003,
                &info as *const _ as *const u8,
                &mut parameter_error,
            )
        };

        if status == NERR_Success {
            Ok(())
        } else {
            Err(format!(
                "failed to update password for Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' (status {status}, parameter {parameter_error})"
            ))
        }
    }

    fn set_launchable_user_flags(account_name: &[u16]) -> Result<(), String> {
        let flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD;
        let info = USER_INFO_1008 {
            usri1008_flags: flags,
        };
        let mut parameter_error = 0u32;
        let status = unsafe {
            NetUserSetInfo(
                std::ptr::null(),
                account_name.as_ptr(),
                1008,
                &info as *const _ as *const u8,
                &mut parameter_error,
            )
        };

        if status == NERR_Success {
            Ok(())
        } else {
            Err(format!(
                "failed to enforce launchable flags on Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' (status {status}, parameter {parameter_error})"
            ))
        }
    }

    fn ensure_group_membership() -> Result<(), String> {
        let group_name = wide_null(SANDBOX_GROUP_NAME);
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let member = LOCALGROUP_MEMBERS_INFO_3 {
            lgrmi3_domainandname: account_name.as_ptr() as *mut _,
        };
        let status = unsafe {
            NetLocalGroupAddMembers(
                std::ptr::null(),
                group_name.as_ptr(),
                3,
                &member as *const _ as *const u8,
                1,
            )
        };

        if status == NERR_Success || status == ERROR_MEMBER_IN_ALIAS {
            Ok(())
        } else {
            Err(format!(
                "failed to add Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' to local group '{SANDBOX_GROUP_NAME}' (status {status})"
            ))
        }
    }

    fn delete_local_user() -> Result<(), String> {
        let account_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let status = unsafe { NetUserDel(std::ptr::null(), account_name.as_ptr()) };

        if status == NERR_Success || status == NERR_UserNotFound {
            Ok(())
        } else {
            Err(format!(
                "failed to remove Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' (status {status})"
            ))
        }
    }

    fn delete_local_group() -> Result<(), String> {
        let group_name = wide_null(SANDBOX_GROUP_NAME);
        let status = unsafe { NetLocalGroupDel(std::ptr::null(), group_name.as_ptr()) };

        if status == NERR_Success || status == NERR_GroupNotFound {
            Ok(())
        } else {
            Err(format!(
                "failed to remove Windows sandbox local group '{SANDBOX_GROUP_NAME}' (status {status})"
            ))
        }
    }

    fn hide_account_from_logon_ui() -> Result<(), String> {
        let key_path = wide_null(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList",
        );
        let value_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut key: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                key_path.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };

        if status != 0 {
            return Err(format!(
                "failed to open Windows logon account visibility registry key for sandbox account (status {status})"
            ));
        }

        let hidden = 0u32;
        let set_status = unsafe {
            RegSetValueExW(
                key,
                value_name.as_ptr(),
                0,
                REG_DWORD,
                &hidden as *const _ as *const u8,
                std::mem::size_of::<u32>() as u32,
            )
        };
        unsafe {
            RegCloseKey(key);
        }

        if set_status == 0 {
            Ok(())
        } else {
            Err(format!(
                "failed to hide Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' from logon UI (status {set_status})"
            ))
        }
    }

    fn remove_account_from_logon_ui_list() -> Result<(), String> {
        let key_path = wide_null(
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList",
        );
        let value_name = wide_null(SANDBOX_ACCOUNT_NAME);
        let mut key: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                key_path.as_ptr(),
                0,
                std::ptr::null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };

        if status != 0 {
            return Err(format!(
                "failed to open Windows logon account visibility registry key for sandbox account cleanup (status {status})"
            ));
        }

        let delete_status = unsafe { RegDeleteValueW(key, value_name.as_ptr()) };
        unsafe {
            RegCloseKey(key);
        }

        if delete_status == 0 || delete_status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(format!(
                "failed to remove Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' from logon UI visibility list (status {delete_status})"
            ))
        }
    }

    fn ensure_account_logon_rights() -> Result<(), String> {
        let mut sid = lookup_account_sid_bytes(SANDBOX_ACCOUNT_NAME)?;
        let policy = LsaPolicy::open(
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES | POLICY_VIEW_LOCAL_INFORMATION) as u32,
        )?;
        let required_rights = LsaRightStrings::new(&REQUIRED_ACCOUNT_RIGHTS)?;
        let add_status = unsafe {
            LsaAddAccountRights(
                policy.handle,
                sid.as_mut_ptr() as PSID,
                required_rights.values.as_ptr(),
                required_rights.values.len() as u32,
            )
        };
        lsa_status(
            add_status,
            "failed to grant Windows sandbox account logon rights",
        )?;

        let forbidden_rights = LsaRightStrings::new(&FORBIDDEN_ACCOUNT_RIGHTS)?;
        let remove_status = unsafe {
            LsaRemoveAccountRights(
                policy.handle,
                sid.as_mut_ptr() as PSID,
                0,
                forbidden_rights.values.as_ptr(),
                forbidden_rights.values.len() as u32,
            )
        };
        lsa_status_allow_missing(
            remove_status,
            "failed to remove conflicting Windows sandbox account logon rights",
        )
    }

    fn remove_account_logon_rights() -> Result<(), String> {
        let mut sid = lookup_account_sid_bytes(SANDBOX_ACCOUNT_NAME)?;
        let policy = LsaPolicy::open(
            (POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES | POLICY_VIEW_LOCAL_INFORMATION) as u32,
        )?;
        let managed_rights = LsaRightStrings::new(&MANAGED_ACCOUNT_RIGHTS)?;
        let remove_status = unsafe {
            LsaRemoveAccountRights(
                policy.handle,
                sid.as_mut_ptr() as PSID,
                0,
                managed_rights.values.as_ptr(),
                managed_rights.values.len() as u32,
            )
        };
        lsa_status_allow_missing(
            remove_status,
            "failed to remove Windows sandbox account logon rights",
        )
    }

    fn verify_account_logon_rights() -> Result<(), String> {
        let mut sid = lookup_account_sid_bytes(SANDBOX_ACCOUNT_NAME)?;
        let policy = LsaPolicy::open(POLICY_VIEW_LOCAL_INFORMATION as u32)?;
        let rights = enumerate_account_rights(policy.handle, sid.as_mut_ptr() as PSID)?;

        let missing = REQUIRED_ACCOUNT_RIGHTS
            .iter()
            .find(|right| !rights.contains(**right));
        if let Some(right) = missing {
            return Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' is missing required logon right '{right}'"
            ));
        }

        let forbidden = FORBIDDEN_ACCOUNT_RIGHTS
            .iter()
            .find(|right| rights.contains(**right));
        if let Some(right) = forbidden {
            return Err(format!(
                "Windows sandbox account '{SANDBOX_ACCOUNT_NAME}' has conflicting logon right '{right}'"
            ));
        }

        Ok(())
    }

    struct LsaPolicy {
        handle: LSA_HANDLE,
    }

    impl LsaPolicy {
        fn open(desired_access: u32) -> Result<Self, String> {
            let attributes = LSA_OBJECT_ATTRIBUTES {
                Length: std::mem::size_of::<LSA_OBJECT_ATTRIBUTES>() as u32,
                RootDirectory: std::ptr::null_mut(),
                ObjectName: std::ptr::null_mut(),
                Attributes: 0,
                SecurityDescriptor: std::ptr::null_mut(),
                SecurityQualityOfService: std::ptr::null_mut(),
            };
            let mut handle: LSA_HANDLE = 0;
            let status = unsafe {
                LsaOpenPolicy(std::ptr::null(), &attributes, desired_access, &mut handle)
            };
            lsa_status(status, "failed to open Windows local security policy")?;
            Ok(Self { handle })
        }
    }

    impl Drop for LsaPolicy {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe {
                    LsaClose(self.handle);
                }
            }
        }
    }

    struct LsaRightStrings {
        _buffers: Vec<Vec<u16>>,
        values: Vec<LSA_UNICODE_STRING>,
    }

    impl LsaRightStrings {
        fn new(rights: &[&str]) -> Result<Self, String> {
            let mut buffers = Vec::with_capacity(rights.len());
            let mut values = Vec::with_capacity(rights.len());

            for right in rights {
                let mut buffer: Vec<u16> = std::ffi::OsStr::new(right).encode_wide().collect();
                let length = u16::try_from(buffer.len() * 2)
                    .map_err(|_| format!("Windows sandbox account right '{right}' is too long"))?;
                let maximum_length = length.checked_add(2).ok_or_else(|| {
                    format!("Windows sandbox account right '{right}' is too long")
                })?;
                values.push(LSA_UNICODE_STRING {
                    Length: length,
                    MaximumLength: maximum_length,
                    Buffer: buffer.as_mut_ptr(),
                });
                buffers.push(buffer);
            }

            Ok(Self {
                _buffers: buffers,
                values,
            })
        }
    }

    fn enumerate_account_rights(
        policy: LSA_HANDLE,
        account_sid: PSID,
    ) -> Result<BTreeSet<String>, String> {
        let mut rights_ptr = std::ptr::null_mut::<LSA_UNICODE_STRING>();
        let mut rights_count = 0u32;
        let status = unsafe {
            LsaEnumerateAccountRights(policy, account_sid, &mut rights_ptr, &mut rights_count)
        };

        if status == STATUS_OBJECT_NAME_NOT_FOUND {
            return Ok(BTreeSet::new());
        }
        lsa_status(
            status,
            "failed to enumerate Windows sandbox account logon rights",
        )?;

        let mut rights = BTreeSet::new();
        if !rights_ptr.is_null() && rights_count > 0 {
            let values = unsafe { std::slice::from_raw_parts(rights_ptr, rights_count as usize) };
            for value in values {
                rights.insert(lsa_unicode_string_to_string(value));
            }
        }
        if !rights_ptr.is_null() {
            unsafe {
                LsaFreeMemory(rights_ptr.cast());
            }
        }
        Ok(rights)
    }

    fn lookup_account_sid_bytes(account_name: &str) -> Result<Vec<u8>, String> {
        let account_name = wide_null(account_name);
        let mut sid_size = 0u32;
        let mut domain_size = 0u32;
        let mut sid_name_use: SID_NAME_USE = 0;
        let first = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account_name.as_ptr(),
                std::ptr::null_mut(),
                &mut sid_size,
                std::ptr::null_mut(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "failed to size Windows sandbox account SID lookup: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut sid = vec![0u8; sid_size as usize];
        let mut domain = vec![0u16; domain_size as usize];
        let looked_up = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account_name.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if looked_up == 0 {
            return Err(format!(
                "failed to resolve Windows sandbox account SID: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(sid)
    }

    fn lsa_unicode_string_to_string(value: &LSA_UNICODE_STRING) -> String {
        if value.Buffer.is_null() || value.Length == 0 {
            return String::new();
        }

        String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(value.Buffer, value.Length as usize / 2)
        })
    }

    fn lsa_status(status: i32, label: &str) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            let win_error = unsafe { LsaNtStatusToWinError(status) };
            Err(format!(
                "{label}: {}",
                std::io::Error::from_raw_os_error(win_error as i32)
            ))
        }
    }

    fn lsa_status_allow_missing(status: i32, label: &str) -> Result<(), String> {
        if status == STATUS_OBJECT_NAME_NOT_FOUND {
            Ok(())
        } else {
            lsa_status(status, label)
        }
    }

    fn wide_null(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain([0])
            .collect()
    }

    fn wide_ptr_to_string(value: *const u16) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
        }

        Some(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(value, len)
        }))
    }
}

#[cfg(all(target_os = "windows", not(test)))]
mod windows_acl {
    use std::{
        os::windows::{ffi::OsStrExt, fs::MetadataExt},
        path::Path,
    };

    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER},
        Security::{
            Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
                ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
                SetNamedSecurityInfoW, SE_FILE_OBJECT,
            },
            GetSecurityDescriptorControl, GetSecurityDescriptorDacl, LookupAccountNameW,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
            PSID, SE_DACL_PROTECTED, SID_NAME_USE,
        },
    };

    use super::{SetupRequest, SANDBOX_GROUP_NAME};

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
    const FILE_READ_EXECUTE: &str = "0x1200a9";
    const FILE_MODIFY: &str = "0x1301bf";

    pub fn configure_sandbox_acls(request: &SetupRequest) -> Result<(), String> {
        let current_user_sid = request.launcher_user_sid.as_deref().ok_or_else(|| {
            "Windows sandbox setup request is missing the launching app user SID for ACL provisioning".to_string()
        })?;
        let sandbox_group_sid = lookup_account_sid_string(SANDBOX_GROUP_NAME)?;
        let host_only_acl = sddl_for(None, current_user_sid, &sandbox_group_sid);
        let sandbox_traverse_acl = sddl_for(
            Some(FILE_READ_EXECUTE),
            current_user_sid,
            &sandbox_group_sid,
        );
        let sandbox_read_execute_acl = sddl_for(
            Some(FILE_READ_EXECUTE),
            current_user_sid,
            &sandbox_group_sid,
        );
        let sandbox_modify_acl = sddl_for(Some(FILE_MODIFY), current_user_sid, &sandbox_group_sid);
        let cache_root = request.sandbox_root.join("cache");
        let tmp_root = request.sandbox_root.join("tmp");

        set_path_acl(&request.sandbox_root, &sandbox_traverse_acl)?;
        apply_acl_tree(&request.sandbox_root.join("state"), &host_only_acl)?;
        apply_acl_tree(&request.node_runtime_root, &sandbox_read_execute_acl)?;

        for path in [request.workspace_root.as_path(), &cache_root, &tmp_root] {
            apply_acl_tree(path, &sandbox_modify_acl)?;
        }

        Ok(())
    }

    pub fn verify_sandbox_acls(request: &SetupRequest) -> Result<(), String> {
        let current_user_sid = request.launcher_user_sid.as_deref().ok_or_else(|| {
            "Windows sandbox setup request is missing the launching app user SID for ACL verification".to_string()
        })?;
        let sandbox_group_sid = lookup_account_sid_string(SANDBOX_GROUP_NAME)?;
        let cache_root = request.sandbox_root.join("cache");
        let tmp_root = request.sandbox_root.join("tmp");

        verify_path_acl(
            &request.sandbox_root,
            current_user_sid,
            &sandbox_group_sid,
            true,
        )?;
        verify_path_acl(
            &request.sandbox_root.join("state"),
            current_user_sid,
            &sandbox_group_sid,
            false,
        )?;
        verify_path_acl(
            &request.node_runtime_root,
            current_user_sid,
            &sandbox_group_sid,
            true,
        )?;

        for path in [request.workspace_root.as_path(), &cache_root, &tmp_root] {
            verify_path_acl(path, current_user_sid, &sandbox_group_sid, true)?;
        }

        Ok(())
    }

    fn sddl_for(
        sandbox_rights: Option<&str>,
        current_user_sid: &str,
        sandbox_group_sid: &str,
    ) -> String {
        let mut sddl =
            format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{current_user_sid})");

        if let Some(rights) = sandbox_rights {
            sddl.push_str(&format!("(A;OICI;{rights};;;{sandbox_group_sid})"));
        }

        sddl
    }

    fn apply_acl_tree(path: &Path, sddl: &str) -> Result<(), String> {
        reject_reparse_point(path)?;
        set_path_acl(path, sddl)?;

        if path.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|error| {
                format!("failed to list ACL target '{}': {error}", path.display())
            })? {
                let entry = entry.map_err(|error| {
                    format!(
                        "failed to read ACL target entry under '{}': {error}",
                        path.display()
                    )
                })?;
                apply_acl_tree(&entry.path(), sddl)?;
            }
        }

        Ok(())
    }

    fn verify_path_acl(
        path: &Path,
        current_user_sid: &str,
        sandbox_group_sid: &str,
        sandbox_group_expected: bool,
    ) -> Result<(), String> {
        reject_reparse_point(path)?;
        let security_descriptor = read_security_descriptor(path)?;
        let control = security_descriptor.control(path)?;

        if control & SE_DACL_PROTECTED == 0 {
            return Err(format!(
                "Windows sandbox ACL on '{}' is not protected",
                path.display()
            ));
        }

        let sddl = security_descriptor.to_sddl(path)?;

        if !sddl.contains(current_user_sid) {
            return Err(format!(
                "Windows sandbox ACL on '{}' does not include the launching app user SID",
                path.display()
            ));
        }

        match sandbox_group_expected {
            true if !sddl.contains(sandbox_group_sid) => Err(format!(
                "Windows sandbox ACL on '{}' does not include the sandbox group SID",
                path.display()
            )),
            false if sddl.contains(sandbox_group_sid) => Err(format!(
                "Windows sandbox ACL on '{}' unexpectedly includes the sandbox group SID",
                path.display()
            )),
            true | false => Ok(()),
        }
    }

    fn reject_reparse_point(path: &Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            format!("failed to inspect ACL target '{}': {error}", path.display())
        })?;

        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "refusing to configure ACLs through reparse point '{}'",
                path.display()
            ));
        }

        Ok(())
    }

    fn set_path_acl(path: &Path, sddl: &str) -> Result<(), String> {
        reject_reparse_point(path)?;
        let path_wide = wide_path(path);
        let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let sddl_wide = wide_null(sddl);
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SECURITY_DESCRIPTOR_REVISION,
                &mut security_descriptor,
                std::ptr::null_mut(),
            )
        };

        if converted == 0 {
            return Err(format!(
                "failed to build Windows sandbox ACL for '{}': {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }

        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        let got_dacl = unsafe {
            GetSecurityDescriptorDacl(
                security_descriptor,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
        };

        if got_dacl == 0 || dacl_present == 0 || dacl.is_null() {
            unsafe {
                LocalFree(security_descriptor.cast());
            }
            return Err(format!(
                "failed to extract Windows sandbox ACL for '{}': {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }

        let status = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_ptr() as *mut _,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        unsafe {
            LocalFree(security_descriptor.cast());
        }

        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "failed to set Windows sandbox ACL on '{}' (status {status})",
                path.display()
            ))
        }
    }

    struct OwnedSecurityDescriptor {
        ptr: PSECURITY_DESCRIPTOR,
    }

    impl OwnedSecurityDescriptor {
        fn control(&self, path: &Path) -> Result<u16, String> {
            let mut control = 0u16;
            let mut revision = 0u32;
            let ok = unsafe { GetSecurityDescriptorControl(self.ptr, &mut control, &mut revision) };

            if ok == 0 {
                Err(format!(
                    "failed to inspect Windows sandbox ACL control bits on '{}': {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ))
            } else {
                Ok(control)
            }
        }

        fn to_sddl(&self, path: &Path) -> Result<String, String> {
            let mut value = std::ptr::null_mut();
            let converted = unsafe {
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    self.ptr,
                    SECURITY_DESCRIPTOR_REVISION,
                    DACL_SECURITY_INFORMATION,
                    &mut value,
                    std::ptr::null_mut(),
                )
            };

            if converted == 0 {
                return Err(format!(
                    "failed to stringify Windows sandbox ACL on '{}': {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }

            let result = wide_ptr_to_string(value)
                .ok_or_else(|| format!("Windows sandbox ACL on '{}' is invalid", path.display()));
            unsafe {
                LocalFree(value.cast());
            }
            result
        }
    }

    impl Drop for OwnedSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.ptr.cast());
            }
        }
    }

    fn read_security_descriptor(path: &Path) -> Result<OwnedSecurityDescriptor, String> {
        let path_wide = wide_path(path);
        let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(
                path_wide.as_ptr() as *mut _,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut security_descriptor,
            )
        };

        if status != 0 || security_descriptor.is_null() {
            Err(format!(
                "failed to read Windows sandbox ACL on '{}' (status {status})",
                path.display()
            ))
        } else {
            Ok(OwnedSecurityDescriptor {
                ptr: security_descriptor,
            })
        }
    }

    fn lookup_account_sid_string(account_name: &str) -> Result<String, String> {
        let account_name = wide_null(account_name);
        let mut sid_size = 0u32;
        let mut domain_size = 0u32;
        let mut sid_name_use: SID_NAME_USE = 0;
        let first = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account_name.as_ptr(),
                std::ptr::null_mut(),
                &mut sid_size,
                std::ptr::null_mut(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "failed to size Windows sandbox group SID lookup: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut sid = vec![0u8; sid_size as usize];
        let mut domain = vec![0u16; domain_size as usize];
        let looked_up = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account_name.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if looked_up == 0 {
            return Err(format!(
                "failed to resolve Windows sandbox group SID: {}",
                std::io::Error::last_os_error()
            ));
        }

        sid_to_string(sid.as_mut_ptr() as PSID)
    }

    fn sid_to_string(sid: PSID) -> Result<String, String> {
        let mut string_sid = std::ptr::null_mut();
        let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };

        if converted == 0 {
            return Err(format!(
                "failed to convert Windows SID to SDDL string: {}",
                std::io::Error::last_os_error()
            ));
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

        Ok(sid)
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }

    fn wide_null(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain([0])
            .collect()
    }

    fn wide_ptr_to_string(value: *const u16) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
        }

        Some(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(value, len)
        }))
    }
}

#[cfg(all(target_os = "windows", not(test)))]
mod windows_network {
    use std::{
        ffi::OsStr,
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };

    use windows_sys::{
        core::{GUID, PWSTR},
        Win32::{
            Foundation::{
                GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, FWP_E_ALREADY_EXISTS,
                FWP_E_NOT_FOUND, HANDLE,
            },
            NetworkManagement::WindowsFilteringPlatform::{
                FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmFilterDeleteByKey0,
                FwpmFilterGetByKey0, FwpmFreeMemory0, FwpmProviderAdd0, FwpmProviderDeleteByKey0,
                FwpmProviderGetByKey0, FwpmSubLayerAdd0, FwpmSubLayerDeleteByKey0,
                FwpmSubLayerGetByKey0, FWPM_CONDITION_ALE_USER_ID,
                FWPM_CONDITION_IP_REMOTE_ADDRESS, FWPM_DISPLAY_DATA0, FWPM_FILTER0,
                FWPM_FILTER_CONDITION0, FWPM_FILTER_FLAG_PERSISTENT,
                FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6, FWPM_PROVIDER0,
                FWPM_PROVIDER_FLAG_PERSISTENT, FWPM_SESSION0, FWPM_SUBLAYER0,
                FWPM_SUBLAYER_FLAG_PERSISTENT, FWP_ACTION_BLOCK, FWP_ACTION_PERMIT,
                FWP_ACTRL_MATCH_FILTER, FWP_BYTE_BLOB, FWP_MATCH_EQUAL,
                FWP_SECURITY_DESCRIPTOR_TYPE, FWP_UINT64, FWP_V4_ADDR_AND_MASK, FWP_V4_ADDR_MASK,
                FWP_V6_ADDR_AND_MASK, FWP_V6_ADDR_MASK,
            },
            Security::{
                Authorization::{
                    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
                    ConvertStringSecurityDescriptorToSecurityDescriptorW,
                },
                LookupAccountNameW, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
                SID_NAME_USE,
            },
            System::Rpc::RPC_C_AUTHN_WINNT,
        },
    };

    use super::SANDBOX_ACCOUNT_NAME;

    const SECURITY_DESCRIPTOR_REVISION: u32 = 1;
    const PROVIDER_KEY: GUID = GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa001);
    const SUBLAYER_KEY: GUID = GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa002);
    const BLOCK_V4_FILTER_KEY: GUID = GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa003);
    const BLOCK_V6_FILTER_KEY: GUID = GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa004);
    const ALLOW_LOOPBACK_V4_FILTER_KEY: GUID =
        GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa005);
    const ALLOW_LOOPBACK_V6_FILTER_KEY: GUID =
        GUID::from_u128(0x9d0c3c7d_9857_4f1e_91a8_54e78e2aa006);
    const ALLOW_FILTER_WEIGHT: u64 = 0x2000;
    const BLOCK_FILTER_WEIGHT: u64 = 0x1000;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum LoopbackAddress {
        V4,
        V6,
    }

    pub fn configure_network_filtering() -> Result<(), String> {
        let engine = WfpEngine::open()?;
        let sandbox_sid = lookup_account_sid_string(SANDBOX_ACCOUNT_NAME)?;

        ensure_provider(engine.handle())?;
        ensure_sublayer(engine.handle())?;
        replace_loopback_allow_filter(
            engine.handle(),
            ALLOW_LOOPBACK_V4_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            LoopbackAddress::V4,
            "nocodeBuilder sandbox loopback allow IPv4",
            &sandbox_sid,
        )?;
        replace_loopback_allow_filter(
            engine.handle(),
            ALLOW_LOOPBACK_V6_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            LoopbackAddress::V6,
            "nocodeBuilder sandbox loopback allow IPv6",
            &sandbox_sid,
        )?;
        replace_block_filter(
            engine.handle(),
            BLOCK_V4_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            "nocodeBuilder sandbox outbound block IPv4",
            &sandbox_sid,
        )?;
        replace_block_filter(
            engine.handle(),
            BLOCK_V6_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            "nocodeBuilder sandbox outbound block IPv6",
            &sandbox_sid,
        )
    }

    pub fn verify_network_filtering() -> Result<(), String> {
        let engine = WfpEngine::open()?;
        let sandbox_sid = lookup_account_sid_string(SANDBOX_ACCOUNT_NAME)?;

        verify_provider(engine.handle())?;
        verify_sublayer(engine.handle())?;
        verify_loopback_allow_filter(
            engine.handle(),
            ALLOW_LOOPBACK_V4_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            LoopbackAddress::V4,
            "IPv4 loopback",
            &sandbox_sid,
        )?;
        verify_loopback_allow_filter(
            engine.handle(),
            ALLOW_LOOPBACK_V6_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            LoopbackAddress::V6,
            "IPv6 loopback",
            &sandbox_sid,
        )?;
        verify_block_filter(
            engine.handle(),
            BLOCK_V4_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            "IPv4",
            &sandbox_sid,
        )?;
        verify_block_filter(
            engine.handle(),
            BLOCK_V6_FILTER_KEY,
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            "IPv6",
            &sandbox_sid,
        )
    }

    pub fn remove_network_filtering() -> Result<(), String> {
        let engine = WfpEngine::open()?;

        delete_optional(
            unsafe { FwpmFilterDeleteByKey0(engine.handle(), &ALLOW_LOOPBACK_V4_FILTER_KEY) },
            "failed to remove Windows sandbox IPv4 loopback WFP allow filter",
        )?;
        delete_optional(
            unsafe { FwpmFilterDeleteByKey0(engine.handle(), &ALLOW_LOOPBACK_V6_FILTER_KEY) },
            "failed to remove Windows sandbox IPv6 loopback WFP allow filter",
        )?;
        delete_optional(
            unsafe { FwpmFilterDeleteByKey0(engine.handle(), &BLOCK_V4_FILTER_KEY) },
            "failed to remove Windows sandbox IPv4 WFP block filter",
        )?;
        delete_optional(
            unsafe { FwpmFilterDeleteByKey0(engine.handle(), &BLOCK_V6_FILTER_KEY) },
            "failed to remove Windows sandbox IPv6 WFP block filter",
        )?;
        delete_optional(
            unsafe { FwpmSubLayerDeleteByKey0(engine.handle(), &SUBLAYER_KEY) },
            "failed to remove Windows sandbox WFP sublayer",
        )?;
        delete_optional(
            unsafe { FwpmProviderDeleteByKey0(engine.handle(), &PROVIDER_KEY) },
            "failed to remove Windows sandbox WFP provider",
        )
    }

    fn ensure_provider(engine: HANDLE) -> Result<(), String> {
        let mut name = wide_null("nocodeBuilder Sandbox");
        let mut description =
            wide_null("Persistent WFP provider for nocodeBuilder native sandbox rules.");
        let mut provider: FWPM_PROVIDER0 = unsafe { std::mem::zeroed() };
        provider.providerKey = PROVIDER_KEY;
        provider.displayData = display_data(&mut name, &mut description);
        provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;

        let status = unsafe { FwpmProviderAdd0(engine, &provider, null_mut()) };
        accept_exists(status, "failed to create Windows sandbox WFP provider")
    }

    fn ensure_sublayer(engine: HANDLE) -> Result<(), String> {
        let mut provider_key = PROVIDER_KEY;
        let mut name = wide_null("nocodeBuilder Sandbox Policy");
        let mut description =
            wide_null("Persistent WFP sublayer for nocodeBuilder sandbox deny rules.");
        let mut sublayer: FWPM_SUBLAYER0 = unsafe { std::mem::zeroed() };
        sublayer.subLayerKey = SUBLAYER_KEY;
        sublayer.displayData = display_data(&mut name, &mut description);
        sublayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
        sublayer.providerKey = &mut provider_key;
        sublayer.weight = 0x7fff;

        let status = unsafe { FwpmSubLayerAdd0(engine, &sublayer, null_mut()) };
        accept_exists(status, "failed to create Windows sandbox WFP sublayer")
    }

    fn replace_block_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        name: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let delete_status = unsafe { FwpmFilterDeleteByKey0(engine, &filter_key) };
        if delete_status != 0 && delete_status != FWP_E_NOT_FOUND as u32 {
            return Err(wfp_error(
                "failed to replace stale Windows sandbox WFP filter",
                delete_status,
            ));
        }

        add_block_filter(engine, filter_key, layer_key, name, sandbox_sid)
    }

    fn replace_loopback_allow_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        address: LoopbackAddress,
        name: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let delete_status = unsafe { FwpmFilterDeleteByKey0(engine, &filter_key) };
        if delete_status != 0 && delete_status != FWP_E_NOT_FOUND as u32 {
            return Err(wfp_error(
                "failed to replace stale Windows sandbox WFP loopback allow filter",
                delete_status,
            ));
        }

        add_loopback_allow_filter(engine, filter_key, layer_key, address, name, sandbox_sid)
    }

    fn add_loopback_allow_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        address: LoopbackAddress,
        name: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let security_descriptor = user_match_security_descriptor(sandbox_sid)?;
        let mut provider_key = PROVIDER_KEY;
        let mut filter_name = wide_null(name);
        let mut filter_description = wide_null(
            "Allows sandbox traffic only to the trusted local loopback proxy/dev-server surface.",
        );
        let mut user_condition_blob = FWP_BYTE_BLOB {
            size: security_descriptor.size,
            data: security_descriptor.ptr.cast(),
        };
        let user_condition = user_condition(&mut user_condition_blob);
        let mut v4_addr;
        let mut v6_addr;
        let mut weight = ALLOW_FILTER_WEIGHT;
        let mut address_condition: FWPM_FILTER_CONDITION0 = unsafe { std::mem::zeroed() };
        address_condition.fieldKey = FWPM_CONDITION_IP_REMOTE_ADDRESS;
        address_condition.matchType = FWP_MATCH_EQUAL;

        match address {
            LoopbackAddress::V4 => {
                v4_addr = FWP_V4_ADDR_AND_MASK {
                    addr: u32::from_be_bytes([127, 0, 0, 1]),
                    mask: u32::MAX,
                };
                address_condition.conditionValue.r#type = FWP_V4_ADDR_MASK;
                address_condition.conditionValue.Anonymous.v4AddrMask = &mut v4_addr;
            }
            LoopbackAddress::V6 => {
                v6_addr = FWP_V6_ADDR_AND_MASK {
                    addr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
                    prefixLength: 128,
                };
                address_condition.conditionValue.r#type = FWP_V6_ADDR_MASK;
                address_condition.conditionValue.Anonymous.v6AddrMask = &mut v6_addr;
            }
        }

        let mut conditions = [user_condition, address_condition];
        let filter = base_filter(
            filter_key,
            layer_key,
            &mut provider_key,
            &mut filter_name,
            &mut filter_description,
            &mut conditions,
            FWP_ACTION_PERMIT,
            &mut weight,
        );

        let mut filter_id = 0u64;
        let status = unsafe { FwpmFilterAdd0(engine, &filter, null_mut(), &mut filter_id) };
        accept_exists(
            status,
            "failed to create Windows sandbox loopback WFP allow filter",
        )
    }

    fn add_block_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        name: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let security_descriptor = user_match_security_descriptor(sandbox_sid)?;
        let mut provider_key = PROVIDER_KEY;
        let mut filter_name = wide_null(name);
        let mut filter_description =
            wide_null("Blocks outbound public network traffic for the sandbox identity.");
        let mut user_condition_blob = FWP_BYTE_BLOB {
            size: security_descriptor.size,
            data: security_descriptor.ptr.cast(),
        };
        let user_condition = user_condition(&mut user_condition_blob);
        let mut conditions = [user_condition];
        let mut weight = BLOCK_FILTER_WEIGHT;
        let filter = base_filter(
            filter_key,
            layer_key,
            &mut provider_key,
            &mut filter_name,
            &mut filter_description,
            &mut conditions,
            FWP_ACTION_BLOCK,
            &mut weight,
        );

        let mut filter_id = 0u64;
        let status = unsafe { FwpmFilterAdd0(engine, &filter, null_mut(), &mut filter_id) };
        accept_exists(
            status,
            "failed to create Windows sandbox outbound WFP block filter",
        )
    }

    fn base_filter(
        filter_key: GUID,
        layer_key: GUID,
        provider_key: &mut GUID,
        filter_name: &mut [u16],
        filter_description: &mut [u16],
        conditions: &mut [FWPM_FILTER_CONDITION0],
        action: u32,
        weight: &mut u64,
    ) -> FWPM_FILTER0 {
        let mut filter: FWPM_FILTER0 = unsafe { std::mem::zeroed() };
        filter.filterKey = filter_key;
        filter.displayData = display_data(filter_name, filter_description);
        filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
        filter.providerKey = provider_key;
        filter.layerKey = layer_key;
        filter.subLayerKey = SUBLAYER_KEY;
        filter.weight.r#type = FWP_UINT64;
        filter.weight.Anonymous.uint64 = weight;
        filter.numFilterConditions = conditions.len() as u32;
        filter.filterCondition = conditions.as_mut_ptr();
        filter.action.r#type = action;
        filter
    }

    fn user_condition(user_condition_blob: &mut FWP_BYTE_BLOB) -> FWPM_FILTER_CONDITION0 {
        let mut condition: FWPM_FILTER_CONDITION0 = unsafe { std::mem::zeroed() };
        condition.fieldKey = FWPM_CONDITION_ALE_USER_ID;
        condition.matchType = FWP_MATCH_EQUAL;
        condition.conditionValue.r#type = FWP_SECURITY_DESCRIPTOR_TYPE;
        condition.conditionValue.Anonymous.sd = user_condition_blob;
        condition
    }

    fn verify_provider(engine: HANDLE) -> Result<(), String> {
        let mut provider = null_mut();
        let status = unsafe { FwpmProviderGetByKey0(engine, &PROVIDER_KEY, &mut provider) };
        if status != 0 || provider.is_null() {
            return Err(wfp_error(
                "Windows sandbox WFP provider is missing or unreadable",
                status,
            ));
        }

        let _provider = WfpMemory::new(provider);
        Ok(())
    }

    fn verify_sublayer(engine: HANDLE) -> Result<(), String> {
        let mut sublayer = null_mut();
        let status = unsafe { FwpmSubLayerGetByKey0(engine, &SUBLAYER_KEY, &mut sublayer) };
        if status != 0 || sublayer.is_null() {
            return Err(wfp_error(
                "Windows sandbox WFP sublayer is missing or unreadable",
                status,
            ));
        }

        let sublayer_memory = WfpMemory::new(sublayer);
        let sublayer_ref = unsafe { &*sublayer_memory.ptr };
        if sublayer_ref.providerKey.is_null()
            || !same_guid(unsafe { &*sublayer_ref.providerKey }, &PROVIDER_KEY)
        {
            return Err(
                "Windows sandbox WFP sublayer is not owned by the sandbox provider".to_string(),
            );
        }

        Ok(())
    }

    fn verify_loopback_allow_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        address: LoopbackAddress,
        label: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let mut filter = null_mut();
        let status = unsafe { FwpmFilterGetByKey0(engine, &filter_key, &mut filter) };
        if status != 0 || filter.is_null() {
            return Err(wfp_error(
                &format!("Windows sandbox {label} WFP allow filter is missing or unreadable"),
                status,
            ));
        }

        let filter_memory = WfpMemory::new(filter);
        let filter_ref = unsafe { &*filter_memory.ptr };
        verify_filter_header(filter_ref, FWP_ACTION_PERMIT, layer_key, label)?;

        if filter_ref.numFilterConditions != 2 || filter_ref.filterCondition.is_null() {
            return Err(format!(
                "Windows sandbox {label} WFP allow filter must be scoped to the sandbox account and loopback address"
            ));
        }

        let conditions = unsafe {
            std::slice::from_raw_parts(
                filter_ref.filterCondition,
                filter_ref.numFilterConditions as usize,
            )
        };
        let user_condition = conditions
            .iter()
            .find(|condition| same_guid(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID))
            .ok_or_else(|| {
                format!("Windows sandbox {label} WFP allow filter is missing a user condition")
            })?;
        verify_user_condition(user_condition, label, sandbox_sid)?;

        let address_condition = conditions
            .iter()
            .find(|condition| same_guid(&condition.fieldKey, &FWPM_CONDITION_IP_REMOTE_ADDRESS))
            .ok_or_else(|| {
                format!(
                    "Windows sandbox {label} WFP allow filter is missing a remote address condition"
                )
            })?;
        verify_loopback_address_condition(address_condition, address, label)
    }

    fn verify_block_filter(
        engine: HANDLE,
        filter_key: GUID,
        layer_key: GUID,
        label: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        let mut filter = null_mut();
        let status = unsafe { FwpmFilterGetByKey0(engine, &filter_key, &mut filter) };
        if status != 0 || filter.is_null() {
            return Err(wfp_error(
                &format!("Windows sandbox {label} WFP block filter is missing or unreadable"),
                status,
            ));
        }

        let filter_memory = WfpMemory::new(filter);
        let filter_ref = unsafe { &*filter_memory.ptr };
        verify_filter_header(filter_ref, FWP_ACTION_BLOCK, layer_key, label)?;
        if filter_ref.numFilterConditions != 1 || filter_ref.filterCondition.is_null() {
            return Err(format!(
                "Windows sandbox {label} WFP filter must be scoped to the sandbox account"
            ));
        }

        let condition = unsafe { &*filter_ref.filterCondition };
        verify_user_condition(condition, label, sandbox_sid)
    }

    fn verify_filter_header(
        filter: &FWPM_FILTER0,
        expected_action: u32,
        expected_layer: GUID,
        label: &str,
    ) -> Result<(), String> {
        if filter.action.r#type != expected_action {
            return Err(format!(
                "Windows sandbox {label} WFP filter has the wrong action"
            ));
        }
        if !same_guid(&filter.layerKey, &expected_layer) {
            return Err(format!(
                "Windows sandbox {label} WFP filter is on the wrong layer"
            ));
        }
        if !same_guid(&filter.subLayerKey, &SUBLAYER_KEY) {
            return Err(format!(
                "Windows sandbox {label} WFP filter is not in the sandbox sublayer"
            ));
        }

        Ok(())
    }

    fn verify_user_condition(
        condition: &FWPM_FILTER_CONDITION0,
        label: &str,
        sandbox_sid: &str,
    ) -> Result<(), String> {
        if !same_guid(&condition.fieldKey, &FWPM_CONDITION_ALE_USER_ID)
            || condition.matchType != FWP_MATCH_EQUAL
            || condition.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
        {
            return Err(format!(
                "Windows sandbox {label} WFP filter has an unexpected user condition"
            ));
        }

        let condition_blob = unsafe { condition.conditionValue.Anonymous.sd };
        if condition_blob.is_null() || unsafe { (*condition_blob).data.is_null() } {
            return Err(format!(
                "Windows sandbox {label} WFP filter has an invalid user condition descriptor"
            ));
        }

        let condition_sddl = security_descriptor_blob_to_sddl(condition_blob, label)?;
        if !condition_sddl.contains(sandbox_sid) {
            return Err(format!(
                "Windows sandbox {label} WFP filter is not scoped to the sandbox account SID"
            ));
        }

        Ok(())
    }

    fn verify_loopback_address_condition(
        condition: &FWPM_FILTER_CONDITION0,
        expected: LoopbackAddress,
        label: &str,
    ) -> Result<(), String> {
        if !same_guid(&condition.fieldKey, &FWPM_CONDITION_IP_REMOTE_ADDRESS)
            || condition.matchType != FWP_MATCH_EQUAL
        {
            return Err(format!(
                "Windows sandbox {label} WFP allow filter has an unexpected address condition"
            ));
        }

        match expected {
            LoopbackAddress::V4 => {
                if condition.conditionValue.r#type != FWP_V4_ADDR_MASK {
                    return Err(format!(
                        "Windows sandbox {label} WFP allow filter is not scoped to IPv4 loopback"
                    ));
                }

                let value = unsafe { condition.conditionValue.Anonymous.v4AddrMask };
                if value.is_null()
                    || unsafe {
                        (*value).addr != u32::from_be_bytes([127, 0, 0, 1])
                            || (*value).mask != u32::MAX
                    }
                {
                    return Err(format!(
                        "Windows sandbox {label} WFP allow filter has the wrong IPv4 loopback address"
                    ));
                }
            }
            LoopbackAddress::V6 => {
                if condition.conditionValue.r#type != FWP_V6_ADDR_MASK {
                    return Err(format!(
                        "Windows sandbox {label} WFP allow filter is not scoped to IPv6 loopback"
                    ));
                }

                let value = unsafe { condition.conditionValue.Anonymous.v6AddrMask };
                if value.is_null()
                    || unsafe {
                        (*value).addr != [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
                            || (*value).prefixLength != 128
                    }
                {
                    return Err(format!(
                        "Windows sandbox {label} WFP allow filter has the wrong IPv6 loopback address"
                    ));
                }
            }
        }

        Ok(())
    }

    fn user_match_security_descriptor(
        sandbox_sid: &str,
    ) -> Result<OwnedSecurityDescriptor, String> {
        let sddl = format!("D:(A;;0x{FWP_ACTRL_MATCH_FILTER:x};;;{sandbox_sid})");
        let sddl_wide = wide_null(&sddl);
        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let mut size = 0u32;
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SECURITY_DESCRIPTOR_REVISION,
                &mut security_descriptor,
                &mut size,
            )
        };

        if converted == 0 || security_descriptor.is_null() {
            return Err(format!(
                "failed to build Windows sandbox WFP user match descriptor: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(OwnedSecurityDescriptor {
            ptr: security_descriptor,
            size,
        })
    }

    fn security_descriptor_blob_to_sddl(
        blob: *mut FWP_BYTE_BLOB,
        label: &str,
    ) -> Result<String, String> {
        let mut string_descriptor: PWSTR = null_mut();
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                (*blob).data.cast(),
                SECURITY_DESCRIPTOR_REVISION,
                DACL_SECURITY_INFORMATION,
                &mut string_descriptor,
                null_mut(),
            )
        };

        if converted == 0 || string_descriptor.is_null() {
            return Err(format!(
                "failed to read Windows sandbox {label} WFP user condition descriptor: {}",
                std::io::Error::last_os_error()
            ));
        }

        let result = wide_ptr_to_string(string_descriptor)
            .ok_or_else(|| format!("Windows sandbox {label} WFP user condition is invalid"));
        unsafe {
            LocalFree(string_descriptor.cast());
        }
        result
    }

    fn lookup_account_sid_string(account_name: &str) -> Result<String, String> {
        let account_name = wide_null(account_name);
        let mut sid_size = 0u32;
        let mut domain_size = 0u32;
        let mut sid_name_use: SID_NAME_USE = 0;
        let first = unsafe {
            LookupAccountNameW(
                null(),
                account_name.as_ptr(),
                null_mut(),
                &mut sid_size,
                null_mut(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "failed to size Windows sandbox account SID lookup: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut sid = vec![0u8; sid_size as usize];
        let mut domain = vec![0u16; domain_size as usize];
        let looked_up = unsafe {
            LookupAccountNameW(
                null(),
                account_name.as_ptr(),
                sid.as_mut_ptr() as PSID,
                &mut sid_size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };

        if looked_up == 0 {
            return Err(format!(
                "failed to resolve Windows sandbox account SID: {}",
                std::io::Error::last_os_error()
            ));
        }

        sid_to_string(sid.as_mut_ptr() as PSID)
    }

    fn sid_to_string(sid: PSID) -> Result<String, String> {
        let mut string_sid = null_mut();
        let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };

        if converted == 0 || string_sid.is_null() {
            return Err(format!(
                "failed to convert Windows sandbox account SID to string: {}",
                std::io::Error::last_os_error()
            ));
        }

        let result = wide_ptr_to_string(string_sid)
            .ok_or_else(|| "Windows sandbox account SID string is invalid".to_string());
        unsafe {
            LocalFree(string_sid.cast());
        }
        result
    }

    fn display_data(name: &mut [u16], description: &mut [u16]) -> FWPM_DISPLAY_DATA0 {
        FWPM_DISPLAY_DATA0 {
            name: name.as_mut_ptr(),
            description: description.as_mut_ptr(),
        }
    }

    fn accept_exists(status: u32, label: &str) -> Result<(), String> {
        if status == 0 || status == FWP_E_ALREADY_EXISTS as u32 {
            Ok(())
        } else {
            Err(wfp_error(label, status))
        }
    }

    fn delete_optional(status: u32, label: &str) -> Result<(), String> {
        if status == 0 || status == FWP_E_NOT_FOUND as u32 {
            Ok(())
        } else {
            Err(wfp_error(label, status))
        }
    }

    fn wfp_error(label: &str, status: u32) -> String {
        format!("{label} (WFP status 0x{status:08x})")
    }

    fn same_guid(left: &GUID, right: &GUID) -> bool {
        left.data1 == right.data1
            && left.data2 == right.data2
            && left.data3 == right.data3
            && left.data4 == right.data4
    }

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    fn wide_ptr_to_string(value: *const u16) -> Option<String> {
        if value.is_null() {
            return None;
        }

        let mut len = 0usize;
        unsafe {
            while *value.add(len) != 0 {
                len += 1;
            }
        }

        Some(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(value, len)
        }))
    }

    struct WfpEngine {
        handle: HANDLE,
    }

    impl WfpEngine {
        fn open() -> Result<Self, String> {
            let mut session_name = wide_null("nocodeBuilder sandbox setup");
            let mut session_description =
                wide_null("Configures persistent nocodeBuilder sandbox WFP rules.");
            let mut session: FWPM_SESSION0 = unsafe { std::mem::zeroed() };
            session.displayData = display_data(&mut session_name, &mut session_description);

            let mut handle: HANDLE = null_mut();
            let status = unsafe {
                FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), &session, &mut handle)
            };

            if status != 0 || handle.is_null() {
                Err(wfp_error(
                    "failed to open Windows Filtering Platform engine",
                    status,
                ))
            } else {
                Ok(Self { handle })
            }
        }

        fn handle(&self) -> HANDLE {
            self.handle
        }
    }

    impl Drop for WfpEngine {
        fn drop(&mut self) {
            unsafe {
                FwpmEngineClose0(self.handle);
            }
        }
    }

    struct WfpMemory<T> {
        ptr: *mut T,
    }

    impl<T> WfpMemory<T> {
        fn new(ptr: *mut T) -> Self {
            Self { ptr }
        }
    }

    impl<T> Drop for WfpMemory<T> {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                let mut ptr = self.ptr.cast();
                unsafe {
                    FwpmFreeMemory0(&mut ptr);
                }
            }
        }
    }

    struct OwnedSecurityDescriptor {
        ptr: PSECURITY_DESCRIPTOR,
        size: u32,
    }

    impl Drop for OwnedSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.ptr.cast());
            }
        }
    }
}

#[cfg(test)]
fn test_elevation_override() -> Option<bool> {
    match std::env::var("NCB_SANDBOX_TEST_ELEVATED") {
        Ok(value) if value == "1" => Some(true),
        Ok(value) if value == "0" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn rejects_relative_paths() {
        let sandbox_root = unique_fixture_root("relative");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            sandbox_root: PathBuf::from("relative"),
            node_runtime_root: absolute_fixture_path("node"),
            workspace_root: sandbox_root.join("workspaces"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 1,
        };

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn status_never_claims_ready_without_real_setup() {
        let sandbox_root = unique_fixture_root("status");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root,
            node_runtime_root: absolute_fixture_path("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 1,
        };
        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "setup-required");
    }

    #[test]
    fn rejects_workspace_outside_sandbox_root() {
        let sandbox_root = unique_fixture_root("outside");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            sandbox_root,
            node_runtime_root: absolute_fixture_path("node"),
            workspace_root: absolute_fixture_path("workspace"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 1,
        };

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn validates_launcher_user_sid_shape() {
        assert!(validate_sid_string("launcherUserSid", "S-1-5-21-1-2-3-1001").is_ok());
        assert!(validate_sid_string("launcherUserSid", "S-S-5").is_err());
        assert!(validate_sid_string("launcherUserSid", "S-1-").is_err());
        assert!(validate_sid_string("launcherUserSid", "not-a-sid").is_err());
    }

    #[test]
    fn initialize_records_directory_account_acl_and_network_progress_ready() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::set_var("NCB_SANDBOX_TEST_ELEVATED", "1");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("initialize");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Initialize,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: Some(valid_sandbox_password()),
            policy_version: 7,
        };

        let response = handle_setup_request(request).unwrap();
        let marker_path = sandbox_root.join("state").join(SETUP_PROGRESS_FILE);
        let marker = read_progress_marker(&marker_path).unwrap();

        assert!(response.ok);
        assert_eq!(response.state, "ready");
        assert!(sandbox_root.join("workspaces").is_dir());
        assert!(sandbox_root.join("cache").is_dir());
        assert!(sandbox_root.join("tmp").is_dir());
        assert!(marker.directories_provisioned);
        assert!(marker.account_configured);
        assert!(marker.acls_configured);
        assert!(marker.network_filtering_configured);

        std::env::remove_var("NCB_SANDBOX_TEST_ELEVATED");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn account_progress_without_acls_still_requires_setup() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("account-progress");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 4,
        };
        fs::create_dir_all(sandbox_root.join("state")).unwrap();
        write_progress_marker(
            &sandbox_root.join("state").join(SETUP_PROGRESS_FILE),
            &SetupProgressMarker {
                schema_version: SETUP_SCHEMA_VERSION,
                policy_version: 4,
                sandbox_root: sandbox_root.clone(),
                node_runtime_root: sandbox_root.join("runtime").join("node"),
                workspace_root: sandbox_root.join("workspaces"),
                sandbox_account: SANDBOX_ACCOUNT_NAME.to_string(),
                sandbox_group: SANDBOX_GROUP_NAME.to_string(),
                directories_provisioned: true,
                account_configured: true,
                acls_configured: false,
                network_filtering_configured: false,
                updated_at: Utc::now().to_rfc3339(),
            },
        )
        .unwrap();

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "setup-required");
        assert!(response.message.contains("ACLs"));

        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn acl_progress_without_network_still_requires_setup() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("acl-progress");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 5,
        };
        fs::create_dir_all(sandbox_root.join("state")).unwrap();
        write_progress_marker(
            &sandbox_root.join("state").join(SETUP_PROGRESS_FILE),
            &SetupProgressMarker {
                schema_version: SETUP_SCHEMA_VERSION,
                policy_version: 5,
                sandbox_root: sandbox_root.clone(),
                node_runtime_root: sandbox_root.join("runtime").join("node"),
                workspace_root: sandbox_root.join("workspaces"),
                sandbox_account: SANDBOX_ACCOUNT_NAME.to_string(),
                sandbox_group: SANDBOX_GROUP_NAME.to_string(),
                directories_provisioned: true,
                account_configured: true,
                acls_configured: true,
                network_filtering_configured: false,
                updated_at: Utc::now().to_rfc3339(),
            },
        )
        .unwrap();

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "setup-required");
        assert!(response.message.contains("network filtering"));

        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn missing_verified_account_requires_repair() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::set_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT", "0");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("missing-account");
        let request = setup_status_request(&sandbox_root, 6);
        write_marker(&request, true, false, false);

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "repair-required");
        assert!(response.message.contains("account verification"));

        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn missing_verified_acls_requires_repair() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::set_var("NCB_SANDBOX_TEST_VERIFY_ACLS", "0");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("missing-acls");
        let request = setup_status_request(&sandbox_root, 7);
        write_marker(&request, true, true, false);

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "repair-required");
        assert!(response.message.contains("ACL verification"));

        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn missing_verified_network_requires_repair() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::set_var("NCB_SANDBOX_TEST_VERIFY_NETWORK", "0");
        let sandbox_root = unique_fixture_root("missing-network");
        let request = setup_status_request(&sandbox_root, 8);
        write_marker(&request, true, true, true);

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "repair-required");
        assert!(response.message.contains("network verification"));

        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn full_setup_progress_reports_ready() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACCOUNT");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_ACLS");
        std::env::remove_var("NCB_SANDBOX_TEST_VERIFY_NETWORK");
        let sandbox_root = unique_fixture_root("full-progress");
        let request = setup_status_request(&sandbox_root, 9);
        write_marker(&request, true, true, true);

        let response = handle_setup_request(request).unwrap();

        assert!(response.ok);
        assert_eq!(response.state, "ready");
        assert!(response.message.contains("runner launch prerequisites"));

        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn initialize_requires_elevation() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::set_var("NCB_SANDBOX_TEST_ELEVATED", "0");
        let sandbox_root = unique_fixture_root("not-elevated");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Initialize,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: Some(valid_sandbox_password()),
            policy_version: 1,
        };

        let error = handle_setup_request(request).unwrap_err();

        assert!(error.contains("must be run elevated"));
        assert!(!sandbox_root
            .join("state")
            .join(SETUP_PROGRESS_FILE)
            .exists());

        std::env::remove_var("NCB_SANDBOX_TEST_ELEVATED");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn initialize_requires_valid_sandbox_account_password() {
        let sandbox_root = unique_fixture_root("missing-password");
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Initialize,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 1,
        };

        let error = validate_request(&request).unwrap_err();

        assert!(error.contains("password"));
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn uninstall_removes_progress_marker_after_network_and_account_cleanup() {
        let _guard = elevation_override_lock().lock().unwrap();
        std::env::set_var("NCB_SANDBOX_TEST_ELEVATED", "1");
        let sandbox_root = unique_fixture_root("uninstall");
        let mut request = setup_status_request(&sandbox_root, 10);
        write_marker(&request, true, true, true);
        request.action = SetupAction::Uninstall;
        let marker_path = sandbox_root.join("state").join(SETUP_PROGRESS_FILE);

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "setup-required");
        assert!(!marker_path.exists());
        assert!(response
            .message
            .contains("sandbox account, sandbox local group"));

        std::env::remove_var("NCB_SANDBOX_TEST_ELEVATED");
        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn file_invocation_reads_request_and_writes_response() {
        let sandbox_root = unique_fixture_root("file-mode");
        let request_path = sandbox_root.join("request.json");
        let response_path = sandbox_root.join("response.json");
        fs::create_dir_all(&sandbox_root).unwrap();
        fs::write(
            &request_path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": SETUP_SCHEMA_VERSION,
                "action": "status",
                "sandboxRoot": sandbox_root.clone(),
                "nodeRuntimeRoot": sandbox_root.join("runtime").join("node"),
                "workspaceRoot": sandbox_root.join("workspaces"),
                "policyVersion": 1
            }))
            .unwrap(),
        )
        .unwrap();

        let invocation = read_setup_invocation_from_args(&[
            OsString::from("--request-file"),
            request_path.clone().into_os_string(),
            OsString::from("--response-file"),
            response_path.clone().into_os_string(),
        ])
        .unwrap();
        let response = handle_setup_request(invocation.request).unwrap();
        emit_setup_response(Some(&response_path), &response).unwrap();
        let persisted =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&response_path).unwrap())
                .unwrap();

        assert_eq!(invocation.response_path, Some(response_path.clone()));
        assert_eq!(persisted["state"], "setup-required");

        let _ = fs::remove_dir_all(sandbox_root);
    }

    #[test]
    fn corrupt_progress_marker_requires_repair() {
        let sandbox_root = unique_fixture_root("corrupt");
        fs::create_dir_all(sandbox_root.join("state")).unwrap();
        fs::write(
            sandbox_root.join("state").join(SETUP_PROGRESS_FILE),
            "not json",
        )
        .unwrap();
        let request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version: 1,
        };

        let response = handle_setup_request(request).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "repair-required");

        let _ = fs::remove_dir_all(sandbox_root);
    }

    fn absolute_fixture_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    fn unique_fixture_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "ncb-sandbox-setup-{name}-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn elevation_override_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn valid_sandbox_password() -> String {
        "Ncb!9abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            .chars()
            .take(48)
            .collect()
    }

    fn setup_status_request(sandbox_root: &Path, policy_version: u32) -> SetupRequest {
        SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Status,
            workspace_root: sandbox_root.join("workspaces"),
            sandbox_root: sandbox_root.to_path_buf(),
            node_runtime_root: sandbox_root.join("runtime").join("node"),
            launcher_user_sid: None,
            sandbox_account_password: None,
            policy_version,
        }
    }

    fn write_marker(
        request: &SetupRequest,
        account_configured: bool,
        acls_configured: bool,
        network_filtering_configured: bool,
    ) {
        fs::create_dir_all(request.sandbox_root.join("state")).unwrap();
        write_progress_marker(
            &request.sandbox_root.join("state").join(SETUP_PROGRESS_FILE),
            &SetupProgressMarker {
                schema_version: SETUP_SCHEMA_VERSION,
                policy_version: request.policy_version,
                sandbox_root: request.sandbox_root.clone(),
                node_runtime_root: request.node_runtime_root.clone(),
                workspace_root: request.workspace_root.clone(),
                sandbox_account: SANDBOX_ACCOUNT_NAME.to_string(),
                sandbox_group: SANDBOX_GROUP_NAME.to_string(),
                directories_provisioned: true,
                account_configured,
                acls_configured,
                network_filtering_configured,
                updated_at: Utc::now().to_rfc3339(),
            },
        )
        .unwrap();
    }
}
