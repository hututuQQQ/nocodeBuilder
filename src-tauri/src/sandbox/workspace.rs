use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::types::{SandboxError, SandboxErrorKind};

const SANDBOX_DIR_NAME: &str = "nocodeBuilder";
const MAX_WRITE_BACK_BYTES: u64 = 10 * 1024 * 1024;
const SOURCE_MANIFEST_VERSION: u32 = 1;
const WRITE_BACK_FILES: [&str; 3] = ["package-lock.json", "pnpm-lock.yaml", "next-env.d.ts"];

#[derive(Clone, Debug)]
pub struct SandboxWorkspace {
    pub project_id: String,
    pub kind: SandboxWorkspaceKind,
    pub workspace_root: PathBuf,
    pub cache_root: PathBuf,
    pub tmp_root: PathBuf,
    pub source_manifest_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxWorkspaceKind {
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

#[derive(Clone, Debug, Default)]
pub struct SandboxWorkspaceManager;

impl SandboxWorkspaceManager {
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
        let run_id = unique_workspace_id(match kind {
            SandboxWorkspaceKind::Run => "run",
            SandboxWorkspaceKind::DevServer => "dev",
        });
        let workspace_root = sandbox_root
            .join("workspaces")
            .join(project_id)
            .join(match kind {
                SandboxWorkspaceKind::Run => "runs",
                SandboxWorkspaceKind::DevServer => "dev",
            })
            .join(&run_id);
        let cache_root = sandbox_root.join("cache").join(project_id);
        let tmp_root = sandbox_root.join("tmp").join(project_id).join(&run_id);
        let state_root = sandbox_root.join("state").join(project_id);
        let source_manifest_path = state_root.join(format!("{run_id}-source-manifest.json"));

        remove_child_dir_if_exists(&sandbox_root, &workspace_root)?;
        fs::create_dir_all(&workspace_root)?;
        fs::create_dir_all(&cache_root)?;
        fs::create_dir_all(&tmp_root)?;
        fs::create_dir_all(&state_root)?;

        let workspace = SandboxWorkspace {
            project_id: project_id.to_string(),
            kind,
            workspace_root,
            cache_root,
            tmp_root,
            source_manifest_path,
        };
        workspace.sync_source_changes_from(project_dir)?;

        Ok(workspace)
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

    pub fn write_back_allowed_outputs(
        &self,
        project_dir: &Path,
    ) -> Result<Vec<String>, SandboxError> {
        let mut written = Vec::new();

        for relative in WRITE_BACK_FILES {
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

            fs::copy(&source, &target)?;
            written.push(relative.to_string());
        }

        Ok(written)
    }
}

pub fn sync_project_to_workspace(
    project_dir: &Path,
    workspace_root: &Path,
) -> Result<(), SandboxError> {
    sync_project_to_workspace_with_manifest(project_dir, workspace_root, None)
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
        assert!(is_excluded_relative(Path::new(".aibuilder/project.json")));
        assert!(is_excluded_relative(Path::new(".env.local")));
        assert!(is_excluded_relative(Path::new("app/.env.production")));
        assert!(is_excluded_relative(Path::new(
            "node_modules/react/index.js"
        )));
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
        fs::create_dir_all(project.join("node_modules")).unwrap();
        fs::create_dir_all(project.join("app")).unwrap();
        fs::write(project.join(".aibuilder").join("project.json"), "{}").unwrap();
        fs::write(project.join(".env"), "SECRET=1").unwrap();
        fs::write(project.join("node_modules").join("dep.js"), "").unwrap();
        fs::write(project.join("app").join("page.tsx"), "export default null").unwrap();
        fs::create_dir_all(&workspace).unwrap();

        sync_project_to_workspace(&project, &workspace).unwrap();

        assert!(workspace.join("app").join("page.tsx").is_file());
        assert!(!workspace.join(".aibuilder").exists());
        assert!(!workspace.join(".env").exists());
        assert!(!workspace.join("node_modules").exists());

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
        fs::create_dir_all(workspace_root.join("node_modules")).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::write(project.join("app").join("page.tsx"), "one").unwrap();
        fs::write(project.join("app").join("removed.tsx"), "remove me").unwrap();
        fs::write(workspace_root.join("node_modules").join("dep.js"), "dep").unwrap();

        let workspace = SandboxWorkspace {
            project_id: "test".to_string(),
            kind: SandboxWorkspaceKind::DevServer,
            workspace_root: workspace_root.clone(),
            cache_root: root.join("cache"),
            tmp_root: root.join("tmp"),
            source_manifest_path: state.join("source-manifest.json"),
        };

        workspace.sync_source_changes_from(&project).unwrap();
        fs::remove_file(project.join("app").join("removed.tsx")).unwrap();
        fs::write(project.join(".env"), "SECRET=1").unwrap();
        workspace.sync_source_changes_from(&project).unwrap();

        assert!(workspace_root.join("app").join("page.tsx").is_file());
        assert!(!workspace_root.join("app").join("removed.tsx").exists());
        assert!(workspace_root.join("node_modules").join("dep.js").is_file());
        assert!(!workspace_root.join(".env").exists());

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
                    .join("dev")
                    .join(dev_workspace.workspace_root.file_name().unwrap())
            ));
            assert!(run_workspace.workspace_root.ends_with(
                Path::new("project1")
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
