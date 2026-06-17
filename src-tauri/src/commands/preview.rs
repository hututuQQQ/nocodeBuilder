use std::process::Command;

pub fn open_preview_in_browser(url: String) -> Result<(), String> {
    validate_preview_browser_url(&url)?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&url);
        command
    };

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .spawn()
        .map_err(|error| format!("preview: failed to open URL in browser: {error}"))?;

    Ok(())
}

fn validate_preview_browser_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    let is_local_http = url.starts_with("http://localhost:")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://[::1]:");
    let is_https = url.starts_with("https://") && !url.chars().any(char::is_whitespace);

    if is_local_http || is_https {
        Ok(())
    } else {
        Err("preview: only local http or https preview URLs can be opened".to_string())
    }
}
