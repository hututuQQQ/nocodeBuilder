use std::{
    env, fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::Deserialize;

const NODE_DIST_BASE_URL: &str = "https://nodejs.org/dist";
const NODE_DIST_INDEX_URL: &str = "https://nodejs.org/dist/index.json";
const NODE_DIR_ENV: &str = "NOCODE_BUILDER_NODE_DIR";
const RUNTIME_DIR_ENV: &str = "NOCODE_BUILDER_RUNTIME_DIR";
const RUNTIME_DIR_NAME: &str = "nocodeBuilder";
const NODE_RUNTIME_DIR_NAME: &str = "node";

static NODE_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug)]
pub struct ResolvedCommand {
    pub args: Vec<String>,
    pub executable: PathBuf,
    pub path_prepend: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct NodeRuntime {
    root: PathBuf,
}

#[derive(Clone, Debug)]
struct NodeArchiveTarget {
    archive_extension: &'static str,
    file_id: &'static str,
    folder_suffix: &'static str,
}

#[derive(Debug, Deserialize)]
struct NodeRelease {
    files: Vec<String>,
    lts: serde_json::Value,
    version: String,
}

pub fn resolve_package_manager_command(
    package_manager: &str,
    args: &[&str],
) -> Result<ResolvedCommand, String> {
    let executable_name = command_executable_name(package_manager);

    if command_available(&executable_name) {
        return Ok(ResolvedCommand {
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            executable: PathBuf::from(executable_name),
            path_prepend: Vec::new(),
        });
    }

    let runtime = ensure_managed_node_runtime()?;
    runtime.package_manager_command(package_manager, args)
}

pub fn resolve_npx_command(args: Vec<String>) -> Result<ResolvedCommand, String> {
    let executable_name = command_executable_name("npx");

    if command_available(&executable_name) {
        return Ok(ResolvedCommand {
            args,
            executable: PathBuf::from(executable_name),
            path_prepend: Vec::new(),
        });
    }

    ensure_managed_node_runtime()?.npx_command(args)
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

    let runtime = NodeRuntime {
        root: PathBuf::from(node_dir),
    };
    runtime.validate()?;

    Ok(Some(runtime))
}

fn find_existing_node_runtime() -> Result<Option<NodeRuntime>, String> {
    let root = node_runtime_parent_dir()?;

    if !root.is_dir() {
        return Ok(None);
    }

    let mut candidates = fs::read_dir(&root)
        .map_err(|error| {
            format!(
                "node-runtime: failed to inspect runtime directory '{}': {error}",
                root.display()
            )
        })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("node-v"))
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| right.cmp(left));

    for candidate in candidates {
        let runtime = NodeRuntime { root: candidate };

        if runtime.validate().is_ok() {
            return Ok(Some(runtime));
        }
    }

    Ok(None)
}

fn install_managed_node_runtime() -> Result<NodeRuntime, String> {
    let target = current_node_archive_target()?;
    let release = fetch_latest_lts_release(&target)?;
    let parent_dir = node_runtime_parent_dir()?;
    let install_dir = parent_dir.join(format!("node-{}-{}", release.version, target.folder_suffix));

    if install_dir.is_dir() {
        let runtime = NodeRuntime {
            root: install_dir.clone(),
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

    let archive_name = format!(
        "node-{}-{}.{}",
        release.version, target.folder_suffix, target.archive_extension
    );
    let archive_url = format!(
        "{}/{}/{}",
        NODE_DIST_BASE_URL, release.version, archive_name
    );
    let archive_path = parent_dir.join(&archive_name);
    let temporary_archive_path = parent_dir.join(format!("{archive_name}.download"));

    download_file(&archive_url, &temporary_archive_path)?;

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

    extract_archive(&archive_path, &parent_dir, target.archive_extension)?;

    let runtime = NodeRuntime { root: install_dir };
    runtime.validate()?;

    Ok(runtime)
}

fn fetch_latest_lts_release(target: &NodeArchiveTarget) -> Result<NodeRelease, String> {
    let client = http_client()?;
    let releases = client
        .get(NODE_DIST_INDEX_URL)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("node-runtime: failed to fetch Node.js release index: {error}"))?
        .json::<Vec<NodeRelease>>()
        .map_err(|error| format!("node-runtime: failed to parse Node.js release index: {error}"))?;

    releases
        .into_iter()
        .find(|release| {
            is_lts_release(&release.lts) && release.files.iter().any(|file| file == target.file_id)
        })
        .ok_or_else(|| {
            format!(
                "node-runtime: no current Node.js LTS release provides {}",
                target.file_id
            )
        })
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

fn is_lts_release(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::String(value) => !value.trim().is_empty(),
        _ => false,
    }
}

fn current_node_archive_target() -> Result<NodeArchiveTarget, String> {
    let arch = env::consts::ARCH;

    if cfg!(target_os = "windows") {
        return match arch {
            "aarch64" => Ok(NodeArchiveTarget {
                archive_extension: "zip",
                file_id: "win-arm64-zip",
                folder_suffix: "win-arm64",
            }),
            "x86" => Ok(NodeArchiveTarget {
                archive_extension: "zip",
                file_id: "win-x86-zip",
                folder_suffix: "win-x86",
            }),
            "x86_64" => Ok(NodeArchiveTarget {
                archive_extension: "zip",
                file_id: "win-x64-zip",
                folder_suffix: "win-x64",
            }),
            _ => Err(format!(
                "node-runtime: unsupported Windows architecture '{arch}'"
            )),
        };
    }

    if cfg!(target_os = "macos") {
        return match arch {
            "aarch64" => Ok(NodeArchiveTarget {
                archive_extension: "tar.gz",
                file_id: "osx-arm64-tar",
                folder_suffix: "osx-arm64",
            }),
            "x86_64" => Ok(NodeArchiveTarget {
                archive_extension: "tar.gz",
                file_id: "osx-x64-tar",
                folder_suffix: "osx-x64",
            }),
            _ => Err(format!(
                "node-runtime: unsupported macOS architecture '{arch}'"
            )),
        };
    }

    if cfg!(target_os = "linux") {
        return match arch {
            "aarch64" => Ok(NodeArchiveTarget {
                archive_extension: "tar.gz",
                file_id: "linux-arm64",
                folder_suffix: "linux-arm64",
            }),
            "arm" => Ok(NodeArchiveTarget {
                archive_extension: "tar.gz",
                file_id: "linux-armv7l",
                folder_suffix: "linux-armv7l",
            }),
            "x86_64" => Ok(NodeArchiveTarget {
                archive_extension: "tar.gz",
                file_id: "linux-x64",
                folder_suffix: "linux-x64",
            }),
            _ => Err(format!(
                "node-runtime: unsupported Linux architecture '{arch}'"
            )),
        };
    }

    Err(format!(
        "node-runtime: automatic Node.js installation is not supported on {}",
        env::consts::OS
    ))
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
    fn identifies_lts_release_shapes() {
        assert!(is_lts_release(&serde_json::json!("Hydrogen")));
        assert!(is_lts_release(&serde_json::json!(true)));
        assert!(!is_lts_release(&serde_json::json!(false)));
        assert!(!is_lts_release(&serde_json::json!("")));
    }
}
