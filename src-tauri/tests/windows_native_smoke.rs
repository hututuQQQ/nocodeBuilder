#[cfg(not(target_os = "windows"))]
#[test]
fn windows_native_smoke_is_windows_only() {
    eprintln!("Windows native sandbox smoke test is only available on Windows.");
}

#[cfg(target_os = "windows")]
mod windows_native_smoke {
    use std::{
        collections::BTreeMap,
        fs,
        io::Write,
        path::{Path, PathBuf},
        process::{Command, Stdio},
    };

    use serde::{Deserialize, Serialize};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenElevation, TokenUser,
            TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    const SETUP_SCHEMA_VERSION: u32 = 1;
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
        let workspace = workspace_root
            .join("smoke-project")
            .join("runs")
            .join("run-1");
        let cache_root = sandbox_root.join("cache").join("smoke-project");
        let tmp_root = sandbox_root.join("tmp").join("run-1");
        let node_runtime_root = sandbox_root.join("runtime").join("node");
        let node_bin = node_runtime_root.join("bin");
        let password = valid_sandbox_password();
        let mut setup_request = SetupRequest {
            schema_version: SETUP_SCHEMA_VERSION,
            action: SetupAction::Initialize,
            sandbox_root: sandbox_root.clone(),
            node_runtime_root: node_runtime_root.clone(),
            workspace_root: workspace_root.clone(),
            launcher_user_sid: Some(current_user_sid()),
            sandbox_account_password: Some(password.clone()),
            policy_version: POLICY_VERSION,
        };
        let _cleanup = SmokeCleanup {
            setup_exe: setup_exe.clone(),
            request: setup_request.clone(),
            root: root.clone(),
        };

        fs::create_dir_all(&node_bin).expect("create fake managed node bin");
        fs::create_dir_all(&workspace).expect("create smoke workspace");
        fs::create_dir_all(&cache_root).expect("create smoke cache root");
        fs::create_dir_all(&tmp_root).expect("create smoke tmp root");
        write_fake_npm(&node_bin.join("npm.cmd"));

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
                    workspace.join("node_modules").join(".bin"),
                ],
                writable_roots: vec![workspace.clone(), cache_root.clone(), tmp_root.clone()],
                denied_roots: vec![
                    root.join("real-project"),
                    user_profile_dir().join(".ssh"),
                    user_profile_dir().join(".aws"),
                ],
                environment: smoke_environment(&node_bin, &workspace, &cache_root, &tmp_root),
                limits: RunnerLimits {
                    memory_bytes: 512 * 1024 * 1024,
                    active_process_limit: 16,
                    timeout_seconds: Some(20),
                },
            },
        );
        assert!(
            runner_response.ok && runner_response.state == "completed",
            "sandbox runner smoke command failed: {runner_response:?}"
        );
        assert_eq!(runner_response.exit_code, Some(0));
        assert!(runner_response.message.contains("completed"));

        let identity = fs::read_to_string(workspace.join("whoami.txt"))
            .expect("read sandbox runner identity output")
            .to_ascii_lowercase();
        assert!(
            identity.contains("ncb_sandbox"),
            "runner did not execute as NCB_Sandbox: {identity}"
        );

        let network = fs::read_to_string(workspace.join("network.txt"))
            .expect("read sandbox network probe output");
        assert!(
            network.contains("public_network_blocked"),
            "sandbox account was able to connect to public network: {network}"
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
        workspace: &Path,
        cache_root: &Path,
        tmp_root: &Path,
    ) -> BTreeMap<String, String> {
        let path = std::env::join_paths([node_bin, &workspace.join("node_modules").join(".bin")])
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

    fn write_fake_npm(path: &Path) {
        let script = r#"@echo off
whoami > whoami.txt
echo USERNAME=%USERNAME%>>whoami.txt
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "try { $client = [Net.Sockets.TcpClient]::new(); $task = $client.ConnectAsync('1.1.1.1', 443); if ($task.Wait(1500) -and $client.Connected) { 'public_network_allowed' | Set-Content -Encoding ASCII network.txt; $client.Close(); exit 22 } else { 'public_network_blocked' | Set-Content -Encoding ASCII network.txt; exit 0 } } catch { 'public_network_blocked' | Set-Content -Encoding ASCII network.txt; exit 0 }"
exit /b %ERRORLEVEL%
"#;
        fs::write(path, script).expect("write fake npm.cmd");
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
        assert!(
            fallback.is_file(),
            "{var} was not set by cargo and fallback binary '{}' does not exist",
            fallback.display()
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
