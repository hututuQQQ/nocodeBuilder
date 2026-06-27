use std::{
    collections::BTreeMap,
    fs,
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::types::{SandboxError, SandboxErrorKind};

const SANDBOX_DIR_NAME: &str = "nocodeBuilder";
const DEPENDENCY_LAYER_DIR_NAME: &str = "dependency-layer";
const MAX_WRITE_BACK_BYTES: u64 = 10 * 1024 * 1024;
const SOURCE_MANIFEST_VERSION: u32 = 1;
const DEPENDENCY_FINGERPRINT_VERSION: u32 = 1;
const KNOWN_WRITE_BACK_FILES: [&str; 3] = ["package-lock.json", "pnpm-lock.yaml", "next-env.d.ts"];
const DEPENDENCY_INPUT_FILES: [&str; 3] = ["package.json", "package-lock.json", "pnpm-lock.yaml"];

#[derive(Clone, Debug)]
pub struct SandboxWorkspace {
    pub project_id: String,
    pub kind: SandboxWorkspaceKind,
    pub workspace_root: PathBuf,
    pub dependency_root: PathBuf,
    pub cache_root: PathBuf,
    pub tmp_root: PathBuf,
    pub source_manifest_path: PathBuf,
    pub dependency_fingerprint_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxWorkspaceKind {
    Install,
    Run,
    DevServer,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifest {
    version: u32,
    files: BTreeMap<String, SourceFileSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceFileSnapshot {
    len: u64,
    modified_millis: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyFingerprint {
    version: u32,
    package_manager: String,
    managed_node_version: String,
    files: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug)]
struct SandboxProjectPaths {
    dependency_root: PathBuf,
    dependency_fingerprint_path: PathBuf,
}

impl SandboxProjectPaths {
    fn resolve(project_id: &str) -> Result<Self, SandboxError> {
        validate_project_id(project_id)?;
        let sandbox_root = sandbox_root_dir()?;
        fs::create_dir_all(&sandbox_root)?;
        let sandbox_root = sandbox_root.canonicalize()?;

        Ok(Self {
            dependency_root: sandbox_root
                .join("workspaces")
                .join(project_id)
                .join(DEPENDENCY_LAYER_DIR_NAME),
            dependency_fingerprint_path: sandbox_root
                .join("state")
                .join(project_id)
                .join("dependency-fingerprint.json"),
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct SandboxWorkspaceManager;

impl SandboxWorkspaceManager {
    pub fn prepare_install(
        &self,
        project_id: &str,
        project_dir: &Path,
    ) -> Result<SandboxWorkspace, SandboxError> {
        self.prepare_workspace(project_id, project_dir, SandboxWorkspaceKind::Install)
    }

    pub fn prepare_run(
        &self,
        project_id: &str,
        project_dir: &Path,
    ) -> Result<SandboxWorkspace, SandboxError> {
        self.prepare_workspace(project_id, project_dir, SandboxWorkspaceKind::Run)
    }

    pub fn prepare_dev_server(
        &self,
        project_id: &str,
        project_dir: &Path,
    ) -> Result<SandboxWorkspace, SandboxError> {
        self.prepare_workspace(project_id, project_dir, SandboxWorkspaceKind::DevServer)
    }

    fn prepare_workspace(
        &self,
        project_id: &str,
        project_dir: &Path,
        kind: SandboxWorkspaceKind,
    ) -> Result<SandboxWorkspace, SandboxError> {
        validate_project_id(project_id)?;
        let sandbox_root = sandbox_root_dir()?;
        fs::create_dir_all(&sandbox_root)?;
        let sandbox_root = sandbox_root.canonicalize()?;
        let project_workspace_root = sandbox_root.join("workspaces").join(project_id);
        let dependency_root = project_workspace_root.join(DEPENDENCY_LAYER_DIR_NAME);
        let run_id = unique_workspace_id(match kind {
            SandboxWorkspaceKind::Install => "install",
            SandboxWorkspaceKind::Run => "run",
            SandboxWorkspaceKind::DevServer => "dev",
        });
        let workspace_root = match kind {
            SandboxWorkspaceKind::Install => dependency_root.clone(),
            SandboxWorkspaceKind::Run => dependency_root.join("runs").join(&run_id),
            SandboxWorkspaceKind::DevServer => dependency_root.join("dev").join(&run_id),
        };
        let cache_root = sandbox_root.join("cache").join(project_id);
        let tmp_root = sandbox_root.join("tmp").join(project_id).join(&run_id);
        let state_root = sandbox_root.join("state").join(project_id);
        let source_manifest_path = state_root.join(format!("{run_id}-source-manifest.json"));
        let dependency_fingerprint_path = state_root.join("dependency-fingerprint.json");

        if kind != SandboxWorkspaceKind::Install {
            remove_child_dir_if_exists(&sandbox_root, &workspace_root)?;
        }
        fs::create_dir_all(&dependency_root)?;
        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&cache_root)?;
        fs::create_dir_all(&tmp_root)?;
        fs::create_dir_all(&state_root)?;

        let workspace = SandboxWorkspace {
            project_id: project_id.to_string(),
            kind,
            workspace_root,
            dependency_root,
            cache_root,
            tmp_root,
            source_manifest_path,
            dependency_fingerprint_path,
        };
        match kind {
            SandboxWorkspaceKind::Install => workspace.sync_dependency_inputs_from(project_dir)?,
            SandboxWorkspaceKind::Run | SandboxWorkspaceKind::DevServer => {
                workspace.sync_source_changes_from(project_dir)?;
            }
        }

        Ok(workspace)
    }

    pub fn ensure_dependency_layer_current(
        &self,
        project_id: &str,
        project_dir: &Path,
        package_manager: &str,
        managed_node_version: &str,
    ) -> Result<(), SandboxError> {
        let paths = SandboxProjectPaths::resolve(project_id)?;
        ensure_dependency_layer_current(
            &paths.dependency_root,
            &paths.dependency_fingerprint_path,
            project_dir,
            package_manager,
            managed_node_version,
        )
    }

    pub fn reset_project(&self, project_id: &str) -> Result<(), SandboxError> {
        validate_project_id(project_id)?;
        let sandbox_root = sandbox_root_dir()?;
        fs::create_dir_all(&sandbox_root)?;
        let sandbox_root = sandbox_root.canonicalize()?;

        for child in [
            sandbox_root.join("workspaces").join(project_id),
            sandbox_root.join("cache").join(project_id),
            sandbox_root.join("tmp").join(project_id),
            sandbox_root.join("state").join(project_id),
        ] {
            remove_child_dir_if_exists(&sandbox_root, &child)?;
        }

        Ok(())
    }
}

impl SandboxWorkspace {
    pub fn cleanup_tmp(&self) {
        let _ = fs::remove_dir_all(&self.tmp_root);
        let _ = fs::remove_file(&self.source_manifest_path);
        if let Some(parent) = self.source_manifest_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    pub fn cleanup_after_command(&self) {
        self.cleanup_tmp();

        if self.kind == SandboxWorkspaceKind::Run {
            let _ = fs::remove_dir_all(&self.workspace_root);
            remove_empty_workspace_ancestors(&self.workspace_root);
        }
    }

    pub fn cleanup_after_dev_server(&self) {
        self.cleanup_tmp();
        let _ = fs::remove_dir_all(&self.workspace_root);
        remove_empty_workspace_ancestors(&self.workspace_root);
    }

    pub fn sync_source_changes_from(&self, project_dir: &Path) -> Result<(), SandboxError> {
        sync_project_to_workspace_with_manifest(
            project_dir,
            &self.workspace_root,
            Some(&self.source_manifest_path),
        )
    }

    pub fn sync_dependency_inputs_from(&self, project_dir: &Path) -> Result<(), SandboxError> {
        sync_dependency_inputs_to_layer(project_dir, &self.dependency_root)
    }

    pub fn mark_dependency_layer_current(
        &self,
        project_dir: &Path,
        package_manager: &str,
        managed_node_version: &str,
    ) -> Result<(), SandboxError> {
        mark_dependency_layer_current(
            &self.dependency_root,
            &self.dependency_fingerprint_path,
            project_dir,
            package_manager,
            managed_node_version,
        )
    }

    pub fn dependency_node_modules(&self) -> PathBuf {
        self.dependency_root.join("node_modules")
    }

    pub fn dependency_node_bin(&self) -> PathBuf {
        self.dependency_node_modules().join(".bin")
    }

    pub fn write_back_allowed_outputs(
        &self,
        project_dir: &Path,
        allowed_files: &[&str],
    ) -> Result<Vec<String>, SandboxError> {
        let mut written = Vec::new();

        for relative in allowed_files {
            let relative = *relative;
            validate_write_back_relative(relative)?;
            let source = self.workspace_root.join(relative);

            if !source.exists() {
                continue;
            }

            let source = source.canonicalize()?;
            ensure_child_path(&self.workspace_root.canonicalize()?, &source)?;

            let metadata = fs::metadata(&source)?;
            if !metadata.is_file() {
                continue;
            }

            if metadata.len() > MAX_WRITE_BACK_BYTES {
                return Err(SandboxError::new(
                    SandboxErrorKind::PolicyDenied,
                    format!("refusing to write back oversized sandbox output '{relative}'"),
                ));
            }

            let target = project_dir.join(relative);
            let parent = target
                .parent()
                .ok_or_else(|| SandboxError::policy_denied("invalid write-back target"))?;
            fs::create_dir_all(parent)?;
            ensure_child_path(&project_dir.canonicalize()?, &parent.canonicalize()?)?;

            write_back_file_atomically(&source, &target, relative)?;
            written.push(relative.to_string());
        }

        Ok(written)
    }
}

fn validate_write_back_relative(relative: &str) -> Result<(), SandboxError> {
    if KNOWN_WRITE_BACK_FILES.contains(&relative) && is_simple_relative_file(relative) {
        return Ok(());
    }

    Err(SandboxError::policy_denied(format!(
        "refusing to write back non-policy sandbox output '{relative}'"
    )))
}

fn is_simple_relative_file(relative: &str) -> bool {
    let mut components = Path::new(relative).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

pub fn sync_project_to_workspace(
    project_dir: &Path,
    workspace_root: &Path,
) -> Result<(), SandboxError> {
    sync_project_to_workspace_with_manifest(project_dir, workspace_root, None)
}

fn sync_dependency_inputs_to_layer(
    project_dir: &Path,
    dependency_root: &Path,
) -> Result<(), SandboxError> {
    let project_dir = project_dir.canonicalize()?;
    ensure_safe_directory(dependency_root)?;
    let dependency_root = dependency_root.canonicalize()?;

    for relative in DEPENDENCY_INPUT_FILES {
        let source = project_dir.join(relative);
        let destination = dependency_root.join(relative);

        match fs::symlink_metadata(&source) {
            Ok(metadata) => {
                if is_forbidden_link(&metadata) {
                    return Err(SandboxError::policy_denied(format!(
                        "refusing to copy linked or reparse-point dependency input '{relative}'"
                    )));
                }

                if !metadata.is_file() {
                    return Err(SandboxError::policy_denied(format!(
                        "refusing to copy non-file dependency input '{relative}'"
                    )));
                }

                let canonical_source = source.canonicalize()?;
                ensure_child_path(&project_dir, &canonical_source)?;
                inspect_destination_file(&destination)?;
                fs::copy(&source, &destination)?;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                remove_dependency_input_if_present(&destination)?;
            }
            Err(error) => return Err(error.into()),
        }
    }

    Ok(())
}

fn remove_dependency_input_if_present(path: &Path) -> Result<(), SandboxError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if is_forbidden_link(&metadata) || !metadata.is_file() {
        return Err(SandboxError::policy_denied(format!(
            "refusing to remove unsafe dependency input '{}'",
            path.display()
        )));
    }

    fs::remove_file(path)?;
    Ok(())
}

fn mark_dependency_layer_current(
    dependency_root: &Path,
    fingerprint_path: &Path,
    project_dir: &Path,
    package_manager: &str,
    managed_node_version: &str,
) -> Result<(), SandboxError> {
    ensure_dependency_node_modules_is_directory(dependency_root)?;
    let fingerprint = dependency_fingerprint(project_dir, package_manager, managed_node_version)?;
    save_dependency_fingerprint(fingerprint_path, &fingerprint)
}

fn ensure_dependency_layer_current(
    dependency_root: &Path,
    fingerprint_path: &Path,
    project_dir: &Path,
    package_manager: &str,
    managed_node_version: &str,
) -> Result<(), SandboxError> {
    ensure_dependency_node_modules_is_directory(dependency_root)?;
    let expected = dependency_fingerprint(project_dir, package_manager, managed_node_version)?;
    let actual = load_dependency_fingerprint(fingerprint_path)?;

    if actual == expected {
        return Ok(());
    }

    Err(stale_dependency_layer_error(package_manager))
}

fn ensure_dependency_node_modules_is_directory(dependency_root: &Path) -> Result<(), SandboxError> {
    let node_modules = dependency_root.join("node_modules");
    let metadata = match fs::symlink_metadata(&node_modules) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(missing_dependency_layer_error())
        }
        Err(error) => return Err(error.into()),
    };

    if is_forbidden_link(&metadata) {
        return Err(SandboxError::policy_denied(format!(
            "sandbox dependency layer node_modules '{}' is a link or reparse point",
            node_modules.display()
        )));
    }

    if metadata.is_dir() {
        Ok(())
    } else {
        Err(SandboxError::policy_denied(format!(
            "sandbox dependency layer node_modules '{}' is not a directory",
            node_modules.display()
        )))
    }
}

fn dependency_fingerprint(
    project_dir: &Path,
    package_manager: &str,
    managed_node_version: &str,
) -> Result<DependencyFingerprint, SandboxError> {
    let mut files = BTreeMap::new();

    for relative in DEPENDENCY_INPUT_FILES {
        files.insert(
            relative.to_string(),
            dependency_input_hash(project_dir, relative)?,
        );
    }

    Ok(DependencyFingerprint {
        version: DEPENDENCY_FINGERPRINT_VERSION,
        package_manager: package_manager.to_string(),
        managed_node_version: managed_node_version.to_string(),
        files,
    })
}

fn dependency_input_hash(
    project_dir: &Path,
    relative: &str,
) -> Result<Option<String>, SandboxError> {
    let path = project_dir.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    if is_forbidden_link(&metadata) || !metadata.is_file() {
        return Err(SandboxError::policy_denied(format!(
            "refusing to fingerprint unsafe dependency input '{relative}'"
        )));
    }

    let content = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(content);
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn load_dependency_fingerprint(path: &Path) -> Result<DependencyFingerprint, SandboxError> {
    let content = fs::read(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            missing_dependency_layer_error()
        } else {
            error.into()
        }
    })?;
    let fingerprint: DependencyFingerprint = serde_json::from_slice(&content).map_err(|error| {
        SandboxError::policy_denied(format!("invalid sandbox dependency fingerprint: {error}"))
    })?;

    if fingerprint.version != DEPENDENCY_FINGERPRINT_VERSION {
        return Err(stale_dependency_layer_error(&fingerprint.package_manager));
    }

    Ok(fingerprint)
}

fn save_dependency_fingerprint(
    path: &Path,
    fingerprint: &DependencyFingerprint,
) -> Result<(), SandboxError> {
    let parent = path
        .parent()
        .ok_or_else(|| SandboxError::policy_denied("invalid dependency fingerprint path"))?;
    fs::create_dir_all(parent)?;
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_vec(fingerprint).map_err(|error| {
        SandboxError::unavailable(format!(
            "failed to serialize dependency fingerprint: {error}"
        ))
    })?;

    fs::write(&temp_path, content)?;
    replace_file(&temp_path, path)?;
    Ok(())
}

fn missing_dependency_layer_error() -> SandboxError {
    SandboxError::policy_denied(
        "sandbox dependency layer is missing; run npm install or pnpm install before build/dev/test/lint",
    )
}

fn stale_dependency_layer_error(package_manager: &str) -> SandboxError {
    SandboxError::policy_denied(format!(
        "sandbox dependency layer is stale; run {package_manager} install before build/dev/test/lint"
    ))
}

fn sync_project_to_workspace_with_manifest(
    project_dir: &Path,
    workspace_root: &Path,
    manifest_path: Option<&Path>,
) -> Result<(), SandboxError> {
    let project_dir = project_dir.canonicalize()?;
    let workspace_root = workspace_root.canonicalize()?;
    let previous_manifest = manifest_path
        .map(load_source_manifest)
        .transpose()?
        .unwrap_or_default();
    let mut next_files = BTreeMap::new();

    copy_dir_contents(
        &project_dir,
        &project_dir,
        &workspace_root,
        Path::new(""),
        &previous_manifest.files,
        &mut next_files,
    )?;

    if let Some(manifest_path) = manifest_path {
        remove_deleted_manifest_files(&workspace_root, &previous_manifest.files, &next_files)?;
        save_source_manifest(
            manifest_path,
            &SourceManifest {
                version: SOURCE_MANIFEST_VERSION,
                files: next_files,
            },
        )?;
    }

    Ok(())
}

fn copy_dir_contents(
    source_root: &Path,
    current_source: &Path,
    current_destination: &Path,
    relative: &Path,
    previous_files: &BTreeMap<String, SourceFileSnapshot>,
    next_files: &mut BTreeMap<String, SourceFileSnapshot>,
) -> Result<(), SandboxError> {
    ensure_safe_directory(current_destination)?;

    for entry in fs::read_dir(current_source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let relative_child = relative.join(&file_name);

        if is_excluded_relative(&relative_child) {
            continue;
        }

        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path)?;

        if is_forbidden_link(&metadata) {
            return Err(SandboxError::policy_denied(format!(
                "refusing to copy linked or reparse-point path '{}'",
                path_to_slash(&relative_child)
            )));
        }

        let canonical_source = source_path.canonicalize()?;
        ensure_child_path(source_root, &canonical_source)?;
        let destination = current_destination.join(file_name);

        if metadata.is_dir() {
            copy_dir_contents(
                source_root,
                &source_path,
                &destination,
                &relative_child,
                previous_files,
                next_files,
            )?;
        } else if metadata.is_file() {
            let manifest_key = relative_to_manifest_key(&relative_child)?;
            let snapshot = SourceFileSnapshot::from_metadata(&metadata);
            let destination_state = inspect_destination_file(&destination)?;

            next_files.insert(manifest_key.clone(), snapshot.clone());

            if previous_files.get(&manifest_key) != Some(&snapshot)
                || !matches!(destination_state, DestinationFileState::File)
            {
                if let Some(parent) = destination.parent() {
                    ensure_safe_directory(parent)?;
                }
                fs::copy(&source_path, &destination)?;
            }
        }
    }

    Ok(())
}

fn load_source_manifest(path: &Path) -> Result<SourceManifest, SandboxError> {
    if !path.exists() {
        return Ok(SourceManifest {
            version: SOURCE_MANIFEST_VERSION,
            files: BTreeMap::new(),
        });
    }

    let content = fs::read(path)?;
    let manifest: SourceManifest = serde_json::from_slice(&content).map_err(|error| {
        SandboxError::policy_denied(format!("invalid sandbox source manifest: {error}"))
    })?;

    if manifest.version != SOURCE_MANIFEST_VERSION {
        return Err(SandboxError::policy_denied(
            "unsupported sandbox source manifest version",
        ));
    }

    for relative in manifest.files.keys() {
        validate_manifest_relative_path(relative)?;
    }

    Ok(manifest)
}

fn save_source_manifest(path: &Path, manifest: &SourceManifest) -> Result<(), SandboxError> {
    let parent = path
        .parent()
        .ok_or_else(|| SandboxError::policy_denied("invalid source manifest path"))?;
    fs::create_dir_all(parent)?;
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_vec(manifest).map_err(|error| {
        SandboxError::unavailable(format!("failed to serialize source manifest: {error}"))
    })?;

    fs::write(&temp_path, content)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temp_path, path)?;
    Ok(())
}

fn write_back_file_atomically(
    source: &Path,
    target: &Path,
    relative: &str,
) -> Result<(), SandboxError> {
    reject_unsafe_write_back_target(target, relative)?;
    let parent = target
        .parent()
        .ok_or_else(|| SandboxError::policy_denied("invalid write-back target"))?;
    let file_name = target
        .file_name()
        .ok_or_else(|| SandboxError::policy_denied("invalid write-back target"))?
        .to_string_lossy();
    let temp_path = parent.join(format!(
        ".{file_name}.ncb-write-{}-{}.tmp",
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));

    copy_to_new_regular_file(source, &temp_path)?;
    reject_unsafe_write_back_target(target, relative)?;
    replace_file(&temp_path, target).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        error
    })
}

fn reject_unsafe_write_back_target(target: &Path, relative: &str) -> Result<(), SandboxError> {
    let metadata = match fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };

    if is_forbidden_link(&metadata) {
        return Err(SandboxError::policy_denied(format!(
            "refusing to write back '{relative}' through a symlink or reparse point"
        )));
    }

    if metadata.is_file() {
        return Ok(());
    }

    Err(SandboxError::policy_denied(format!(
        "refusing to write back '{relative}' over a non-file target"
    )))
}

fn copy_to_new_regular_file(source: &Path, destination: &Path) -> Result<(), SandboxError> {
    let mut input = fs::File::open(source)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    Ok(())
}

fn replace_file(source: &Path, target: &Path) -> Result<(), SandboxError> {
    #[cfg(target_os = "windows")]
    {
        match fs::symlink_metadata(target) {
            Ok(metadata) => {
                if is_forbidden_link(&metadata) || !metadata.is_file() {
                    return Err(SandboxError::policy_denied(format!(
                        "refusing to replace unsafe target '{}'",
                        target.display()
                    )));
                }
                fs::remove_file(target)?;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }

    fs::rename(source, target)?;
    Ok(())
}

fn remove_deleted_manifest_files(
    workspace_root: &Path,
    previous_files: &BTreeMap<String, SourceFileSnapshot>,
    next_files: &BTreeMap<String, SourceFileSnapshot>,
) -> Result<(), SandboxError> {
    for relative in previous_files.keys() {
        if next_files.contains_key(relative) {
            continue;
        }

        let relative_path = validate_manifest_relative_path(relative)?;
        let destination = workspace_root.join(&relative_path);

        let metadata = match fs::symlink_metadata(&destination) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if is_forbidden_link(&metadata) {
            return Err(SandboxError::policy_denied(format!(
                "refusing to remove linked or reparse-point sandbox path '{}'",
                relative
            )));
        }

        if !metadata.is_file() {
            return Err(SandboxError::policy_denied(format!(
                "refusing to remove non-file sandbox path '{}'",
                relative
            )));
        }

        let canonical_destination = destination.canonicalize()?;
        ensure_child_path(workspace_root, &canonical_destination)?;
        fs::remove_file(&destination)?;

        if let Some(parent) = destination.parent() {
            remove_empty_ancestors(workspace_root, parent)?;
        }
    }

    Ok(())
}

fn remove_empty_ancestors(workspace_root: &Path, start: &Path) -> Result<(), SandboxError> {
    let mut current = start.to_path_buf();

    while current != workspace_root {
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        };
        if is_forbidden_link(&metadata) {
            return Err(SandboxError::policy_denied(format!(
                "refusing to inspect linked sandbox directory '{}'",
                current.display()
            )));
        }

        if !metadata.is_dir() || fs::remove_dir(&current).is_err() {
            break;
        }

        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.to_path_buf();
    }

    Ok(())
}

fn ensure_safe_directory(path: &Path) -> Result<(), SandboxError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_forbidden_link(&metadata) {
                return Err(SandboxError::policy_denied(format!(
                    "refusing to use linked or reparse-point sandbox directory '{}'",
                    path.display()
                )));
            }
            if !metadata.is_dir() {
                return Err(SandboxError::policy_denied(format!(
                    "refusing to use non-directory sandbox path '{}'",
                    path.display()
                )));
            }
            return Ok(());
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    if let Some(parent) = path.parent() {
        ensure_safe_directory(parent)?;
    }

    fs::create_dir(path)?;
    Ok(())
}

enum DestinationFileState {
    Missing,
    File,
}

fn inspect_destination_file(destination: &Path) -> Result<DestinationFileState, SandboxError> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(DestinationFileState::Missing)
        }
        Err(error) => return Err(error.into()),
    };

    if is_forbidden_link(&metadata) {
        return Err(SandboxError::policy_denied(format!(
            "refusing to overwrite linked or reparse-point sandbox path '{}'",
            destination.display()
        )));
    }

    if metadata.is_file() {
        return Ok(DestinationFileState::File);
    }

    Err(SandboxError::policy_denied(format!(
        "refusing to overwrite non-file sandbox path '{}'",
        destination.display()
    )))
}

impl SourceFileSnapshot {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified_millis: metadata.modified().ok().and_then(|modified| {
                modified
                    .duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
            }),
        }
    }
}

fn validate_manifest_relative_path(relative: &str) -> Result<PathBuf, SandboxError> {
    let path = PathBuf::from(relative);

    if relative.is_empty()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_)) || component.as_os_str().is_empty()
        })
        || is_excluded_relative(&path)
    {
        return Err(SandboxError::policy_denied(
            "invalid relative path in sandbox source manifest",
        ));
    }

    Ok(path)
}

fn relative_to_manifest_key(path: &Path) -> Result<String, SandboxError> {
    let mut parts = Vec::new();

    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(SandboxError::policy_denied(
                "invalid source path for sandbox manifest",
            ));
        };
        let part = part.to_str().ok_or_else(|| {
            SandboxError::policy_denied("source path is not valid UTF-8 for sandbox manifest")
        })?;
        parts.push(part);
    }

    if parts.is_empty() {
        return Err(SandboxError::policy_denied(
            "empty source path for sandbox manifest",
        ));
    }

    Ok(parts.join("/"))
}

fn is_excluded_relative(path: &Path) -> bool {
    let mut components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str());

    components.any(|part| {
        matches!(
            part,
            ".aibuilder" | ".git" | "node_modules" | ".next" | "dist" | "build" | "coverage"
        ) || part == ".env"
            || part.starts_with(".env.")
    })
}

fn is_forbidden_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

fn remove_child_dir_if_exists(parent: &Path, child: &Path) -> Result<(), SandboxError> {
    if !child.exists() {
        return Ok(());
    }

    let child = child.canonicalize()?;
    ensure_child_path(parent, &child)?;
    fs::remove_dir_all(child)?;
    Ok(())
}

fn remove_empty_workspace_ancestors(workspace_root: &Path) {
    let mut current = workspace_root.parent();

    while let Some(path) = current {
        let Some(file_name) = path.file_name().and_then(|part| part.to_str()) else {
            break;
        };

        if !matches!(file_name, "runs" | "dev") {
            break;
        }

        if fs::remove_dir(path).is_err() {
            break;
        }

        current = path.parent();
    }
}

fn unique_workspace_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    format!(
        "{}-{}-{}-{}",
        prefix,
        std::process::id(),
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn ensure_child_path(parent: &Path, child: &Path) -> Result<(), SandboxError> {
    if child.starts_with(parent) {
        return Ok(());
    }

    Err(SandboxError::policy_denied(
        "sandbox path escaped its parent",
    ))
}

fn validate_project_id(project_id: &str) -> Result<(), SandboxError> {
    if project_id.is_empty()
        || !project_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(SandboxError::policy_denied("invalid sandbox project id"));
    }

    Ok(())
}

pub(crate) fn sandbox_root_dir() -> Result<PathBuf, SandboxError> {
    if let Some(override_dir) = std::env::var_os("NOCODE_BUILDER_SANDBOX_DIR") {
        return Ok(PathBuf::from(override_dir));
    }

    if cfg!(target_os = "windows") {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data)
                .join(SANDBOX_DIR_NAME)
                .join("sandbox"));
        }
    }

    if cfg!(target_os = "macos") {
        if let Some(home) = home_dir() {
            return Ok(home
                .join("Library")
                .join("Application Support")
                .join(SANDBOX_DIR_NAME)
                .join("sandbox"));
        }
    }

    if let Some(home) = home_dir() {
        return Ok(home
            .join(".local")
            .join("share")
            .join(SANDBOX_DIR_NAME)
            .join("sandbox"));
    }

    Err(SandboxError::unavailable(
        "failed to resolve nocodeBuilder sandbox directory",
    ))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn path_to_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn excludes_sensitive_and_generated_paths() {
        for excluded in [
            ".aibuilder/project.json",
            ".git/config",
            ".env",
            ".env.local",
            "app/.env.production",
            "node_modules/react/index.js",
            ".next/server/app.js",
            "dist/client.js",
            "build/server.js",
            "coverage/lcov.info",
        ] {
            assert!(
                is_excluded_relative(Path::new(excluded)),
                "expected '{excluded}' to be excluded from sandbox source sync"
            );
        }
        assert!(!is_excluded_relative(Path::new("app/page.tsx")));
    }

    #[test]
    fn rejects_invalid_project_ids() {
        assert!(validate_project_id("../escape").is_err());
        assert!(validate_project_id("project one").is_err());
        assert!(validate_project_id("project_one-2").is_ok());
    }

    #[test]
    fn sync_omits_forbidden_files() {
        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-workspace-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace = root.join("workspace");
        fs::create_dir_all(project.join(".aibuilder")).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join("node_modules")).unwrap();
        fs::create_dir_all(project.join(".next")).unwrap();
        fs::create_dir_all(project.join("dist")).unwrap();
        fs::create_dir_all(project.join("build")).unwrap();
        fs::create_dir_all(project.join("coverage")).unwrap();
        fs::create_dir_all(project.join("app")).unwrap();
        fs::write(project.join(".aibuilder").join("project.json"), "{}").unwrap();
        fs::write(project.join(".git").join("config"), "[remote]").unwrap();
        fs::write(project.join(".env"), "SECRET=1").unwrap();
        fs::write(project.join("node_modules").join("dep.js"), "").unwrap();
        fs::write(project.join(".next").join("server.js"), "generated").unwrap();
        fs::write(project.join("dist").join("client.js"), "generated").unwrap();
        fs::write(project.join("build").join("server.js"), "generated").unwrap();
        fs::write(project.join("coverage").join("lcov.info"), "generated").unwrap();
        fs::write(project.join("app").join("page.tsx"), "export default null").unwrap();
        fs::create_dir_all(&workspace).unwrap();

        sync_project_to_workspace(&project, &workspace).unwrap();

        assert!(workspace.join("app").join("page.tsx").is_file());
        for excluded in [
            ".aibuilder",
            ".git",
            ".env",
            "node_modules",
            ".next",
            "dist",
            "build",
            "coverage",
        ] {
            assert!(
                !workspace.join(excluded).exists(),
                "expected '{excluded}' to be omitted from sandbox workspace"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incremental_sync_removes_only_previous_source_files() {
        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-workspace-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        let state = root.join("state");
        fs::create_dir_all(project.join("app")).unwrap();
        for generated_dir in ["node_modules", ".next", "dist", "build", "coverage"] {
            fs::create_dir_all(workspace_root.join(generated_dir)).unwrap();
        }
        fs::create_dir_all(&state).unwrap();
        fs::write(project.join("app").join("page.tsx"), "one").unwrap();
        fs::write(project.join("app").join("removed.tsx"), "remove me").unwrap();
        for generated in [
            ("node_modules", "dep.js"),
            (".next", "server.js"),
            ("dist", "bundle.js"),
            ("build", "output.js"),
            ("coverage", "lcov.info"),
        ] {
            fs::write(
                workspace_root.join(generated.0).join(generated.1),
                "sandbox-generated",
            )
            .unwrap();
        }

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::DevServer,
            workspace_root: workspace_root.clone(),
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: state.join("source-manifest.json"),
            dependency_fingerprint_path: state.join("dependency-fingerprint.json"),
        };

        workspace.sync_source_changes_from(&project).unwrap();
        fs::remove_file(project.join("app").join("removed.tsx")).unwrap();
        fs::create_dir_all(project.join(".aibuilder")).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::create_dir_all(project.join("node_modules")).unwrap();
        fs::create_dir_all(project.join(".next")).unwrap();
        fs::create_dir_all(project.join("dist")).unwrap();
        fs::create_dir_all(project.join("build")).unwrap();
        fs::create_dir_all(project.join("coverage")).unwrap();
        fs::write(project.join(".env"), "SECRET=1").unwrap();
        fs::write(project.join(".aibuilder").join("project.json"), "{}").unwrap();
        fs::write(project.join(".git").join("config"), "[remote]").unwrap();
        fs::write(project.join("node_modules").join("dep.js"), "project dep").unwrap();
        fs::write(project.join(".next").join("server.js"), "project build").unwrap();
        fs::write(project.join("dist").join("bundle.js"), "project build").unwrap();
        fs::write(project.join("build").join("output.js"), "project build").unwrap();
        fs::write(project.join("coverage").join("lcov.info"), "project build").unwrap();
        workspace.sync_source_changes_from(&project).unwrap();

        assert!(workspace_root.join("app").join("page.tsx").is_file());
        assert!(!workspace_root.join("app").join("removed.tsx").exists());
        assert!(!workspace_root.join(".env").exists());
        assert!(!workspace_root.join(".aibuilder").exists());
        assert!(!workspace_root.join(".git").exists());
        for generated in [
            ("node_modules", "dep.js"),
            (".next", "server.js"),
            ("dist", "bundle.js"),
            ("build", "output.js"),
            ("coverage", "lcov.info"),
        ] {
            assert_eq!(
                fs::read_to_string(workspace_root.join(generated.0).join(generated.1)).unwrap(),
                "sandbox-generated",
                "expected sandbox-generated '{}' output to survive source sync",
                generated.0
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_back_only_copies_requested_policy_files() {
        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-write-back-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(workspace_root.join("dist")).unwrap();
        fs::write(project.join("package.json"), "{\"name\":\"real\"}").unwrap();
        fs::write(workspace_root.join("package-lock.json"), "{\"lock\":true}").unwrap();
        fs::write(workspace_root.join("pnpm-lock.yaml"), "lockfileVersion: 9").unwrap();
        fs::write(workspace_root.join("next-env.d.ts"), "/// <reference />").unwrap();
        fs::write(
            workspace_root.join("package.json"),
            "{\"name\":\"sandbox\"}",
        )
        .unwrap();
        fs::write(workspace_root.join("dist").join("bundle.js"), "generated").unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::Run,
            workspace_root,
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
            dependency_fingerprint_path: root.join("state").join("dependency-fingerprint.json"),
        };

        let written = workspace
            .write_back_allowed_outputs(&project, &["package-lock.json"])
            .unwrap();

        assert_eq!(written, vec!["package-lock.json".to_string()]);
        assert_eq!(
            fs::read_to_string(project.join("package-lock.json")).unwrap(),
            "{\"lock\":true}"
        );
        assert!(!project.join("pnpm-lock.yaml").exists());
        assert!(!project.join("next-env.d.ts").exists());
        assert_eq!(
            fs::read_to_string(project.join("package.json")).unwrap(),
            "{\"name\":\"real\"}"
        );
        assert!(!project.join("dist").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_back_rejects_oversized_allowed_file_without_overwriting_project() {
        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-write-back-size-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        fs::write(project.join("package-lock.json"), "real lock").unwrap();
        let oversized_lock = workspace_root.join("package-lock.json");
        fs::File::create(&oversized_lock)
            .unwrap()
            .set_len(MAX_WRITE_BACK_BYTES + 1)
            .unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::Run,
            workspace_root,
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
            dependency_fingerprint_path: root.join("state").join("dependency-fingerprint.json"),
        };

        let error = workspace
            .write_back_allowed_outputs(&project, &["package-lock.json"])
            .expect_err("oversized sandbox output should be rejected");

        assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
        assert!(error.message.contains("oversized sandbox output"));
        assert_eq!(
            fs::read_to_string(project.join("package-lock.json")).unwrap(),
            "real lock"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_back_rejects_non_policy_file_names() {
        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-write-back-policy-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        fs::write(project.join("package.json"), "{\"name\":\"real\"}").unwrap();
        fs::write(
            workspace_root.join("package.json"),
            "{\"name\":\"sandbox\"}",
        )
        .unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::Run,
            workspace_root,
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
            dependency_fingerprint_path: root.join("state").join("dependency-fingerprint.json"),
        };

        let error = workspace
            .write_back_allowed_outputs(&project, &["package.json"])
            .expect_err("package.json should not be a write-back output");

        assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
        assert!(error.message.contains("non-policy sandbox output"));
        assert_eq!(
            fs::read_to_string(project.join("package.json")).unwrap(),
            "{\"name\":\"real\"}"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn write_back_rejects_project_symlink_target_without_modifying_link_destination() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-write-back-symlink-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        let outside = root.join("outside-lock.json");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        fs::write(&outside, "outside lock").unwrap();
        symlink(&outside, project.join("package-lock.json")).unwrap();
        fs::write(workspace_root.join("package-lock.json"), "sandbox lock").unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::Run,
            workspace_root,
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
            dependency_fingerprint_path: root.join("state").join("dependency-fingerprint.json"),
        };

        let error = workspace
            .write_back_allowed_outputs(&project, &["package-lock.json"])
            .expect_err("symlink write-back target should be rejected");

        assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
        assert!(error.message.contains("symlink") || error.message.contains("reparse"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside lock");

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn write_back_rejects_windows_reparse_target_when_symlink_creation_is_available() {
        use std::os::windows::fs::symlink_file;

        let root = std::env::temp_dir().join(format!(
            "ncb-sandbox-write-back-reparse-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("project");
        let workspace_root = root.join("workspace");
        let outside = root.join("outside-lock.json");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&workspace_root).unwrap();
        fs::write(&outside, "outside lock").unwrap();

        match symlink_file(&outside, project.join("package-lock.json")) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::PermissionDenied | ErrorKind::Unsupported
                ) || error.raw_os_error() == Some(1314) =>
            {
                let _ = fs::remove_dir_all(root);
                return;
            }
            Err(error) => panic!("unexpected symlink creation error: {error}"),
        }

        fs::write(workspace_root.join("package-lock.json"), "sandbox lock").unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::Run,
            workspace_root,
            dependency_root: root.join("dependency-layer"),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: root.join("state").join("source-manifest.json"),
            dependency_fingerprint_path: root.join("state").join("dependency-fingerprint.json"),
        };

        let error = workspace
            .write_back_allowed_outputs(&project, &["package-lock.json"])
            .expect_err("Windows reparse-point write-back target should be rejected");

        assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
        assert!(error.message.contains("symlink") || error.message.contains("reparse"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside lock");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn run_and_dev_workspaces_do_not_delete_each_other() {
        with_sandbox_root("ncb-sandbox-workspace-lifecycle", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(project.join("src")).unwrap();
            fs::write(project.join("package.json"), "{}").unwrap();
            fs::write(project.join("src").join("main.ts"), "export {};").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let dev_workspace = manager.prepare_dev_server("project1", &project).unwrap();
            fs::write(dev_workspace.workspace_root.join("dev-marker.txt"), "dev").unwrap();
            let run_workspace = manager.prepare_run("project1", &project).unwrap();

            assert_ne!(dev_workspace.workspace_root, run_workspace.workspace_root);
            assert!(dev_workspace.workspace_root.ends_with(
                Path::new("project1")
                    .join(DEPENDENCY_LAYER_DIR_NAME)
                    .join("dev")
                    .join(dev_workspace.workspace_root.file_name().unwrap())
            ));
            assert!(run_workspace.workspace_root.ends_with(
                Path::new("project1")
                    .join(DEPENDENCY_LAYER_DIR_NAME)
                    .join("runs")
                    .join(run_workspace.workspace_root.file_name().unwrap())
            ));
            assert!(dev_workspace
                .workspace_root
                .join("dev-marker.txt")
                .is_file());

            run_workspace.cleanup_after_command();
            assert!(!run_workspace.workspace_root.exists());
            assert!(dev_workspace
                .workspace_root
                .join("dev-marker.txt")
                .is_file());

            dev_workspace.cleanup_after_dev_server();
            assert!(!dev_workspace.workspace_root.exists());
        });
    }

    #[test]
    fn repeated_run_workspaces_are_unique() {
        with_sandbox_root("ncb-sandbox-workspace-runs", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(project.join("src")).unwrap();
            fs::write(project.join("src").join("main.ts"), "export {};").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let first = manager.prepare_run("project1", &project).unwrap();
            fs::write(first.workspace_root.join("first-marker.txt"), "first").unwrap();
            let second = manager.prepare_run("project1", &project).unwrap();

            assert_ne!(first.workspace_root, second.workspace_root);
            assert!(first.workspace_root.join("first-marker.txt").is_file());
            assert!(second.workspace_root.join("src").join("main.ts").is_file());

            first.cleanup_after_command();
            second.cleanup_after_command();
        });
    }

    #[test]
    fn install_dependency_layer_survives_command_cleanup() {
        with_sandbox_root("ncb-sandbox-dependency-persist", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("package.json"), "{\"scripts\":{}}").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let workspace = manager.prepare_install("project1", &project).unwrap();
            fs::create_dir_all(workspace.dependency_node_bin()).unwrap();
            fs::write(workspace.dependency_node_bin().join("vite"), "").unwrap();
            let dependency_root = workspace.dependency_root.clone();

            workspace.cleanup_after_command();

            assert!(dependency_root.join("node_modules").is_dir());
            assert!(dependency_root
                .join("node_modules")
                .join(".bin")
                .join("vite")
                .is_file());
        });
    }

    #[test]
    fn dependency_layer_missing_fails_closed() {
        with_sandbox_root("ncb-sandbox-dependency-missing", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("package.json"), "{\"scripts\":{}}").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let error = manager
                .ensure_dependency_layer_current("project1", &project, "npm", "v-test")
                .expect_err("missing dependency layer should fail");

            assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
            assert!(error.message.contains("dependency layer is missing"));
        });
    }

    #[test]
    fn dependency_fingerprint_changes_when_package_inputs_change() {
        with_sandbox_root("ncb-sandbox-dependency-stale", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("package.json"), "{\"dependencies\":{}}").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let workspace = manager.prepare_install("project1", &project).unwrap();
            fs::create_dir_all(workspace.dependency_node_modules()).unwrap();
            workspace
                .mark_dependency_layer_current(&project, "npm", "v-test")
                .unwrap();

            manager
                .ensure_dependency_layer_current("project1", &project, "npm", "v-test")
                .unwrap();

            fs::write(
                project.join("package.json"),
                "{\"dependencies\":{\"left-pad\":\"1.3.0\"}}",
            )
            .unwrap();
            let error = manager
                .ensure_dependency_layer_current("project1", &project, "npm", "v-test")
                .expect_err("changed package.json should stale dependency layer");

            assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
            assert!(error.message.contains("dependency layer is stale"));
        });
    }

    #[test]
    fn dependency_fingerprint_changes_when_lockfile_changes() {
        with_sandbox_root("ncb-sandbox-dependency-lock-stale", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("package.json"), "{\"dependencies\":{}}").unwrap();
            fs::write(project.join("package-lock.json"), "{\"lockfileVersion\":3}").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let workspace = manager.prepare_install("project1", &project).unwrap();
            fs::create_dir_all(workspace.dependency_node_modules()).unwrap();
            workspace
                .mark_dependency_layer_current(&project, "npm", "v-test")
                .unwrap();

            fs::write(project.join("package-lock.json"), "{\"lockfileVersion\":4}").unwrap();
            let error = manager
                .ensure_dependency_layer_current("project1", &project, "npm", "v-test")
                .expect_err("changed lockfile should stale dependency layer");

            assert_eq!(error.kind, SandboxErrorKind::PolicyDenied);
            assert!(error.message.contains("dependency layer is stale"));
        });
    }

    #[test]
    fn reset_project_removes_dependency_layer() {
        with_sandbox_root("ncb-sandbox-dependency-reset", |sandbox_root| {
            let project = sandbox_root.join("real-project");
            fs::create_dir_all(&project).unwrap();
            fs::write(project.join("package.json"), "{\"scripts\":{}}").unwrap();

            let manager = SandboxWorkspaceManager::default();
            let workspace = manager.prepare_install("project1", &project).unwrap();
            fs::create_dir_all(workspace.dependency_node_modules()).unwrap();
            let dependency_root = workspace.dependency_root.clone();

            manager.reset_project("project1").unwrap();

            assert!(!dependency_root.exists());
        });
    }

    fn with_sandbox_root(prefix: &str, run: impl FnOnce(&Path)) {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let old_sandbox_dir = std::env::var_os("NOCODE_BUILDER_SANDBOX_DIR");
        let root = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::env::set_var("NOCODE_BUILDER_SANDBOX_DIR", &root);

        run(&root);

        if let Some(value) = old_sandbox_dir {
            std::env::set_var("NOCODE_BUILDER_SANDBOX_DIR", value);
        } else {
            std::env::remove_var("NOCODE_BUILDER_SANDBOX_DIR");
        }
        let _ = fs::remove_dir_all(root);
    }
}
