use super::types::{SandboxError, SandboxNetworkPolicy, SandboxPurpose, SandboxResourceLimits};
use crate::commands::{
    command_spec::{
        spec_for_label, spec_matches_app_command, CommandNetworkSpec, CommandPurposeSpec,
        MANAGED_PROXY_ALLOWED_HOSTS,
    },
    types::AllowedCommand,
};

pub const SANDBOX_POLICY_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct SandboxCommandPolicy {
    pub purpose: SandboxPurpose,
    pub network: SandboxNetworkPolicy,
    pub limits: SandboxResourceLimits,
}

pub fn policy_for_allowed_command(
    allowed: AllowedCommand,
) -> Result<SandboxCommandPolicy, SandboxError> {
    let spec = spec_for_label(allowed.label).ok_or_else(|| {
        SandboxError::policy_denied(format!(
            "sandbox policy has no command spec for '{}'",
            allowed.label
        ))
    })?;

    if !spec_matches_app_command(spec, allowed.package_manager, allowed.args) {
        return Err(SandboxError::policy_denied(format!(
            "sandbox policy command spec does not match '{}'",
            allowed.label
        )));
    }

    Ok(SandboxCommandPolicy {
        purpose: match spec.purpose {
            CommandPurposeSpec::Install => SandboxPurpose::Install,
            CommandPurposeSpec::Build => SandboxPurpose::Build,
            CommandPurposeSpec::Test => SandboxPurpose::Test,
            CommandPurposeSpec::Lint => SandboxPurpose::Lint,
            CommandPurposeSpec::DevServer => SandboxPurpose::DevServer,
        },
        network: match spec.network {
            CommandNetworkSpec::Denied => SandboxNetworkPolicy::Denied,
            CommandNetworkSpec::LocalServer => SandboxNetworkPolicy::LocalServer { port: 0 },
            CommandNetworkSpec::ManagedProxy => SandboxNetworkPolicy::ManagedProxy {
                proxy_port: 0,
                allowed_hosts: MANAGED_PROXY_ALLOWED_HOSTS
                    .iter()
                    .map(|host| (*host).to_string())
                    .collect(),
            },
        },
        limits: SandboxResourceLimits {
            timeout_seconds: spec.limits.timeout_seconds,
            memory_bytes: spec.limits.memory_bytes,
            active_process_limit: spec.limits.active_process_limit,
            max_output_bytes: spec.limits.max_output_bytes,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::command_whitelist::parse_allowed_command;

    #[test]
    fn install_requires_managed_proxy_policy() {
        let policy = policy_for_allowed_command(parse_allowed_command("npm install").unwrap())
            .expect("install policy");
        assert!(matches!(policy.purpose, SandboxPurpose::Install));
        assert!(matches!(
            policy.network,
            SandboxNetworkPolicy::ManagedProxy { .. }
        ));
    }

    #[test]
    fn build_denies_network() {
        let policy = policy_for_allowed_command(parse_allowed_command("npm run build").unwrap())
            .expect("build policy");
        assert!(matches!(policy.purpose, SandboxPurpose::Build));
        assert_eq!(policy.network, SandboxNetworkPolicy::Denied);
    }

    #[test]
    fn unknown_command_has_no_policy_fallback() {
        let error = policy_for_allowed_command(AllowedCommand {
            label: "npm run unknown",
            package_manager: "npm",
            args: &["run", "unknown"],
        })
        .expect_err("unknown command should be denied");

        assert!(error.message.contains("no command spec"));
    }

    #[test]
    fn every_allowed_command_has_matching_policy() {
        for spec in crate::commands::command_spec::all_command_specs() {
            let policy = policy_for_allowed_command(parse_allowed_command(spec.label).unwrap())
                .expect("command policy");

            assert_eq!(policy.limits.max_output_bytes, spec.limits.max_output_bytes);
        }
    }
}
