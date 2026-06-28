use keyring::{Entry, Error};

const SERVICE_NAME: &str = "nocodeBuilder";

#[tauri::command]
pub fn save_ai_provider_secret(provider: String, api_key: String) -> Result<(), String> {
    let trimmed_key = api_key.trim();

    if trimmed_key.is_empty() {
        return Err("credential: API key is required".to_string());
    }

    entry_for_provider(&provider)?
        .set_password(trimmed_key)
        .map_err(format_credential_error)
}

#[tauri::command]
pub fn has_ai_provider_secret(provider: String) -> Result<bool, String> {
    match entry_for_provider(&provider)?.get_password() {
        Ok(secret) => Ok(!secret.trim().is_empty()),
        Err(Error::NoEntry) => Ok(false),
        Err(error) => Err(format_credential_error(error)),
    }
}

pub fn resolve_ai_provider_secret(
    provider: &str,
    request_api_key: Option<&str>,
) -> Result<String, String> {
    if let Some(api_key) = request_api_key {
        let trimmed_key = api_key.trim();

        if !trimmed_key.is_empty() {
            return Ok(trimmed_key.to_string());
        }
    }

    match entry_for_provider(provider)?.get_password() {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret.trim().to_string()),
        Ok(_) | Err(Error::NoEntry) => Err(
            "credential: saved AI provider API key was not found. Reconnect the provider in settings."
                .to_string(),
        ),
        Err(error) => Err(format_credential_error(error)),
    }
}

fn entry_for_provider(provider: &str) -> Result<Entry, String> {
    validate_provider(provider)?;
    Entry::new(SERVICE_NAME, &format!("ai-provider:{provider}:api-key"))
        .map_err(format_credential_error)
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        "deepseek" | "glm" => Ok(()),
        _ => Err("credential: unknown AI provider".to_string()),
    }
}

fn format_credential_error(error: Error) -> String {
    format!("credential: {error}")
}
