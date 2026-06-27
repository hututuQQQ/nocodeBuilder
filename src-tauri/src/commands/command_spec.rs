#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandPurposeSpec {
    Install,
    Build,
    Test,
    Lint,
    DevServer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandNetworkSpec {
    Denied,
    LocalServer,
    ManagedProxy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandWriteBackSpec {
    None,
    AllowedGeneratedFiles,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CommandResourceSpec {
    pub(crate) timeout_seconds: Option<u64>,
    pub(crate) memory_bytes: u64,
    pub(crate) active_process_limit: u32,
    pub(crate) max_output_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CommandSpec {
    pub(crate) label: &'static str,
    pub(crate) package_manager: &'static str,
    pub(crate) app_args: &'static [&'static str],
    pub(crate) runner_args: &'static [&'static str],
    pub(crate) purpose: CommandPurposeSpec,
    pub(crate) network: CommandNetworkSpec,
    pub(crate) limits: CommandResourceSpec,
    pub(crate) write_back: CommandWriteBackSpec,
}

const GIB: u64 = 1024 * 1024 * 1024;

pub(crate) const MANAGED_PROXY_ALLOWED_HOSTS: &[&str] = &[
    "registry.npmjs.org",
    "*.npmjs.org",
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "nodejs.org",
];

pub(crate) const COMMAND_SPECS: &[CommandSpec] = &[
    CommandSpec {
        label: "npm install",
        package_manager: "npm",
        app_args: &["install"],
        runner_args: &["install"],
        purpose: CommandPurposeSpec::Install,
        network: CommandNetworkSpec::ManagedProxy,
        limits: CommandResourceSpec {
            timeout_seconds: Some(10 * 60),
            memory_bytes: 2 * GIB,
            active_process_limit: 256,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::AllowedGeneratedFiles,
    },
    CommandSpec {
        label: "npm run dev",
        package_manager: "npm",
        app_args: &["run", "dev"],
        runner_args: &["run", "dev"],
        purpose: CommandPurposeSpec::DevServer,
        network: CommandNetworkSpec::LocalServer,
        limits: CommandResourceSpec {
            timeout_seconds: None,
            memory_bytes: 2 * GIB,
            active_process_limit: 256,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "npm run build",
        package_manager: "npm",
        app_args: &["run", "build"],
        runner_args: &["run", "build"],
        purpose: CommandPurposeSpec::Build,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(5 * 60),
            memory_bytes: 2 * GIB,
            active_process_limit: 128,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::AllowedGeneratedFiles,
    },
    CommandSpec {
        label: "npm run lint",
        package_manager: "npm",
        app_args: &["run", "lint"],
        runner_args: &["run", "lint"],
        purpose: CommandPurposeSpec::Lint,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(3 * 60),
            memory_bytes: GIB,
            active_process_limit: 64,
            max_output_bytes: 128 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "npm run test",
        package_manager: "npm",
        app_args: &["run", "test"],
        runner_args: &["run", "test"],
        purpose: CommandPurposeSpec::Test,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(5 * 60),
            memory_bytes: GIB + (GIB / 2),
            active_process_limit: 128,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "npm test",
        package_manager: "npm",
        app_args: &["test"],
        runner_args: &["test"],
        purpose: CommandPurposeSpec::Test,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(5 * 60),
            memory_bytes: GIB + (GIB / 2),
            active_process_limit: 128,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "pnpm install",
        package_manager: "pnpm",
        app_args: &["install"],
        runner_args: &["pnpm", "install"],
        purpose: CommandPurposeSpec::Install,
        network: CommandNetworkSpec::ManagedProxy,
        limits: CommandResourceSpec {
            timeout_seconds: Some(10 * 60),
            memory_bytes: 2 * GIB,
            active_process_limit: 256,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::AllowedGeneratedFiles,
    },
    CommandSpec {
        label: "pnpm dev",
        package_manager: "pnpm",
        app_args: &["dev"],
        runner_args: &["pnpm", "dev"],
        purpose: CommandPurposeSpec::DevServer,
        network: CommandNetworkSpec::LocalServer,
        limits: CommandResourceSpec {
            timeout_seconds: None,
            memory_bytes: 2 * GIB,
            active_process_limit: 256,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "pnpm build",
        package_manager: "pnpm",
        app_args: &["build"],
        runner_args: &["pnpm", "build"],
        purpose: CommandPurposeSpec::Build,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(5 * 60),
            memory_bytes: 2 * GIB,
            active_process_limit: 128,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::AllowedGeneratedFiles,
    },
    CommandSpec {
        label: "pnpm lint",
        package_manager: "pnpm",
        app_args: &["lint"],
        runner_args: &["pnpm", "lint"],
        purpose: CommandPurposeSpec::Lint,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(3 * 60),
            memory_bytes: GIB,
            active_process_limit: 64,
            max_output_bytes: 128 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
    CommandSpec {
        label: "pnpm test",
        package_manager: "pnpm",
        app_args: &["test"],
        runner_args: &["pnpm", "test"],
        purpose: CommandPurposeSpec::Test,
        network: CommandNetworkSpec::Denied,
        limits: CommandResourceSpec {
            timeout_seconds: Some(5 * 60),
            memory_bytes: GIB + (GIB / 2),
            active_process_limit: 128,
            max_output_bytes: 256 * 1024,
        },
        write_back: CommandWriteBackSpec::None,
    },
];

#[cfg(test)]
pub(crate) fn all_command_specs() -> &'static [CommandSpec] {
    COMMAND_SPECS
}

pub(crate) fn spec_for_command(command: &str) -> Option<&'static CommandSpec> {
    let normalized = normalize_command(command);
    spec_for_label(&normalized)
}

pub(crate) fn spec_for_label(label: &str) -> Option<&'static CommandSpec> {
    let label = label.trim();
    COMMAND_SPECS.iter().find(|spec| spec.label == label)
}

pub(crate) fn spec_matches_app_command(
    spec: &CommandSpec,
    package_manager: &str,
    args: &[&str],
) -> bool {
    spec.package_manager == package_manager && spec.app_args == args
}

pub(crate) fn allowed_commands_for_error() -> String {
    COMMAND_SPECS
        .iter()
        .map(|spec| spec.label)
        .collect::<Vec<_>>()
        .join(", ")
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}
