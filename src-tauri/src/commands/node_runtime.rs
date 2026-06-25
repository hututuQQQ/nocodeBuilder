use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const NODE_DIR_ENV: &str = "NOCODE_BUILDER_NODE_DIR";
const NODE_HOST_OVERRIDE_ENV: &str = "NOCODE_BUILDER_ALLOW_HOST_NODE";
const RUNTIME_DIR_ENV: &str = "NOCODE_BUILDER_RUNTIME_DIR";
const RUNTIME_DIR_NAME: &str = "nocodeBuilder";
const NODE_RUNTIME_DIR_NAME: &str = "node";
const NODE_RUNTIME_MANIFEST_JSON: &str = include_str!("../../runtime/node-runtime-manifest.json");

static NODE_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug)]
pub struct ResolvedCommand {
    pub args: Vec<String>,
    pub executable: PathBuf,
    pub path_prepend: Vec<PathBuf>,
    pub runtime_root: PathBuf,
    pub runtime_bin: PathBuf,
    #[allow(dead_code)]
    pub runtime_version: String,
}

#[derive(Clone, Debug)]
struct NodeRuntime {
    root: PathBuf,
    version: String,
}

#[derive(Clone, Debug)]
struct NodeArchiveTarget {
    archive_extension: &'static str,
    folder_suffix: &'static str,
    archive_name: String,
    url: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeRuntimeManifest {
    node_version: String,
    targets: BTreeMap<String, NodeRuntimeManifestTarget>,
}

#[derive(Clone, Debug, Deserialize)]
struct NodeRuntimeManifestTarget {
    url: String,
    sha256: String,
}

pub fn resolve_package_manager_command(
    package_manager: &str,
    args: &[&str],
) -> Result<ResolvedCommand, String> {
    let executable_name = command_executable_name(package_manager);

    if host_node_override_enabled() && command_available(&executable_name) {
        return Ok(ResolvedCommand {
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            executable: PathBuf::from(executable_name),
            path_prepend: Vec::new(),
            runtime_root: PathBuf::new(),
            runtime_bin: PathBuf::new(),
            runtime_version: "host-override".to_string(),
        });
    }

    let runtime = ensure_managed_node_runtime()?;
    runtime.package_manager_command(package_manager, args)
}

pub fn resolve_npx_command(args: Vec<String>) -> Result<ResolvedCommand, String> {
    let executable_name = command_executable_name("npx");

    if host_node_override_enabled() && command_available(&executable_name) {
        return Ok(ResolvedCommand {
            args,
            executable: PathBuf::from(executable_name),
            path_prepend: Vec::new(),
            runtime_root: PathBuf::new(),
            runtime_bin: PathBuf::new(),
            runtime_version: "host-override".to_string(),
        });
    }

    ensure_managed_node_runtime()?.npx_command(args)
}

pub fn managed_node_version() -> Result<String, String> {
    Ok(runtime_manifest()?.node_version)
}

pub(crate) fn managed_node_runtime_parent_dir() -> Result<PathBuf, String> {
    node_runtime_parent_dir()
}

pub fn apply_runtime_environment(
    command: &mut Command,
    resolved: &ResolvedCommand,
) -> Result<(), String> {
    if resolved.path_prepend.is_empty() {
        return Ok(());
    }

    let mut paths = resolved.path_prepend.clone();

    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }

    let joined = env::join_paths(paths)
        .map_err(|error| format!("node-runtime: failed to build PATH: {error}"))?;
    command.env("PATH", joined);
    command.env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");

    Ok(())
}

fn ensure_managed_node_runtime() -> Result<NodeRuntime, String> {
    if let Some(configured_runtime) = configured_node_runtime()? {
        return Ok(configured_runtime);
    }

    let _guard = NODE_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "node-runtime: failed to lock Node.js installer".to_string())?;

    if let Some(runtime) = find_existing_node_runtime()? {
        return Ok(runtime);
    }

    install_managed_node_runtime()
}

fn configured_node_runtime() -> Result<Option<NodeRuntime>, String> {
    let Some(node_dir) = env::var_os(NODE_DIR_ENV) else {
        return Ok(None);
    };

    let manifest = runtime_manifest()?;
    let runtime = NodeRuntime {
        root: PathBuf::from(node_dir),
        version: manifest.node_version,
    };
    runtime.validate()?;

    Ok(Some(runtime))
}

fn find_existing_node_runtime() -> Result<Option<NodeRuntime>, String> {
    let manifest = runtime_manifest()?;
    let target = current_node_archive_target(&manifest)?;
    let root = node_runtime_parent_dir()?;
    let expected = root.join(format!(
        "node-{}-{}",
        manifest.node_version, target.folder_suffix
    ));

    if !expected.is_dir() {
        return Ok(None);
    }

    let runtime = NodeRuntime {
        root: expected,
        version: manifest.node_version,
    };

    if runtime.validate().is_ok() {
        return Ok(Some(runtime));
    }

    Ok(None)
}

fn install_managed_node_runtime() -> Result<NodeRuntime, String> {
    let manifest = runtime_manifest()?;
    let target = current_node_archive_target(&manifest)?;
    let parent_dir = node_runtime_parent_dir()?;
    let install_dir = parent_dir.join(format!(
        "node-{}-{}",
        manifest.node_version, target.folder_suffix
    ));

    if install_dir.is_dir() {
        let runtime = NodeRuntime {
            root: install_dir.clone(),
            version: manifest.node_version.clone(),
        };

        if runtime.validate().is_ok() {
            return Ok(runtime);
        }

        fs::remove_dir_all(&runtime.root).map_err(|error| {
            format!(
                "node-runtime: failed to remove invalid runtime '{}': {error}",
                runtime.root.display()
            )
        })?;
    }

    fs::create_dir_all(&parent_dir).map_err(|error| {
        format!(
            "node-runtime: failed to create runtime directory '{}': {error}",
            parent_dir.display()
        )
    })?;

    let archive_name = target.archive_name.clone();
    let archive_path = parent_dir.join(&archive_name);
    let temporary_archive_path = parent_dir.join(format!("{archive_name}.download"));
    let staging_dir = parent_dir.join(format!(".{}-{}-staging", archive_name, std::process::id()));

    let _ = fs::remove_file(&temporary_archive_path);
    let _ = fs::remove_dir_all(&staging_dir);
    download_file(&target.url, &temporary_archive_path)?;
    verify_sha256(&temporary_archive_path, &target.sha256)?;

    if archive_path.exists() {
        fs::remove_file(&archive_path).map_err(|error| {
            format!(
                "node-runtime: failed to replace cached archive '{}': {error}",
                archive_path.display()
            )
        })?;
    }

    fs::rename(&temporary_archive_path, &archive_path).map_err(|error| {
        format!(
            "node-runtime: failed to finalize archive '{}': {error}",
            archive_path.display()
        )
    })?;

    fs::create_dir_all(&staging_dir).map_err(|error| {
        format!(
            "node-runtime: failed to create staging directory '{}': {error}",
            staging_dir.display()
        )
    })?;

    if let Err(error) = extract_archive(&archive_path, &staging_dir, target.archive_extension) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(error);
    }

    let staged_runtime = staging_dir.join(format!(
        "node-{}-{}",
        manifest.node_version, target.folder_suffix
    ));

    if install_dir.exists() {
        fs::remove_dir_all(&install_dir).map_err(|error| {
            format!(
                "node-runtime: failed to remove existing runtime '{}': {error}",
                install_dir.display()
            )
        })?;
    }

    fs::rename(&staged_runtime, &install_dir).map_err(|error| {
        let _ = fs::remove_dir_all(&staging_dir);
        format!(
            "node-runtime: failed to finalize runtime '{}': {error}",
            install_dir.display()
        )
    })?;
    let _ = fs::remove_dir_all(&staging_dir);

    let runtime = NodeRuntime {
        root: install_dir,
        version: manifest.node_version,
    };
    runtime.validate()?;

    Ok(runtime)
}

fn download_file(url: &str, destination: &Path) -> Result<(), String> {
    let client = http_client()?;
    let mut response = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("node-runtime: failed to download Node.js from {url}: {error}"))?;
    let mut file = fs::File::create(destination).map_err(|error| {
        format!(
            "node-runtime: failed to create download '{}': {error}",
            destination.display()
        )
    })?;

    io::copy(&mut response, &mut file)
        .map_err(|error| format!("node-runtime: failed to save Node.js download: {error}"))?;
    file.flush()
        .map_err(|error| format!("node-runtime: failed to flush Node.js download: {error}"))?;

    Ok(())
}

fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "node-runtime: failed to open download for checksum '{}': {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            format!(
                "node-runtime: failed to read download for checksum '{}': {error}",
                path.display()
            )
        })?;

        if read == 0 {
            break;
        }

        hasher.update(&buffer[..read]);
    }

    let actual = format!("{:x}", hasher.finalize());

    if actual.eq_ignore_ascii_case(expected_hex) {
        return Ok(());
    }

    let _ = fs::remove_file(path);
    Err(format!(
        "node-runtime: SHA-256 mismatch for '{}': expected {expected_hex}, got {actual}",
        path.display()
    ))
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .user_agent("nocodeBuilder/0.1 Node runtime bootstrapper")
        .build()
        .map_err(|error| format!("node-runtime: failed to create HTTP client: {error}"))
}

fn extract_archive(archive_path: &Path, destination: &Path, extension: &str) -> Result<(), String> {
    match extension {
        "zip" => extract_zip_archive(archive_path, destination),
        "tar.gz" => extract_tar_gz_archive(archive_path, destination),
        _ => Err(format!(
            "node-runtime: unsupported Node.js archive type '{extension}'"
        )),
    }
}

fn extract_zip_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file = fs::File::open(archive_path).map_err(|error| {
        format!(
            "node-runtime: failed to open archive '{}': {error}",
            archive_path.display()
        )
    })?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("node-runtime: failed to read zip archive: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("node-runtime: failed to read zip entry: {error}"))?;
        let Some(relative_path) = entry
            .enclosed_name()
            .and_then(|path| safe_archive_path(path.as_path()))
        else {
            continue;
        };
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "node-runtime: refusing symlink entry '{}'",
                relative_path.display()
            ));
        }
        let output_path = destination.join(relative_path);

        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!(
                    "node-runtime: failed to create directory '{}': {error}",
                    output_path.display()
                )
            })?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "node-runtime: failed to create directory '{}': {error}",
                    parent.display()
                )
            })?;
        }

        let mut output_file = fs::File::create(&output_path).map_err(|error| {
            format!(
                "node-runtime: failed to create file '{}': {error}",
                output_path.display()
            )
        })?;
        io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("node-runtime: failed to extract zip entry: {error}"))?;
    }

    Ok(())
}

fn extract_tar_gz_archive(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let archive_file = fs::File::open(archive_path).map_err(|error| {
        format!(
            "node-runtime: failed to open archive '{}': {error}",
            archive_path.display()
        )
    })?;
    let decoder = flate2::read::GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("node-runtime: failed to read tar archive: {error}"))?;

    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("node-runtime: failed to read tar entry: {error}"))?;
        let entry_path = entry
            .path()
            .map_err(|error| format!("node-runtime: failed to read tar entry path: {error}"))?;
        let Some(relative_path) = safe_archive_path(entry_path.as_ref()) else {
            continue;
        };
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_dir() || entry_type.is_file()) {
            return Err(format!(
                "node-runtime: refusing non-file archive entry '{}'",
                relative_path.display()
            ));
        }
        let output_path = destination.join(relative_path);

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "node-runtime: failed to create directory '{}': {error}",
                    parent.display()
                )
            })?;
        }

        entry.unpack(&output_path).map_err(|error| {
            format!(
                "node-runtime: failed to extract file '{}': {error}",
                output_path.display()
            )
        })?;
    }

    Ok(())
}

fn safe_archive_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }

    if normalized.as_os_str().is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn runtime_manifest() -> Result<NodeRuntimeManifest, String> {
    serde_json::from_str(NODE_RUNTIME_MANIFEST_JSON)
        .map_err(|error| format!("node-runtime: failed to parse runtime manifest: {error}"))
}

fn host_node_override_enabled() -> bool {
    matches!(env::var(NODE_HOST_OVERRIDE_ENV), Ok(value) if value == "1")
}

fn current_node_archive_target(
    manifest: &NodeRuntimeManifest,
) -> Result<NodeArchiveTarget, String> {
    let arch = env::consts::ARCH;

    if cfg!(target_os = "windows") {
        return match arch {
            "aarch64" => archive_target(manifest, "win-arm64", "zip"),
            "x86_64" => archive_target(manifest, "win-x64", "zip"),
            _ => Err(format!(
                "node-runtime: unsupported Windows architecture '{arch}'"
            )),
        };
    }

    if cfg!(target_os = "macos") {
        return match arch {
            "aarch64" => archive_target(manifest, "darwin-arm64", "tar.gz"),
            "x86_64" => archive_target(manifest, "darwin-x64", "tar.gz"),
            _ => Err(format!(
                "node-runtime: unsupported macOS architecture '{arch}'"
            )),
        };
    }

    Err(format!(
        "node-runtime: managed Node.js is only provided for Windows and macOS, not {}",
        env::consts::OS
    ))
}

fn archive_target(
    manifest: &NodeRuntimeManifest,
    key: &'static str,
    archive_extension: &'static str,
) -> Result<NodeArchiveTarget, String> {
    let target = manifest
        .targets
        .get(key)
        .ok_or_else(|| format!("node-runtime: runtime manifest is missing target '{key}'"))?;
    let archive_name = target
        .url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("node-runtime: target '{key}' has an invalid URL"))?
        .to_string();

    Ok(NodeArchiveTarget {
        archive_extension,
        folder_suffix: key,
        archive_name,
        url: target.url.clone(),
        sha256: target.sha256.clone(),
    })
}

fn node_runtime_parent_dir() -> Result<PathBuf, String> {
    if let Some(runtime_dir) = env::var_os(RUNTIME_DIR_ENV) {
        return Ok(PathBuf::from(runtime_dir).join(NODE_RUNTIME_DIR_NAME));
    }

    Ok(default_runtime_root_dir()?.join(NODE_RUNTIME_DIR_NAME))
}

fn default_runtime_root_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join(RUNTIME_DIR_NAME));
        }

        if let Some(user_profile) = env::var_os("USERPROFILE") {
            return Ok(PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join(RUNTIME_DIR_NAME));
        }
    }

    if cfg!(target_os = "macos") {
        if let Some(home) = home_dir() {
            return Ok(home
                .join("Library")
                .join("Application Support")
                .join(RUNTIME_DIR_NAME));
        }
    }

    if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
        return Ok(PathBuf::from(data_home).join(RUNTIME_DIR_NAME));
    }

    if let Some(home) = home_dir() {
        return Ok(home.join(".local").join("share").join(RUNTIME_DIR_NAME));
    }

    Err("node-runtime: failed to resolve a local runtime directory".to_string())
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

impl NodeRuntime {
    fn validate(&self) -> Result<(), String> {
        let node = self.executable("node");
        let npm = self.executable("npm");

        if !node.is_file() {
            return Err(format!(
                "node-runtime: managed Node.js executable is missing at '{}'",
                node.display()
            ));
        }

        if !npm.is_file() {
            return Err(format!(
                "node-runtime: managed npm executable is missing at '{}'",
                npm.display()
            ));
        }

        Ok(())
    }

    fn package_manager_command(
        &self,
        package_manager: &str,
        args: &[&str],
    ) -> Result<ResolvedCommand, String> {
        match package_manager {
            "npm" => Ok(ResolvedCommand {
                args: args.iter().map(|arg| (*arg).to_string()).collect(),
                executable: self.executable("npm"),
                path_prepend: vec![self.bin_dir()],
                runtime_root: self.root.clone(),
                runtime_bin: self.bin_dir(),
                runtime_version: self.version.clone(),
            }),
            "pnpm" => {
                let corepack = self.executable("corepack");

                if !corepack.is_file() {
                    return Err(format!(
                        "node-runtime: managed Node.js at '{}' does not include corepack for pnpm",
                        self.root.display()
                    ));
                }

                let mut command_args = Vec::with_capacity(args.len() + 1);
                command_args.push("pnpm".to_string());
                command_args.extend(args.iter().map(|arg| (*arg).to_string()));

                Ok(ResolvedCommand {
                    args: command_args,
                    executable: corepack,
                    path_prepend: vec![self.bin_dir()],
                    runtime_root: self.root.clone(),
                    runtime_bin: self.bin_dir(),
                    runtime_version: self.version.clone(),
                })
            }
            _ => Err(format!(
                "node-runtime: unsupported package manager '{package_manager}'"
            )),
        }
    }

    fn npx_command(&self, args: Vec<String>) -> Result<ResolvedCommand, String> {
        Ok(ResolvedCommand {
            args,
            executable: self.executable("npx"),
            path_prepend: vec![self.bin_dir()],
            runtime_root: self.root.clone(),
            runtime_bin: self.bin_dir(),
            runtime_version: self.version.clone(),
        })
    }

    fn executable(&self, name: &str) -> PathBuf {
        if cfg!(target_os = "windows") {
            match name {
                "node" => self.root.join("node.exe"),
                _ => self.root.join(format!("{name}.cmd")),
            }
        } else {
            self.root.join("bin").join(name)
        }
    }

    fn bin_dir(&self) -> PathBuf {
        if cfg!(target_os = "windows") {
            self.root.clone()
        } else {
            self.root.join("bin")
        }
    }
}

fn command_available(executable_name: &str) -> bool {
    Command::new(executable_name)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn command_executable_name(command: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{command}.cmd")
    } else {
        command.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_archive_paths() {
        assert!(safe_archive_path(Path::new("node/bin/node")).is_some());
        assert!(safe_archive_path(Path::new("../node/bin/node")).is_none());
        assert!(safe_archive_path(Path::new("/node/bin/node")).is_none());
    }

    #[test]
    fn manifest_pins_node_version_and_targets() {
        let manifest = runtime_manifest().expect("manifest");
        assert_eq!(manifest.node_version, "v24.18.0");
        assert!(manifest.targets.contains_key("win-x64"));
        assert!(manifest.targets.contains_key("win-arm64"));
        assert!(manifest.targets.contains_key("darwin-x64"));
        assert!(manifest.targets.contains_key("darwin-arm64"));
    }
}
