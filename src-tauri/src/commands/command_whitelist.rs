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
        "npm run lint" => Ok(AllowedCommand {
            label: "npm run lint",
            package_manager: "npm",
            args: &["run", "lint"],
        }),
        "npm run test" => Ok(AllowedCommand {
            label: "npm run test",
            package_manager: "npm",
            args: &["run", "test"],
        }),
        "npm test" => Ok(AllowedCommand {
            label: "npm test",
            package_manager: "npm",
            args: &["test"],
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
        "pnpm lint" => Ok(AllowedCommand {
            label: "pnpm lint",
            package_manager: "pnpm",
            args: &["lint"],
        }),
        "pnpm test" => Ok(AllowedCommand {
            label: "pnpm test",
            package_manager: "pnpm",
            args: &["test"],
        }),
        _ => Err(format!(
            "command: '{normalized}' is not allowed. Allowed commands: npm install, npm run dev, npm run build, npm run lint, npm run test, npm test, pnpm install, pnpm dev, pnpm build, pnpm lint, pnpm test"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_exact_whitelisted_commands() {
        assert!(parse_allowed_command("npm run build").is_ok());
        assert!(parse_allowed_command("pnpm test").is_ok());
        assert!(parse_allowed_command("npm install next").is_err());
        assert!(parse_allowed_command("npm run build && whoami").is_err());
        assert!(parse_allowed_command("sh -c 'npm run build'").is_err());
        assert!(parse_allowed_command("powershell -Command npm install").is_err());
    }
}
