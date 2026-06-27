#[cfg(not(target_os = "windows"))]
#[test]
fn windows_native_smoke_is_windows_only() {
    eprintln!("Windows native sandbox smoke test is only available on Windows.");
}

#[cfg(target_os = "windows")]
mod windows_native_smoke {
    use std::{
        collections::BTreeMap,
        ffi::OsStr,
        fs,
        io::Write,
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    use serde::{Deserialize, Serialize};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, LookupAccountNameW,
            TokenElevation, TokenUser, SID_NAME_USE, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    const SETUP_SCHEMA_VERSION: u32 = 2;
    const RUNNER_SCHEMA_VERSION: u32 = 1;
    const POLICY_VERSION: u32 = 1;
    const CREDENTIAL_SERVICE_NAME: &str = "AI Web Builder";
    const SANDBOX_ACCOUNT_PASSWORD_KEY: &str = "windows-sandbox:NCB_Sandbox:password";

    #[derive(Clone, Copy, Debug, Serialize)]
    #[serde(rename_all = "kebab-case")]
    enum SetupAction {
        Status,
        Initialize,
        Uninstall,
        HardenDependencyLayer,
        PrepareCommandWorkspace,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SetupRequest {
        schema_version: u32,
        action: SetupAction,
        sandbox_root: PathBuf,
        node_runtime_root: PathBuf,
        workspace_root: PathBuf,
        launcher_user_sid: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sandbox_account_password: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dependency_layer_root: Option<PathBuf>,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_workspace_root: Option<PathBuf>,
        policy_version: u32,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SetupResponse {
        ok: bool,
        state: String,
        message: String,
        policy_version: u32,
    }

    #[derive(Debug, Serialize)]
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

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RunnerLimits {
        memory_bytes: u64,
        active_process_limit: u32,
        timeout_seconds: Option<u64>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RunnerResponse {
        ok: bool,
        state: String,
        message: String,
        exit_code: Option<i32>,
        identity_sid: Option<String>,
    }

    #[test]
    fn windows_setup_status_runner_identity_and_wfp_smoke() {
        if std::env::var("NCB_RUN_WINDOWS_NATIVE_SMOKE").as_deref() != Ok("1") {
            eprintln!("Set NCB_RUN_WINDOWS_NATIVE_SMOKE=1 to run the destructive Windows sandbox smoke test.");
            return;
        }

        assert!(
            is_elevated(),
            "Windows native sandbox smoke test must run elevated"
        );

        let setup_exe = cargo_bin("ncb-sandbox-setup");
        let runner_exe = cargo_bin("ncb-sandbox-runner");
        let root =
            std::env::temp_dir().join(format!("ncb-windows-native-smoke-{}", std::process::id()));
        let sandbox_root = root.join("sandbox");
        let workspace_root = sandbox_root.join("workspaces");
        let dependency_layer = workspace_root
            .join("smoke-project")
            .join("dependency-layer");
        let workspace = dependency_layer.join("runs").join("run-1");
        let cache_root = sandbox_root.join("cache").join("smoke-project");
        let tmp_root = sandbox_root.join("tmp").join("run-1");
        let node_runtime_root = sandbox_root.join("runtime").join("node");
        let node_bin = node_runtime_root.join("bin");
        let real_project = root.join("real-project");
        let real_project_env = real_project.join(".env");
        let real_project_env_local = real_project.join(".env.local");
        let real_project_aibuilder = real_project.join(".aibuilder");
        let password = valid_sandbox_password();
        let mut setup_request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Initialize,
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: node_runtime_root.clone(),
            workspace_root: workspace_root.clone(),
            launcher_user_sid: Some(current_user_sid()),
            sandbox_account_password: Some(password.clone()),
            dependency_layer_root: None,
            command_workspace_root: None,
            policy_version: POLICY_VERSION,
        };
        let _cleanup = SmokeCleanup {
            setup_exe: setup_exe.clone(),
            request: setup_request.clone(),
            root: root.clone(),
        };

        fs::create_dir_all(&node_bin).expect("create fake managed node bin");
        fs::create_dir_all(dependency_layer.join("node_modules").join("smoke-package"))
            .expect("create fake dependency node_modules");
        fs::write(
            dependency_layer
                .join("node_modules")
                .join("smoke-package")
                .join("index.js"),
            "dependency_read_ok\n",
        )
        .expect("write fake dependency package");
        fs::create_dir_all(&workspace).expect("create smoke workspace");
        fs::create_dir_all(&cache_root).expect("create smoke cache root");
        fs::create_dir_all(&tmp_root).expect("create smoke tmp root");
        fs::create_dir_all(&real_project).expect("create denied real project");
        fs::write(&real_project_env, "NCB_SMOKE_SECRET_ENV=blocked\n")
            .expect("write denied real project .env");
        fs::write(
            &real_project_env_local,
            "NCB_SMOKE_SECRET_ENV_LOCAL=blocked\n",
        )
        .expect("write denied real project .env.local");
        fs::write(
            &real_project_aibuilder,
            "NCB_SMOKE_SECRET_AIBUILDER=blocked\n",
        )
        .expect("write denied real project .aibuilder");
        write_fake_npm(
            &node_bin.join("npm.cmd"),
            &real_project_env,
            &real_project_env_local,
            &real_project_aibuilder,
            &dependency_layer,
        );

        keyring::Entry::new(CREDENTIAL_SERVICE_NAME, SANDBOX_ACCOUNT_PASSWORD_KEY)
            .expect("open sandbox password credential")
            .set_password(&password)
            .expect("write sandbox password credential");

        let initialized = run_setup(&setup_exe, &setup_request);
        assert!(
            initialized.ok && initialized.state == "ready",
            "setup initialize failed: {initialized:?}"
        );

        setup_request.action = SetupAction::Status;
        setup_request.sandbox_account_password = None;
        let status = run_setup(&setup_exe, &setup_request);
        assert!(
            status.ok && status.state == "ready",
            "setup status did not verify account/credential/ACL/WFP readiness: {status:?}"
        );
        assert_eq!(status.policy_version, POLICY_VERSION);
        assert!(status.message.contains("runner launch prerequisites"));

        setup_request.action = SetupAction::HardenDependencyLayer;
        setup_request.sandbox_account_password = None;
        setup_request.dependency_layer_root = Some(dependency_layer.clone());
        setup_request.command_workspace_root = None;
        let hardened = run_setup(&setup_exe, &setup_request);
        assert!(
            hardened.ok && hardened.state == "ready",
            "dependency layer harden failed: {hardened:?}"
        );

        setup_request.action = SetupAction::PrepareCommandWorkspace;
        setup_request.command_workspace_root = Some(workspace.clone());
        let prepared_workspace = run_setup(&setup_exe, &setup_request);
        assert!(
            prepared_workspace.ok && prepared_workspace.state == "ready",
            "command workspace ACL prep failed: {prepared_workspace:?}"
        );

        let job_probe_deadline = Instant::now() + Duration::from_secs(25);
        let runner_response = run_runner(
            &runner_exe,
            &RunnerRequest {
                schema_version: RUNNER_SCHEMA_VERSION,
                command_label: "npm run build".to_string(),
                executable: node_bin.join("npm.cmd"),
                args: vec!["run".to_string(), "build".to_string()],
                working_dir: workspace.clone(),
                readable_roots: vec![
                    node_runtime_root.clone(),
                    node_bin.clone(),
                    workspace.clone(),
                    dependency_layer.join("node_modules"),
                ],
                writable_roots: vec![workspace.clone(), cache_root.clone(), tmp_root.clone()],
                denied_roots: vec![
                    root.join("real-project"),
                    user_profile_dir().join(".ssh"),
                    user_profile_dir().join(".aws"),
                ],
                environment: smoke_environment(
                    &node_bin,
                    &dependency_layer,
                    &cache_root,
                    &tmp_root,
                ),
                limits: RunnerLimits {
                    memory_bytes: 512 * 1024 * 1024,
                    active_process_limit: 16,
                    timeout_seconds: Some(15),
                },
            },
        );

        let sandbox_sid = lookup_account_sid("NCB_Sandbox");
        assert_eq!(
            runner_response.identity_sid.as_deref(),
            Some(sandbox_sid.as_str()),
            "runner did not report the NCB_Sandbox SID: {runner_response:?}"
        );

        let command_marker = fs::read_to_string(workspace.join("command.txt"))
            .expect("read sandbox command start marker");
        assert!(
            command_marker.contains("command_started"),
            "sandbox command did not start after SID verification: {command_marker}"
        );
        assert!(
            workspace.join("job-child.txt").exists(),
            "sandbox command did not start the process-tree cleanup probe"
        );
        let dependency_read = fs::read_to_string(workspace.join("dependency-read.txt"))
            .expect("read dependency read probe output");
        assert!(
            dependency_read.contains("dependency_read_ok"),
            "sandbox command could not read dependency node_modules: {dependency_read}"
        );
        let dependency_write = fs::read_to_string(workspace.join("dependency-write.txt"))
            .expect("read dependency write probe output");
        assert!(
            dependency_write.contains("dependency_write_blocked")
                && !dependency_layer
                    .join("sandbox-should-not-write.txt")
                    .exists(),
            "sandbox command wrote to dependency layer despite hardened ACL: {dependency_write}"
        );
        let sensitive_read = fs::read_to_string(workspace.join("sensitive-read.txt"))
            .expect("read sandbox sensitive path probe output");
        assert!(
            !sensitive_read.contains("NCB_SMOKE_SECRET")
                && sensitive_read.contains("sensitive_read_blocked"),
            "sandbox command read a denied real-project .env/.env.local/.aibuilder secret: {sensitive_read}"
        );

        let network = fs::read_to_string(workspace.join("network.txt")).unwrap_or_default();
        if runner_response.ok && runner_response.state == "completed" {
            assert_eq!(runner_response.exit_code, Some(0));
            assert!(runner_response.message.contains("completed"));
            assert!(
                network.contains("public_network_blocked"),
                "sandbox account was able to connect to public network: {network}"
            );
        } else if runner_response.state == "timeout" {
            assert!(
                !network.contains("public_network_allowed"),
                "sandbox account connected to public network before timeout: {network}"
            );
        } else {
            panic!(
                "sandbox runner smoke command failed: {runner_response:?}\nmarker:\n{command_marker}\nnetwork:\n{network}"
            );
        }

        wait_until(job_probe_deadline);
        assert!(
            !workspace.join("job-survivor.txt").exists(),
            "sandbox Job Object did not terminate a descendant process"
        );
    }

    fn run_setup(exe: &Path, request: &SetupRequest) -> SetupResponse {
        run_json_helper(exe, request)
    }

    fn run_runner(exe: &Path, request: &RunnerRequest) -> RunnerResponse {
        run_json_helper(exe, request)
    }

    fn run_json_helper<T, R>(exe: &Path, request: &T) -> R
    where
        T: Serialize,
        R: for<'de> Deserialize<'de>,
    {
        let payload = serde_json::to_vec(request).expect("serialize smoke request");
        let mut child = Command::new(exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| panic!("spawn helper '{}': {error}", exe.display()));
        child
            .stdin
            .take()
            .expect("helper stdin")
            .write_all(&payload)
            .expect("write helper request");
        let output = child.wait_with_output().expect("wait for helper");

        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "parse helper response from '{}': {error}\nstatus: {}\nstdout: {}\nstderr: {}",
                exe.display(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }

    fn smoke_environment(
        node_bin: &Path,
        dependency_layer: &Path,
        cache_root: &Path,
        tmp_root: &Path,
    ) -> BTreeMap<String, String> {
        let path = std::env::join_paths([
            node_bin,
            &dependency_layer.join("node_modules").join(".bin"),
        ])
        .expect("join smoke PATH");
        let system_root = std::env::var("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Windows"));
        BTreeMap::from([
            ("PATH".to_string(), path.to_string_lossy().to_string()),
            (
                "HOME".to_string(),
                tmp_root.join("home").to_string_lossy().to_string(),
            ),
            (
                "USERPROFILE".to_string(),
                tmp_root.join("home").to_string_lossy().to_string(),
            ),
            (
                "TEMP".to_string(),
                tmp_root.join("tmp").to_string_lossy().to_string(),
            ),
            (
                "TMP".to_string(),
                tmp_root.join("tmp").to_string_lossy().to_string(),
            ),
            (
                "NPM_CONFIG_CACHE".to_string(),
                cache_root.join("npm").to_string_lossy().to_string(),
            ),
            (
                "COREPACK_HOME".to_string(),
                cache_root.join("corepack").to_string_lossy().to_string(),
            ),
            (
                "COREPACK_ENABLE_DOWNLOAD_PROMPT".to_string(),
                "0".to_string(),
            ),
            ("CI".to_string(), "1".to_string()),
            ("NO_COLOR".to_string(), "1".to_string()),
            (
                "SystemRoot".to_string(),
                system_root.to_string_lossy().to_string(),
            ),
            (
                "WINDIR".to_string(),
                system_root.to_string_lossy().to_string(),
            ),
            (
                "ComSpec".to_string(),
                system_root
                    .join("System32")
                    .join("cmd.exe")
                    .to_string_lossy()
                    .to_string(),
            ),
        ])
    }

    fn write_fake_npm(
        path: &Path,
        real_project_env: &Path,
        real_project_env_local: &Path,
        real_project_aibuilder: &Path,
        dependency_layer: &Path,
    ) {
        let script = format!(
            r#"@echo off
echo command_started>command.txt
start "" /b "%ComSpec%" /c "echo job_child_started>job-child.txt & %SystemRoot%\System32\ping.exe -n 21 127.0.0.1 >NUL & echo job_object_escape>job-survivor.txt"
type "{}" > dependency-read.txt 2>dependency-read-error.txt
"%SystemRoot%\System32\findstr.exe" /C:"dependency_read_ok" dependency-read.txt >NUL 2>NUL
if %ERRORLEVEL% NEQ 0 (
  echo dependency_read_failed>>dependency-read.txt
  exit /b 25
)
(
  echo dependency_write_allowed
) > "{}" 2>dependency-write-error.txt
if exist "{}" (
  echo dependency_write_allowed>dependency-write.txt
  exit /b 24
) else (
  echo dependency_write_blocked>dependency-write.txt
)
(
  type "{}"
  type "{}"
  type "{}"
) > sensitive-read.txt 2>NUL
"%SystemRoot%\System32\findstr.exe" /C:"NCB_SMOKE_SECRET" sensitive-read.txt >NUL 2>NUL
if %ERRORLEVEL% EQU 0 (
  echo sensitive_read_allowed>>sensitive-read.txt
  exit /b 23
) else (
  echo sensitive_read_blocked>>sensitive-read.txt
)
"%SystemRoot%\System32\curl.exe" --connect-timeout 2 --max-time 5 --silent http://1.1.1.1/ -o NUL
if %ERRORLEVEL% EQU 0 (
  echo public_network_allowed>network.txt
  exit /b 22
) else (
  echo public_network_blocked>network.txt
  exit /b 0
)
"#,
            batch_path(
                &dependency_layer
                    .join("node_modules")
                    .join("smoke-package")
                    .join("index.js")
            ),
            batch_path(&dependency_layer.join("sandbox-should-not-write.txt")),
            batch_path(&dependency_layer.join("sandbox-should-not-write.txt")),
            batch_path(real_project_env),
            batch_path(real_project_env_local),
            batch_path(real_project_aibuilder)
        );
        fs::write(path, script).expect("write fake npm.cmd");
    }

    fn batch_path(path: &Path) -> String {
        path.to_string_lossy().replace('"', "")
    }

    fn wait_until(deadline: Instant) {
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
    }

    fn cargo_bin(name: &str) -> PathBuf {
        let var = format!("CARGO_BIN_EXE_{name}");
        if let Some(path) = std::env::var_os(&var).map(PathBuf::from) {
            return path;
        }

        let current_exe = std::env::current_exe().expect("resolve current test executable");
        let debug_dir = current_exe
            .parent()
            .and_then(Path::parent)
            .expect("resolve cargo target debug directory");
        let fallback = debug_dir.join(format!("{name}.exe"));
        let example_fallback = debug_dir.join("examples").join(format!("{name}.exe"));
        let sidecar_fallback = debug_dir
            .parent()
            .expect("resolve cargo target directory")
            .join("sidecars")
            .join("debug")
            .join(format!("{name}.exe"));

        for candidate in [&example_fallback, &sidecar_fallback, &fallback] {
            if candidate.is_file() {
                return candidate.to_path_buf();
            }
        }

        assert!(
            fallback.is_file(),
            "{var} was not set by cargo and fallback binaries '{}', '{}', or '{}' do not exist",
            fallback.display(),
            example_fallback.display(),
            sidecar_fallback.display()
        );
        fallback
    }

    fn valid_sandbox_password() -> String {
        "Qz7!2026abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
            .chars()
            .take(56)
            .collect()
    }

    fn user_profile_dir() -> PathBuf {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("missing-userprofile"))
    }

    fn is_elevated() -> bool {
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
        if opened == 0 {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut returned = 0u32;
        let queried = unsafe {
            GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut _ as *mut _,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        };
        unsafe {
            CloseHandle(token);
        }

        queried != 0 && elevation.TokenIsElevated != 0
    }

    fn current_user_sid() -> String {
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
        assert!(opened != 0, "open process token for user SID");

        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        }
        assert!(needed > 0, "size process token user SID");

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
        assert!(queried != 0, "read process token user SID");

        let token_user = unsafe { &*(token_info.as_ptr() as *const TOKEN_USER) };
        sid_to_string(token_user.User.Sid)
    }

    fn lookup_account_sid(account: &str) -> String {
        let account = wide_null(account);
        let mut sid_size = 0u32;
        let mut domain_size = 0u32;
        let mut sid_name_use: SID_NAME_USE = 0;

        unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                std::ptr::null_mut(),
                &mut sid_size,
                std::ptr::null_mut(),
                &mut domain_size,
                &mut sid_name_use,
            );
        }
        assert!(sid_size > 0, "size account SID");

        let mut sid = vec![0u8; sid_size as usize];
        let mut domain = vec![0u16; domain_size as usize];
        let found = unsafe {
            LookupAccountNameW(
                std::ptr::null(),
                account.as_ptr(),
                sid.as_mut_ptr().cast(),
                &mut sid_size,
                domain.as_mut_ptr(),
                &mut domain_size,
                &mut sid_name_use,
            )
        };
        assert!(found != 0, "lookup account SID");

        sid_to_string(sid.as_mut_ptr().cast())
    }

    fn sid_to_string(sid: *mut core::ffi::c_void) -> String {
        let mut string_sid = std::ptr::null_mut();
        let converted = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };
        assert!(
            converted != 0 && !string_sid.is_null(),
            "convert SID to string"
        );

        let value = wide_ptr_to_string(string_sid).expect("valid SID string");
        unsafe {
            LocalFree(string_sid.cast());
        }
        value
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

    fn wide_null(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain([0]).collect()
    }

    struct SmokeCleanup {
        setup_exe: PathBuf,
        request: SetupRequest,
        root: PathBuf,
    }

    impl Drop for SmokeCleanup {
        fn drop(&mut self) {
            let mut request = self.request.clone();
            request.action = SetupAction::Uninstall;
            request.sandbox_account_password = None;
            let _ = std::panic::catch_unwind(|| run_setup(&self.setup_exe, &request));
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
