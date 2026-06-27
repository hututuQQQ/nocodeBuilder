use std::process::Command;

use super::node_runtime::{apply_runtime_environment, ResolvedCommand};

pub fn resolve_npx_command(args: Vec<String>) -> Result<ResolvedCommand, String> {
    super::node_runtime::resolve_npx_command(args)
}

pub fn apply_resolved_command_environment(
    command: &mut Command,
    resolved: &ResolvedCommand,
) -> Result<(), String> {
    apply_runtime_environment(command, resolved)
}
