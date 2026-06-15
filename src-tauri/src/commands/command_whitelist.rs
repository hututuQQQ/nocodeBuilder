use std::path::Path;

use super::types::AllowedCommand;

pub fn parse_allowed_command(command: &str) -> Result<AllowedCommand, String> {
    let normalized = normalize_command(command);

    match normalized.as_str() {
        "npm install" => Ok(AllowedCommand {
            label: "npm install",
            package_manager: "npm",
            args: &["install"],
        }),
        "npm run dev" => Ok(AllowedCommand {
            label: "npm run dev",
            package_manager: "npm",
            args: &["run", "dev"],
        }),
        "npm run build" => Ok(AllowedCommand {
            label: "npm run build",
            package_manager: "npm",
            args: &["run", "build"],
        }),
        "pnpm install" => Ok(AllowedCommand {
            label: "pnpm install",
            package_manager: "pnpm",
            args: &["install"],
        }),
        "pnpm dev" => Ok(AllowedCommand {
            label: "pnpm dev",
            package_manager: "pnpm",
            args: &["dev"],
        }),
        "pnpm build" => Ok(AllowedCommand {
            label: "pnpm build",
            package_manager: "pnpm",
            args: &["build"],
        }),
        _ => Err(format!(
            "command: '{normalized}' is not allowed. Allowed commands: npm install, npm run dev, npm run build, pnpm install, pnpm dev, pnpm build"
        )),
    }
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
