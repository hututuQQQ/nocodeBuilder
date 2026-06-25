use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

const MAX_INPUT_BYTES: usize = 128 * 1024;
const RUNNER_SCHEMA_VERSION: u32 = 1;
#[cfg(any(target_os = "windows", test))]
const SANDBOX_ACCOUNT_NAME: &str = "NCB_Sandbox";
#[cfg(all(target_os = "windows", not(test)))]
const CREDENTIAL_SERVICE_NAME: &str = "AI Web Builder";
#[cfg(all(target_os = "windows", not(test)))]
const SANDBOX_ACCOUNT_PASSWORD_KEY: &str = "windows-sandbox:NCB_Sandbox:password";

struct RunnerInvocation {
    request: RunnerRequest,
    response_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerRequest {
    schema_version: u32,
    command_label: String,
    executable: PathBuf,
    args: Vec<String>,
    working_dir: PathBuf,
    readable_roots: Vec<PathBuf>,
    writable_roots: Vec<PathBuf>,
    denied_roots: Vec<PathBuf>,
    environment: BTreeMap<String, String>,
    limits: RunnerLimits,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerLimits {
    memory_bytes: u64,
    active_process_limit: u32,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerResponse {
    ok: bool,
    state: String,
    message: String,
    exit_code: Option<i32>,
}

fn main() {
    let mut response_path = None;
    let response = match read_runner_invocation() {
        Ok(invocation) => {
            response_path = invocation.response_path;
            handle_runner_request(invocation.request).unwrap_or_else(|message| RunnerResponse {
                ok: false,
                state: "error".to_string(),
                message,
                exit_code: None,
            })
        }
        Err(message) => RunnerResponse {
            ok: false,
            state: "error".to_string(),
            message,
            exit_code: None,
        },
    };

    if let Err(error) = emit_runner_response(response_path.as_deref(), &response) {
        eprintln!("{error}");
        std::process::exit(1);
    }

    if !response.ok {
        std::process::exit(1);
    }
}

fn read_runner_invocation() -> Result<RunnerInvocation, String> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    read_runner_invocation_from_args(&args)
}

fn read_runner_invocation_from_args(args: &[OsString]) -> Result<RunnerInvocation, String> {
    if args.is_empty() {
        return Ok(RunnerInvocation {
            request: parse_runner_request_bytes(read_stdin_bytes()?)?,
            response_path: None,
        });
    }

    if args.len() != 4
        || args[0] != OsStr::new("--request-file")
        || args[2] != OsStr::new("--response-file")
    {
        return Err("unsupported runner helper arguments".to_string());
    }

    let request_path = PathBuf::from(&args[1]);
    let response_path = PathBuf::from(&args[3]);
    validate_absolute_path("requestFile", &request_path)?;
    validate_absolute_path("responseFile", &response_path)?;

    let content = fs::read(&request_path).map_err(|error| {
        format!(
            "failed to read runner request file '{}': {error}",
            request_path.display()
        )
    })?;

    if content.len() > MAX_INPUT_BYTES {
        return Err("runner request is too large".to_string());
    }

    Ok(RunnerInvocation {
        request: parse_runner_request_bytes(content)?,
        response_path: Some(response_path),
    })
}

fn read_stdin_bytes() -> Result<Vec<u8>, String> {
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("failed to read runner request: {error}"))?;

    if input.len() > MAX_INPUT_BYTES {
        return Err("runner request is too large".to_string());
    }

    Ok(input)
}

fn parse_runner_request_bytes(input: Vec<u8>) -> Result<RunnerRequest, String> {
    serde_json::from_slice::<RunnerRequest>(&input)
        .map_err(|error| format!("failed to parse runner request JSON: {error}"))
}

fn emit_runner_response(
    response_path: Option<&Path>,
    response: &RunnerResponse,
) -> Result<(), String> {
    let content = serde_json::to_vec(response)
        .map_err(|error| format!("failed to serialize runner response: {error}"))?;

    let Some(response_path) = response_path else {
        println!("{}", String::from_utf8_lossy(&content));
        return Ok(());
    };

    write_file_atomically(response_path, &content, "runner response")
}

fn handle_runner_request(request: RunnerRequest) -> Result<RunnerResponse, String> {
    validate_request(&request)?;

    if let Err(message) = ensure_runner_identity() {
        return launch_self_as_sandbox_account(request, message);
    }

    execute_allowlisted_command(request)
}

fn validate_request(request: &RunnerRequest) -> Result<(), String> {
    if request.schema_version != RUNNER_SCHEMA_VERSION {
        return Err(format!(
            "unsupported runner schema version {}",
            request.schema_version
        ));
    }

    validate_allowed_command(&request.command_label, &request.args, &request.executable)?;
    validate_absolute_path("executable", &request.executable)?;
    validate_absolute_path("workingDir", &request.working_dir)?;
    validate_root_policy(request)?;
    validate_environment(
        &request.environment,
        &request.readable_roots,
        &request.writable_roots,
        &request.denied_roots,
    )?;
    validate_limits(request.limits)?;

    for arg in &request.args {
        if arg.len() > 1024 || arg.contains('\0') {
            return Err("runner argument is invalid".to_string());
        }
    }

    Ok(())
}

fn validate_allowed_command(
    command: &str,
    args: &[String],
    executable: &Path,
) -> Result<(), String> {
    let (package_manager, expected_args): (&str, &[&str]) = match command.trim() {
        "npm install" => ("npm", &["install"]),
        "npm run dev" => ("npm", &["run", "dev"]),
        "npm run build" => ("npm", &["run", "build"]),
        "npm run lint" => ("npm", &["run", "lint"]),
        "npm run test" => ("npm", &["run", "test"]),
        "npm test" => ("npm", &["test"]),
        "pnpm install" => ("pnpm", &["pnpm", "install"]),
        "pnpm dev" => ("pnpm", &["pnpm", "dev"]),
        "pnpm build" => ("pnpm", &["pnpm", "build"]),
        "pnpm lint" => ("pnpm", &["pnpm", "lint"]),
        "pnpm test" => ("pnpm", &["pnpm", "test"]),
        _ => return Err("runner command label is not allowlisted".to_string()),
    };

    validate_executable_matches_package_manager(package_manager, executable)?;
    validate_args_match_label(args, expected_args)
}

fn validate_executable_matches_package_manager(
    package_manager: &str,
    executable: &Path,
) -> Result<(), String> {
    let file_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "runner executable is invalid".to_string())?
        .to_ascii_lowercase();

    let matches_package_manager = match package_manager {
        "npm" => file_name == "npm" || file_name == "npm.cmd",
        "pnpm" => {
            file_name == "corepack"
                || file_name == "corepack.cmd"
                || file_name == "pnpm"
                || file_name == "pnpm.cmd"
        }
        _ => false,
    };

    if matches_package_manager {
        Ok(())
    } else {
        Err("runner executable does not match command label".to_string())
    }
}

fn validate_args_match_label(args: &[String], expected: &[&str]) -> Result<(), String> {
    if args.len() != expected.len() {
        return Err("runner arguments do not match command label".to_string());
    }

    for (actual, expected) in args.iter().zip(expected) {
        if actual != expected {
            return Err("runner arguments do not match command label".to_string());
        }
    }

    Ok(())
}

fn validate_absolute_path(label: &str, path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(format!("{label} must be an absolute path"));
    }

    let text = path.to_string_lossy();

    if text.len() > 1024 || text.contains('\0') || has_unsafe_components(path) {
        return Err(format!("{label} is invalid"));
    }

    Ok(())
}

fn has_unsafe_components(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

fn validate_root_policy(request: &RunnerRequest) -> Result<(), String> {
    validate_roots("readableRoots", &request.readable_roots, false)?;
    validate_roots("writableRoots", &request.writable_roots, false)?;
    validate_roots("deniedRoots", &request.denied_roots, true)?;

    validate_path_within_roots(
        "executable",
        &request.executable,
        &request.readable_roots,
        &request.denied_roots,
    )?;
    validate_path_within_roots(
        "workingDir",
        &request.working_dir,
        &request.writable_roots,
        &request.denied_roots,
    )
}

fn validate_roots(label: &str, roots: &[PathBuf], allow_empty: bool) -> Result<(), String> {
    if roots.is_empty() && !allow_empty {
        return Err(format!("{label} must not be empty"));
    }

    if roots.len() > 32 {
        return Err(format!("{label} contains too many entries"));
    }

    for root in roots {
        validate_absolute_path(label, root)?;
    }

    Ok(())
}

fn validate_path_within_roots(
    label: &str,
    path: &Path,
    allowed_roots: &[PathBuf],
    denied_roots: &[PathBuf],
) -> Result<(), String> {
    if denied_roots
        .iter()
        .any(|denied_root| path_is_same_or_child(path, denied_root))
    {
        return Err(format!("{label} is inside a denied root"));
    }

    if allowed_roots
        .iter()
        .any(|allowed_root| path_is_same_or_child(path, allowed_root))
    {
        Ok(())
    } else {
        Err(format!("{label} is outside sandbox roots"))
    }
}

#[cfg(target_os = "windows")]
fn path_is_same_or_child(path: &Path, root: &Path) -> bool {
    let path = comparable_windows_path(path);
    let root = comparable_windows_path(root);

    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

#[cfg(target_os = "windows")]
fn comparable_windows_path(path: &Path) -> String {
    let mut text = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();

    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }

    text
}

#[cfg(not(target_os = "windows"))]
fn path_is_same_or_child(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn validate_environment(
    environment: &BTreeMap<String, String>,
    readable_roots: &[PathBuf],
    writable_roots: &[PathBuf],
    denied_roots: &[PathBuf],
) -> Result<(), String> {
    for (key, value) in environment {
        if key.is_empty()
            || key.len() > 128
            || key.contains('\0')
            || key.contains('=')
            || value.len() > 4096
            || value.contains('\0')
        {
            return Err("environment variable is invalid".to_string());
        }

        if is_forbidden_environment_key(key) {
            return Err(format!("forbidden environment variable '{key}'"));
        }

        if !is_allowed_environment_key(key) {
            return Err(format!("environment variable '{key}' is not allowed"));
        }
    }

    if environment.len() > 64 {
        return Err("too many environment variables".to_string());
    }

    let path_value = environment
        .iter()
        .find(|(key, _)| env_key_equals(key, "PATH"))
        .map(|(_, value)| value)
        .ok_or_else(|| "sandbox PATH is required".to_string())?;
    validate_path_environment_value(path_value, readable_roots, writable_roots, denied_roots)?;

    for key in [
        "HOME",
        "USERPROFILE",
        "TEMP",
        "TMP",
        "NPM_CONFIG_CACHE",
        "COREPACK_HOME",
    ] {
        let value = environment
            .iter()
            .find(|(candidate, _)| env_key_equals(candidate, key))
            .map(|(_, value)| value)
            .ok_or_else(|| format!("sandbox {key} is required"))?;
        validate_writable_environment_path(key, value, writable_roots, denied_roots)?;
    }

    validate_required_literal(environment, "COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")?;
    validate_required_literal(environment, "CI", "1")?;
    validate_required_literal(environment, "NO_COLOR", "1")?;
    validate_proxy_environment(environment)?;
    validate_local_server_environment(environment)?;
    validate_windows_system_environment(environment, denied_roots)?;

    Ok(())
}

fn environment_value<'a>(
    environment: &'a BTreeMap<String, String>,
    key: &str,
) -> Option<&'a String> {
    environment
        .iter()
        .find(|(candidate, _)| env_key_equals(candidate, key))
        .map(|(_, value)| value)
}

fn env_key_equals(key: &str, expected: &str) -> bool {
    key.eq_ignore_ascii_case(expected)
}

fn is_allowed_environment_key(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "PATH"
            | "HOME"
            | "USERPROFILE"
            | "TEMP"
            | "TMP"
            | "NPM_CONFIG_CACHE"
            | "COREPACK_HOME"
            | "COREPACK_ENABLE_DOWNLOAD_PROMPT"
            | "CI"
            | "NO_COLOR"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "HOST"
            | "HOSTNAME"
            | "PORT"
            | "SYSTEMROOT"
            | "WINDIR"
            | "COMSPEC"
    )
}

fn is_forbidden_environment_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();

    matches!(
        key.as_str(),
        "OPENAI_API_KEY"
            | "GITHUB_TOKEN"
            | "SSH_AUTH_SOCK"
            | "AWS_ACCESS_KEY_ID"
            | "AWS_SECRET_ACCESS_KEY"
            | "VERCEL_TOKEN"
    ) || key.starts_with("SUPABASE_")
        || key.starts_with("VERCEL_")
        || key.starts_with("AWS_")
        || key.ends_with("_TOKEN")
        || key.ends_with("_SECRET")
        || key.ends_with("_API_KEY")
}

fn validate_path_environment_value(
    value: &str,
    readable_roots: &[PathBuf],
    writable_roots: &[PathBuf],
    denied_roots: &[PathBuf],
) -> Result<(), String> {
    let mut saw_entry = false;
    let mut allowed_roots = readable_roots.to_vec();
    allowed_roots.extend_from_slice(writable_roots);

    for entry in std::env::split_paths(value) {
        saw_entry = true;
        validate_absolute_path("PATH entry", &entry)?;
        validate_path_within_roots("PATH entry", &entry, &allowed_roots, denied_roots)?;
    }

    if saw_entry {
        Ok(())
    } else {
        Err("sandbox PATH must not be empty".to_string())
    }
}

fn validate_writable_environment_path(
    key: &str,
    value: &str,
    writable_roots: &[PathBuf],
    denied_roots: &[PathBuf],
) -> Result<(), String> {
    let path = PathBuf::from(value);
    validate_absolute_path(key, &path)?;
    validate_path_within_roots(key, &path, writable_roots, denied_roots)
}

fn validate_required_literal(
    environment: &BTreeMap<String, String>,
    key: &str,
    expected: &str,
) -> Result<(), String> {
    let value = environment
        .iter()
        .find(|(candidate, _)| env_key_equals(candidate, key))
        .map(|(_, value)| value.as_str())
        .ok_or_else(|| format!("sandbox {key} is required"))?;

    if value == expected {
        Ok(())
    } else {
        Err(format!("sandbox {key} has an invalid value"))
    }
}

fn validate_proxy_environment(environment: &BTreeMap<String, String>) -> Result<(), String> {
    let http_proxy = environment_value(environment, "HTTP_PROXY");
    let https_proxy = environment_value(environment, "HTTPS_PROXY");

    match (http_proxy, https_proxy) {
        (None, None) => Ok(()),
        (Some(http_proxy), Some(https_proxy)) => {
            if http_proxy != https_proxy {
                return Err("sandbox proxy variables must match".to_string());
            }

            validate_loopback_http_url(http_proxy).map_err(|_| {
                "sandbox proxy variables must point to http://127.0.0.1:<port>".to_string()
            })
        }
        _ => Err("sandbox proxy variables must be provided together".to_string()),
    }
}

fn validate_loopback_http_url(value: &str) -> Result<(), String> {
    let port = value
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| "missing loopback proxy prefix".to_string())?;

    if port.is_empty() || port.contains('/') || port.contains('?') || port.contains('#') {
        return Err("invalid loopback proxy port".to_string());
    }

    match port.parse::<u16>() {
        Ok(0) | Err(_) => Err("invalid loopback proxy port".to_string()),
        Ok(_) => Ok(()),
    }
}

fn validate_local_server_environment(environment: &BTreeMap<String, String>) -> Result<(), String> {
    let host = environment_value(environment, "HOST");
    let hostname = environment_value(environment, "HOSTNAME");
    let port = environment_value(environment, "PORT");

    match (host, hostname, port) {
        (None, None, None) => Ok(()),
        (Some(host), Some(hostname), Some(port)) => {
            if host != "127.0.0.1" || hostname != "127.0.0.1" {
                return Err("sandbox dev server host must be 127.0.0.1".to_string());
            }

            match port.parse::<u16>() {
                Ok(0) | Err(_) => Err("sandbox dev server port is invalid".to_string()),
                Ok(_) => Ok(()),
            }
        }
        _ => {
            Err("sandbox dev server environment must include HOST, HOSTNAME, and PORT".to_string())
        }
    }
}

fn validate_windows_system_environment(
    environment: &BTreeMap<String, String>,
    denied_roots: &[PathBuf],
) -> Result<(), String> {
    for key in ["SystemRoot", "WINDIR", "ComSpec"] {
        let Some(value) = environment_value(environment, key) else {
            continue;
        };

        let path = PathBuf::from(value);
        validate_absolute_path(key, &path)?;

        if denied_roots
            .iter()
            .any(|denied_root| path_is_same_or_child(&path, denied_root))
        {
            return Err(format!("{key} is inside a denied root"));
        }
    }

    if let (Some(comspec), Some(system_root)) = (
        environment_value(environment, "ComSpec").map(PathBuf::from),
        environment_value(environment, "SystemRoot").map(PathBuf::from),
    ) {
        let expected = system_root.join("System32").join("cmd.exe");
        if !paths_equal_for_platform(&comspec, &expected) {
            return Err("ComSpec must point to SystemRoot\\System32\\cmd.exe".to_string());
        }
    } else if environment_value(environment, "ComSpec").is_some() {
        return Err("ComSpec requires SystemRoot".to_string());
    }

    if let (Some(windir), Some(system_root)) = (
        environment_value(environment, "WINDIR").map(PathBuf::from),
        environment_value(environment, "SystemRoot").map(PathBuf::from),
    ) {
        if !paths_equal_for_platform(&windir, &system_root) {
            return Err("WINDIR must match SystemRoot".to_string());
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn paths_equal_for_platform(left: &Path, right: &Path) -> bool {
    comparable_windows_path(left) == comparable_windows_path(right)
}

#[cfg(not(target_os = "windows"))]
fn paths_equal_for_platform(left: &Path, right: &Path) -> bool {
    left == right
}

fn validate_limits(limits: RunnerLimits) -> Result<(), String> {
    if limits.memory_bytes == 0
        || limits.active_process_limit == 0
        || limits
            .timeout_seconds
            .is_some_and(|timeout| timeout > 24 * 60 * 60)
    {
        return Err("runner resource limits are invalid".to_string());
    }

    Ok(())
}

fn setup_required_response(message: impl Into<String>) -> RunnerResponse {
    RunnerResponse {
        ok: false,
        state: "setup-required".to_string(),
        message: message.into(),
        exit_code: None,
    }
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

#[cfg(all(target_os = "windows", not(test)))]
fn launch_self_as_sandbox_account(
    request: RunnerRequest,
    identity_error: String,
) -> Result<RunnerResponse, String> {
    let password = read_sandbox_account_password().map_err(|error| {
        format!(
            "{identity_error} Windows sandbox account password is unavailable; run sandbox setup or repair. ({error})"
        )
    })?;

    if !validate_sandbox_account_password(&password) {
        return Ok(setup_required_response(format!(
            "{identity_error} Windows sandbox account password in the user credential store is invalid; run repair."
        )));
    }

    let sidecar = std::env::current_exe()
        .map_err(|error| format!("failed to resolve Windows sandbox runner path: {error}"))?;
    let exchange = RunnerExchangeFiles::create(&request)?;
    let child_exit =
        create_process_with_batch_logon(&sidecar, &exchange, &request.working_dir, &password)?;
    let response = read_runner_response_file(&exchange.response_path)?;

    if child_exit != 0 && response.ok {
        return Ok(RunnerResponse {
            ok: false,
            state: "error".to_string(),
            message: format!(
                "Windows sandbox runner exited with code {child_exit} after reporting success"
            ),
            exit_code: Some(child_exit as i32),
        });
    }

    Ok(response)
}

#[cfg(any(not(target_os = "windows"), test))]
fn launch_self_as_sandbox_account(
    _request: RunnerRequest,
    identity_error: String,
) -> Result<RunnerResponse, String> {
    Ok(setup_required_response(identity_error))
}

#[cfg(all(target_os = "windows", not(test)))]
struct RunnerExchangeFiles {
    root: PathBuf,
    request_path: PathBuf,
    response_path: PathBuf,
}

#[cfg(all(target_os = "windows", not(test)))]
impl RunnerExchangeFiles {
    fn create(request: &RunnerRequest) -> Result<Self, String> {
        let parent = request.writable_roots.last().ok_or_else(|| {
            "runner request does not include a writable exchange root".to_string()
        })?;
        let root = parent.join(".ncb-runner-ipc").join(format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).map_err(|error| {
            format!(
                "failed to create Windows sandbox runner exchange directory '{}': {error}",
                root.display()
            )
        })?;
        let request_path = root.join("request.json");
        let response_path = root.join("response.json");
        let payload = serde_json::to_vec(request).map_err(|error| {
            format!("failed to serialize Windows sandbox child runner request: {error}")
        })?;
        fs::write(&request_path, payload).map_err(|error| {
            format!(
                "failed to write Windows sandbox child runner request '{}': {error}",
                request_path.display()
            )
        })?;

        Ok(Self {
            root,
            request_path,
            response_path,
        })
    }
}

#[cfg(all(target_os = "windows", not(test)))]
impl Drop for RunnerExchangeFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(all(target_os = "windows", not(test)))]
fn create_process_with_batch_logon(
    sidecar: &Path,
    exchange: &RunnerExchangeFiles,
    working_dir: &Path,
    password: &str,
) -> Result<u32, String> {
    use std::{mem::size_of, ptr::null};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_FAILED},
        Security::{LogonUserW, LOGON32_LOGON_BATCH, LOGON32_PROVIDER_DEFAULT},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            Threading::{
                CreateProcessWithTokenW, GetExitCodeProcess, WaitForSingleObject, CREATE_NO_WINDOW,
                INFINITE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
            },
        },
    };

    let username = wide_null(SANDBOX_ACCOUNT_NAME);
    let domain = wide_null(".");
    let mut password_wide = wide_null(password);
    let application = wide_path(sidecar);
    let current_dir = wide_path(working_dir);
    let launch_job = WindowsJobObject::create_kill_on_close(
        "failed to create Windows sandbox runner launch Job Object",
    )?;
    let mut command_line = wide_null(&format!(
        "{} --request-file {} --response-file {}",
        quote_windows_arg(sidecar),
        quote_windows_arg(&exchange.request_path),
        quote_windows_arg(&exchange.response_path)
    ));

    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };

    let mut token: HANDLE = std::ptr::null_mut();
    let logged_on = unsafe {
        LogonUserW(
            username.as_ptr(),
            domain.as_ptr(),
            password_wide.as_ptr(),
            LOGON32_LOGON_BATCH,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    };
    password_wide.fill(0);

    if logged_on == 0 || token.is_null() {
        return Err(format!(
            "failed to log on Windows sandbox account {SANDBOX_ACCOUNT_NAME} as a batch job: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let launched = unsafe {
        CreateProcessWithTokenW(
            token,
            0,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            CREATE_NO_WINDOW,
            null(),
            current_dir.as_ptr(),
            &startup,
            &mut process_info,
        )
    };
    unsafe {
        CloseHandle(token);
    }

    if launched == 0 {
        return Err(format!(
            "failed to launch Windows sandbox runner with the {SANDBOX_ACCOUNT_NAME} batch logon token: {}",
            std::io::Error::last_os_error()
        ));
    }

    if let Err(error) = launch_job.assign_process_handle(process_info.hProcess) {
        unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
        }
        return Err(error);
    }

    let wait_result = unsafe { WaitForSingleObject(process_info.hProcess, INFINITE) };
    if wait_result == WAIT_FAILED {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(process_info.hThread);
            CloseHandle(process_info.hProcess);
        }
        return Err(format!(
            "failed to wait for Windows sandbox runner account process: {error}"
        ));
    }

    let mut exit_code = 0u32;
    let got_exit_code = unsafe { GetExitCodeProcess(process_info.hProcess, &mut exit_code) };
    unsafe {
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
    }

    if got_exit_code == 0 {
        return Err(format!(
            "failed to read Windows sandbox runner account process exit code: {}",
            std::io::Error::last_os_error()
        ));
    }

    Ok(exit_code)
}

#[cfg(all(target_os = "windows", not(test)))]
fn read_runner_response_file(path: &Path) -> Result<RunnerResponse, String> {
    let content = fs::read(path).map_err(|error| {
        format!(
            "Windows sandbox runner account process did not write response file '{}': {error}",
            path.display()
        )
    })?;

    serde_json::from_slice::<RunnerResponse>(&content)
        .map_err(|error| format!("Windows sandbox runner wrote an invalid response file: {error}"))
}

#[cfg(all(target_os = "windows", not(test)))]
fn read_sandbox_account_password() -> Result<String, keyring::Error> {
    keyring::Entry::new(CREDENTIAL_SERVICE_NAME, SANDBOX_ACCOUNT_PASSWORD_KEY)?.get_password()
}

#[cfg(all(target_os = "windows", not(test)))]
fn validate_sandbox_account_password(password: &str) -> bool {
    password.len() >= 32
        && password.len() <= 128
        && password.bytes().all(|byte| byte.is_ascii_graphic())
        && password.chars().any(|ch| ch.is_ascii_uppercase())
        && password.chars().any(|ch| ch.is_ascii_lowercase())
        && password.chars().any(|ch| ch.is_ascii_digit())
        && password.chars().any(|ch| !ch.is_ascii_alphanumeric())
}

#[cfg(all(target_os = "windows", not(test)))]
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

#[cfg(all(target_os = "windows", not(test)))]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain([0]).collect()
}

#[cfg(all(target_os = "windows", not(test)))]
fn wide_null(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(value).encode_wide().chain([0]).collect()
}

#[cfg(all(target_os = "windows", not(test)))]
fn ensure_runner_identity() -> Result<(), String> {
    let current_sid = windows_identity::current_process_user_sid()?;
    let sandbox_sid = windows_identity::lookup_account_sid_string(SANDBOX_ACCOUNT_NAME)?;

    if current_sid == sandbox_sid {
        Ok(())
    } else {
        Err(format!("Windows sandbox runner is not running as the {SANDBOX_ACCOUNT_NAME} account identity; refusing current-user execution fallback."))
    }
}

#[cfg(test)]
fn ensure_runner_identity() -> Result<(), String> {
    if matches!(std::env::var("NCB_SANDBOX_TEST_RUNNER_IDENTITY"), Ok(value) if value == "1") {
        Ok(())
    } else {
        Err(format!("Windows sandbox runner is not running as the {SANDBOX_ACCOUNT_NAME} account identity; refusing current-user execution fallback."))
    }
}

#[cfg(all(not(target_os = "windows"), not(test)))]
fn ensure_runner_identity() -> Result<(), String> {
    Err("Windows sandbox runner is only supported on Windows".to_string())
}

fn execute_allowlisted_command(request: RunnerRequest) -> Result<RunnerResponse, String> {
    let mut command = Command::new(&request.executable);
    command
        .args(&request.args)
        .current_dir(&request.working_dir)
        .env_clear()
        .envs(&request.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = RunnerChild::spawn(command, request.limits)?;
    let exit = child.wait_with_timeout(request.limits.timeout_seconds.map(Duration::from_secs))?;

    Ok(RunnerResponse {
        ok: exit.status.success() && !exit.timed_out,
        state: if exit.timed_out {
            "timeout".to_string()
        } else {
            "completed".to_string()
        },
        message: if exit.timed_out {
            "Windows sandbox command exceeded its timeout and was terminated.".to_string()
        } else {
            "Windows sandbox command completed.".to_string()
        },
        exit_code: exit.status.code(),
    })
}

struct RunnerExit {
    status: ExitStatus,
    timed_out: bool,
}

struct RunnerChild {
    child: std::process::Child,
    #[cfg(target_os = "windows")]
    job: WindowsJobObject,
}

impl RunnerChild {
    fn spawn(mut command: Command, limits: RunnerLimits) -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        {
            let mut child = command
                .spawn()
                .map_err(|error| format!("failed to spawn Windows sandbox command: {error}"))?;
            let job = WindowsJobObject::create(limits)?;
            if let Err(error) = job.assign_child(&child) {
                let _ = child.kill();
                return Err(error);
            }

            return Ok(Self { child, job });
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = limits;
            Ok(Self {
                child: command
                    .spawn()
                    .map_err(|error| format!("failed to spawn sandbox command: {error}"))?,
            })
        }
    }

    fn wait_with_timeout(&mut self, timeout: Option<Duration>) -> Result<RunnerExit, String> {
        let Some(timeout) = timeout else {
            let status = self
                .child
                .wait()
                .map_err(|error| format!("failed to wait for sandbox command: {error}"))?;
            return Ok(RunnerExit {
                status,
                timed_out: false,
            });
        };
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|error| format!("failed to poll sandbox command: {error}"))?
            {
                return Ok(RunnerExit {
                    status,
                    timed_out: false,
                });
            }

            if Instant::now() >= deadline {
                self.terminate_tree()?;
                let status = self.child.wait().map_err(|error| {
                    format!("failed to wait after sandbox command timeout: {error}")
                })?;
                return Ok(RunnerExit {
                    status,
                    timed_out: true,
                });
            }

            thread::sleep(Duration::from_millis(50));
        }
    }

    fn terminate_tree(&mut self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            self.job.terminate()
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.child
                .kill()
                .map_err(|error| format!("failed to terminate sandbox command: {error}"))
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsJobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
impl WindowsJobObject {
    fn create(limits: RunnerLimits) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };

        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "failed to create Windows sandbox Job Object: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY;
        info.BasicLimitInformation.ActiveProcessLimit = limits.active_process_limit;
        info.JobMemoryLimit = limits.memory_bytes as usize;

        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if ok == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(format!(
                "failed to configure Windows sandbox Job Object: {error}"
            ));
        }

        Ok(Self { handle })
    }

    #[cfg(not(test))]
    fn create_kill_on_close(error_label: &str) -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::INVALID_HANDLE_VALUE,
            System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };

        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "{error_label}: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if ok == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Err(format!(
                "failed to configure Windows sandbox runner launch Job Object: {error}"
            ));
        }

        Ok(Self { handle })
    }

    fn assign_child(&self, child: &std::process::Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;

        let process_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        self.assign_process_handle(process_handle)
    }

    fn assign_process_handle(
        &self,
        process_handle: windows_sys::Win32::Foundation::HANDLE,
    ) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let ok = unsafe { AssignProcessToJobObject(self.handle, process_handle) };

        if ok == 0 {
            Err(format!(
                "failed to assign sandbox command to Windows Job Object: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }

    fn terminate(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        let ok = unsafe { TerminateJobObject(self.handle, 1) };

        if ok == 0 {
            Err(format!(
                "failed to terminate Windows sandbox Job Object: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(all(target_os = "windows", not(test)))]
mod windows_identity {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr::null_mut};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, HANDLE},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, LookupAccountNameW,
            TokenUser, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    pub fn current_process_user_sid() -> Result<String, String> {
        let mut token: HANDLE = null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };

        if opened == 0 {
            return Err(format!(
                "failed to open Windows sandbox runner process token: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
        }

        if needed == 0 {
            unsafe {
                CloseHandle(token);
            }
            return Err(format!(
                "failed to size Windows sandbox runner user SID: {}",
                std::io::Error::last_os_error()
            ));
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
            return Err(format!(
                "failed to read Windows sandbox runner user SID: {}",
                std::io::Error::last_os_error()
            ));
        }

        let token_user = unsafe { &*(token_info.as_ptr() as *const TOKEN_USER) };
        sid_to_string(token_user.User.Sid)
    }

    pub fn lookup_account_sid_string(account_name: &str) -> Result<String, String> {
        let account_name = wide_null(account_name);
        let mut sid_size = 0u32;
        let mut domain_size = 0u32;
        let mut sid_name_use: SID_NAME_USE = 0;
        let first = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
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

        sid_to_string(sid.as_mut_ptr() as PSID)
    }

    fn sid_to_string(sid: PSID) -> Result<String, String> {
        let mut string_sid = null_mut();
        let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };

        if converted == 0 || string_sid.is_null() {
            return Err(format!(
                "failed to convert Windows sandbox runner SID to string: {}",
                std::io::Error::last_os_error()
            ));
        }

        let result = wide_ptr_to_string(string_sid)
            .ok_or_else(|| "Windows sandbox runner SID string is invalid".to_string());
        unsafe {
            LocalFree(string_sid.cast());
        }
        result
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

    #[allow(dead_code)]
    fn _security_descriptor_type_marker(_: PSECURITY_DESCRIPTOR) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn rejects_non_allowlisted_commands() {
        let mut request = valid_request();
        request.command_label = "cmd /c whoami".to_string();

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_sensitive_environment() {
        let mut request = valid_request();
        request.environment.insert(
            "SUPABASE_SERVICE_ROLE_KEY".to_string(),
            "secret".to_string(),
        );

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_args_that_do_not_match_label() {
        let mut request = valid_request();
        request.args.push("--ignore-scripts".to_string());

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_executable_that_does_not_match_label() {
        let mut request = valid_request();
        request.executable = fixture_root().join("node").join("bin").join("pnpm.cmd");

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn accepts_pnpm_labels_through_corepack() {
        let mut request = valid_request();
        request.command_label = "pnpm build".to_string();
        request.executable = fixture_root().join("node").join("bin").join("corepack.cmd");
        request.args = vec!["pnpm".to_string(), "build".to_string()];

        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn rejects_executable_outside_readable_roots() {
        let mut request = valid_request();
        request.executable =
            fixture_root()
                .join("host-tools")
                .join(if cfg!(target_os = "windows") {
                    "npm.cmd"
                } else {
                    "npm"
                });

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_working_dir_outside_writable_roots() {
        let mut request = valid_request();
        request.working_dir = fixture_root().join("real-project");

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_path_entries_outside_sandbox_roots() {
        let mut request = valid_request();
        let bad_path = std::env::join_paths([
            fixture_root().join("node").join("bin"),
            fixture_root().join("host-tools"),
        ])
        .unwrap();
        request
            .environment
            .insert("PATH".to_string(), os_to_string(bad_path));

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_cache_environment_outside_writable_roots() {
        let mut request = valid_request();
        request.environment.insert(
            "NPM_CONFIG_CACHE".to_string(),
            path_to_string(fixture_root().join("real-project").join("npm")),
        );

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn rejects_public_proxy_environment() {
        let mut request = valid_request();
        request
            .environment
            .insert("HTTP_PROXY".to_string(), "http://10.0.0.5:8080".to_string());
        request.environment.insert(
            "HTTPS_PROXY".to_string(),
            "http://10.0.0.5:8080".to_string(),
        );

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn accepts_loopback_proxy_environment() {
        let mut request = valid_request();
        request.environment.insert(
            "HTTP_PROXY".to_string(),
            "http://127.0.0.1:4873".to_string(),
        );
        request.environment.insert(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:4873".to_string(),
        );

        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn rejects_public_dev_server_host_environment() {
        let mut request = valid_request();
        request
            .environment
            .insert("HOST".to_string(), "0.0.0.0".to_string());
        request
            .environment
            .insert("HOSTNAME".to_string(), "0.0.0.0".to_string());
        request
            .environment
            .insert("PORT".to_string(), "3000".to_string());

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn accepts_loopback_dev_server_environment() {
        let mut request = valid_request();
        request
            .environment
            .insert("HOST".to_string(), "127.0.0.1".to_string());
        request
            .environment
            .insert("HOSTNAME".to_string(), "127.0.0.1".to_string());
        request
            .environment
            .insert("PORT".to_string(), "3000".to_string());

        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn accepts_workspace_under_user_profile_when_only_sensitive_home_paths_are_denied() {
        let root = fixture_root();
        let home = root.join("home");
        let workspace_root = home
            .join("AppData")
            .join("Local")
            .join("nocodeBuilder")
            .join("sandbox")
            .join("workspaces")
            .join("project")
            .join("runs")
            .join("run-1");
        let cache_root = home
            .join("AppData")
            .join("Local")
            .join("nocodeBuilder")
            .join("sandbox")
            .join("cache")
            .join("project");
        let tmp_root = home
            .join("AppData")
            .join("Local")
            .join("nocodeBuilder")
            .join("sandbox")
            .join("tmp")
            .join("project")
            .join("run-1");
        let node_root = root.join("node");
        let node_bin = node_root.join("bin");
        let path = std::env::join_paths([
            node_bin.clone(),
            workspace_root.join("node_modules").join(".bin"),
        ])
        .unwrap();
        let mut request = valid_request();
        request.executable = node_bin.join(if cfg!(target_os = "windows") {
            "npm.cmd"
        } else {
            "npm"
        });
        request.working_dir = workspace_root.clone();
        request.readable_roots = vec![node_root.clone(), node_bin, workspace_root.clone()];
        request.writable_roots = vec![workspace_root, cache_root.clone(), tmp_root.clone()];
        request.denied_roots = vec![home.join(".ssh"), root.join("real-project")];
        request
            .environment
            .insert("PATH".to_string(), os_to_string(path));
        request
            .environment
            .insert("HOME".to_string(), path_to_string(tmp_root.join("home")));
        request.environment.insert(
            "USERPROFILE".to_string(),
            path_to_string(tmp_root.join("home")),
        );
        request
            .environment
            .insert("TEMP".to_string(), path_to_string(tmp_root.join("tmp")));
        request
            .environment
            .insert("TMP".to_string(), path_to_string(tmp_root.join("tmp")));
        request.environment.insert(
            "NPM_CONFIG_CACHE".to_string(),
            path_to_string(cache_root.join("npm")),
        );
        request.environment.insert(
            "COREPACK_HOME".to_string(),
            path_to_string(cache_root.join("corepack")),
        );

        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn rejects_path_entries_inside_sensitive_home_denied_roots() {
        let root = fixture_root();
        let home = root.join("home");
        let mut request = valid_request();
        request.denied_roots = vec![home.join(".ssh")];
        let ssh_tool_dir = home.join(".ssh").join("bin");
        request.readable_roots.push(ssh_tool_dir.clone());
        let bad_path =
            std::env::join_paths([fixture_root().join("node").join("bin"), ssh_tool_dir]).unwrap();
        request
            .environment
            .insert("PATH".to_string(), os_to_string(bad_path));

        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn file_invocation_reads_runner_request_and_response_path() {
        let root = unique_fixture_root("file-invocation");
        fs::create_dir_all(&root).unwrap();
        let request_path = root.join("request.json");
        let response_path = root.join("response.json");
        fs::write(&request_path, serde_json::to_vec(&valid_request()).unwrap()).unwrap();

        let invocation = read_runner_invocation_from_args(&[
            OsString::from("--request-file"),
            request_path.clone().into_os_string(),
            OsString::from("--response-file"),
            response_path.clone().into_os_string(),
        ])
        .unwrap();

        assert_eq!(invocation.request.command_label, "npm run build");
        assert_eq!(invocation.response_path, Some(response_path));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_expected_windows_system_environment_outside_roots() {
        let mut request = valid_request();
        let system_root = if cfg!(target_os = "windows") {
            PathBuf::from(r"C:\Windows")
        } else {
            PathBuf::from("/Windows")
        };
        request.environment.insert(
            "SystemRoot".to_string(),
            path_to_string(system_root.clone()),
        );
        request
            .environment
            .insert("WINDIR".to_string(), path_to_string(system_root.clone()));
        request.environment.insert(
            "ComSpec".to_string(),
            path_to_string(system_root.join("System32").join("cmd.exe")),
        );

        assert!(validate_request(&request).is_ok());
    }

    #[test]
    fn refuses_to_execute_until_setup_is_real() {
        let _guard = lock_identity_override();
        let _identity = ScopedIdentityOverride::disabled();
        let response = handle_runner_request(valid_request()).unwrap();

        assert!(!response.ok);
        assert_eq!(response.state, "setup-required");
    }

    #[test]
    fn identity_override_reaches_spawn_path_without_shell_fallback() {
        let _guard = lock_identity_override();
        let _identity = ScopedIdentityOverride::enabled();

        let error = handle_runner_request(valid_request()).unwrap_err();

        assert!(error.contains("failed to spawn"));
    }

    fn valid_request() -> RunnerRequest {
        let root = fixture_root();
        let node_root = root.join("node");
        let node_bin = node_root.join("bin");
        let workspace_root = root.join("workspace");
        let cache_root = root.join("cache");
        let tmp_root = root.join("tmp");
        let path = std::env::join_paths([
            node_bin.clone(),
            workspace_root.join("node_modules").join(".bin"),
        ])
        .unwrap();

        RunnerRequest {
            schema_version: RUNNER_SCHEMA_VERSION,
            command_label: "npm run build".to_string(),
            executable: node_bin.join(if cfg!(target_os = "windows") {
                "npm.cmd"
            } else {
                "npm"
            }),
            args: vec!["run".to_string(), "build".to_string()],
            working_dir: workspace_root.clone(),
            readable_roots: vec![node_root.clone(), node_bin.clone(), workspace_root.clone()],
            writable_roots: vec![workspace_root.clone(), cache_root.clone(), tmp_root.clone()],
            denied_roots: vec![root.join("real-project"), root.join("home").join(".ssh")],
            environment: BTreeMap::from([
                ("PATH".to_string(), os_to_string(path)),
                ("HOME".to_string(), path_to_string(tmp_root.join("home"))),
                (
                    "USERPROFILE".to_string(),
                    path_to_string(tmp_root.join("home")),
                ),
                ("TEMP".to_string(), path_to_string(tmp_root.join("tmp"))),
                ("TMP".to_string(), path_to_string(tmp_root.join("tmp"))),
                (
                    "NPM_CONFIG_CACHE".to_string(),
                    path_to_string(cache_root.join("npm")),
                ),
                (
                    "COREPACK_HOME".to_string(),
                    path_to_string(cache_root.join("corepack")),
                ),
                (
                    "COREPACK_ENABLE_DOWNLOAD_PROMPT".to_string(),
                    "0".to_string(),
                ),
                ("CI".to_string(), "1".to_string()),
                ("NO_COLOR".to_string(), "1".to_string()),
            ]),
            limits: RunnerLimits {
                memory_bytes: 1024 * 1024,
                active_process_limit: 8,
                timeout_seconds: Some(60),
            },
        }
    }

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join("ncb-sandbox-runner-test")
    }

    fn path_to_string(path: PathBuf) -> String {
        path.to_string_lossy().to_string()
    }

    fn os_to_string(value: OsString) -> String {
        value.to_string_lossy().to_string()
    }

    fn unique_fixture_root(name: &str) -> PathBuf {
        fixture_root().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn identity_override_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn lock_identity_override() -> std::sync::MutexGuard<'static, ()> {
        identity_override_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct ScopedIdentityOverride {
        previous: Option<String>,
    }

    impl ScopedIdentityOverride {
        fn enabled() -> Self {
            let previous = std::env::var("NCB_SANDBOX_TEST_RUNNER_IDENTITY").ok();
            std::env::set_var("NCB_SANDBOX_TEST_RUNNER_IDENTITY", "1");
            Self { previous }
        }

        fn disabled() -> Self {
            let previous = std::env::var("NCB_SANDBOX_TEST_RUNNER_IDENTITY").ok();
            std::env::remove_var("NCB_SANDBOX_TEST_RUNNER_IDENTITY");
            Self { previous }
        }
    }

    impl Drop for ScopedIdentityOverride {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                std::env::set_var("NCB_SANDBOX_TEST_RUNNER_IDENTITY", previous);
            } else {
                std::env::remove_var("NCB_SANDBOX_TEST_RUNNER_IDENTITY");
            }
        }
    }
}
