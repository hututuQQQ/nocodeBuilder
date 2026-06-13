use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

mod commands;
mod projects;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeepSeekChatCompletionRequest {
    url: String,
    api_key: String,
    body: Value,
}

#[derive(Debug, Serialize)]
struct DeepSeekChatCompletionResponse {
    status: u16,
    body: String,
}

#[tauri::command]
async fn deepseek_chat_completion(
    request: DeepSeekChatCompletionRequest,
) -> Result<DeepSeekChatCompletionResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "network: failed to create HTTP client".to_string())?;

    let response = client
        .post(request.url)
        .bearer_auth(request.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&request.body)
        .send()
        .await
        .map_err(|error| format!("network: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("response: {error}"))?;

    Ok(DeepSeekChatCompletionResponse { status, body })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::DevServerRegistry::default())
        .invoke_handler(tauri::generate_handler![
            deepseek_chat_completion,
            commands::run_command,
            commands::start_dev_server,
            commands::stop_dev_server,
            commands::open_preview_in_browser,
            projects::create_project,
            projects::list_projects,
            projects::list_files,
            projects::read_file,
            projects::write_file,
            projects::write_files,
            projects::open_project_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
