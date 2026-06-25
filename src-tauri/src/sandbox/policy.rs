use super::types::{SandboxNetworkPolicy, SandboxPurpose, SandboxResourceLimits};
use crate::commands::types::AllowedCommand;

pub const SANDBOX_POLICY_VERSION: u32 = 1;

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct SandboxCommandPolicy {
    pub purpose: SandboxPurpose,
    pub network: SandboxNetworkPolicy,
    pub limits: SandboxResourceLimits,
}

pub fn policy_for_allowed_command(allowed: AllowedCommand) -> SandboxCommandPolicy {
    match allowed.label {
        "npm install" | "pnpm install" => SandboxCommandPolicy {
            purpose: SandboxPurpose::Install,
            network: SandboxNetworkPolicy::ManagedProxy {
                proxy_port: 0,
                allowed_hosts: vec![
                    "registry.npmjs.org".to_string(),
                    "*.npmjs.org".to_string(),
                    "github.com".to_string(),
                    "api.github.com".to_string(),
                    "objects.githubusercontent.com".to_string(),
                    "github-releases.githubusercontent.com".to_string(),
                    "nodejs.org".to_string(),
                ],
            },
            limits: SandboxResourceLimits {
                timeout_seconds: Some(10 * 60),
                memory_bytes: 2 * GIB,
                active_process_limit: 256,
                max_output_bytes: 256 * 1024,
            },
        },
        "npm run build" | "pnpm build" => SandboxCommandPolicy {
            purpose: SandboxPurpose::Build,
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(5 * 60),
                memory_bytes: 2 * GIB,
                active_process_limit: 128,
                max_output_bytes: 256 * 1024,
            },
        },
        "npm run lint" | "pnpm lint" => SandboxCommandPolicy {
            purpose: SandboxPurpose::Lint,
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(3 * 60),
                memory_bytes: GIB,
                active_process_limit: 64,
                max_output_bytes: 128 * 1024,
            },
        },
        "npm run test" | "npm test" | "pnpm test" => SandboxCommandPolicy {
            purpose: SandboxPurpose::Test,
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(5 * 60),
                memory_bytes: GIB + (GIB / 2),
                active_process_limit: 128,
                max_output_bytes: 256 * 1024,
            },
        },
        "npm run dev" | "pnpm dev" => SandboxCommandPolicy {
            purpose: SandboxPurpose::DevServer,
            network: SandboxNetworkPolicy::LocalServer { port: 0 },
            limits: SandboxResourceLimits {
                timeout_seconds: None,
                memory_bytes: 2 * GIB,
                active_process_limit: 256,
                max_output_bytes: 256 * 1024,
            },
        },
        _ => SandboxCommandPolicy {
            purpose: SandboxPurpose::Build,
            network: SandboxNetworkPolicy::Denied,
            limits: SandboxResourceLimits {
                timeout_seconds: Some(60),
                memory_bytes: GIB,
                active_process_limit: 32,
                max_output_bytes: 64 * 1024,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::command_whitelist::parse_allowed_command;

    #[test]
    fn install_requires_managed_proxy_policy() {
        let policy = policy_for_allowed_command(parse_allowed_command("npm install").unwrap());
        assert!(matches!(policy.purpose, SandboxPurpose::Install));
        assert!(matches!(
            policy.network,
            SandboxNetworkPolicy::ManagedProxy { .. }
        ));
    }

    #[test]
    fn build_denies_network() {
        let policy = policy_for_allowed_command(parse_allowed_command("npm run build").unwrap());
        assert!(matches!(policy.purpose, SandboxPurpose::Build));
        assert_eq!(policy.network, SandboxNetworkPolicy::Denied);
    }
}
