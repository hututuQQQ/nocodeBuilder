use std::path::Path;

use super::command_spec::{allowed_commands_for_error, spec_for_command};
use super::types::AllowedCommand;

pub fn parse_allowed_command(command: &str) -> Result<AllowedCommand, String> {
    let normalized = normalize_command(command);
    let Some(spec) = spec_for_command(command) else {
        return Err(format!(
            "command: '{normalized}' is not allowed. Allowed commands: {}",
            allowed_commands_for_error()
        ));
    };

    Ok(AllowedCommand {
        label: spec.label,
        package_manager: spec.package_manager,
        args: spec.app_args,
    })
}

pub fn preferred_dev_command(project_dir: &Path) -> AllowedCommand {
    if project_dir.join("pnpm-lock.yaml").is_file() {
        parse_allowed_command("pnpm dev").expect("pnpm dev must be allowed")
    } else {
        parse_allowed_command("npm run dev").expect("npm run dev must be allowed")
    }
}

pub fn preferred_build_command(project_dir: &Path) -> AllowedCommand {
    if project_dir.join("pnpm-lock.yaml").is_file() {
        parse_allowed_command("pnpm build").expect("pnpm build must be allowed")
    } else {
        parse_allowed_command("npm run build").expect("npm run build must be allowed")
    }
}

fn normalize_command(command: &str) -> String {
    command.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::command_spec::all_command_specs;

    #[test]
    fn allows_only_exact_whitelisted_commands() {
        assert!(parse_allowed_command("npm run build").is_ok());
        assert!(parse_allowed_command("pnpm test").is_ok());
        assert!(parse_allowed_command("npm install next").is_err());
        assert!(parse_allowed_command("npm run build && whoami").is_err());
        assert!(parse_allowed_command("sh -c 'npm run build'").is_err());
        assert!(parse_allowed_command("powershell -Command npm install").is_err());
    }

    #[test]
    fn parses_every_central_command_spec() {
        for spec in all_command_specs() {
            let allowed = parse_allowed_command(spec.label).unwrap();

            assert_eq!(allowed.label, spec.label);
            assert_eq!(allowed.package_manager, spec.package_manager);
            assert_eq!(allowed.args, spec.app_args);
        }
    }
}
