use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

mod commands;
mod projects;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatCompletionRequest {
    url: String,
    api_key: String,
    body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatCompletionStreamRequest {
    request_id: String,
    url: String,
    api_key: String,
    body: Value,
}

#[derive(Debug, Serialize)]
struct LlmChatCompletionResponse {
    status: u16,
    body: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LlmStreamEvent {
    request_id: String,
    delta: String,
    done: bool,
    timestamp: String,
}

#[tauri::command]
async fn llm_chat_completion(
    request: LlmChatCompletionRequest,
) -> Result<LlmChatCompletionResponse, String> {
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

    Ok(LlmChatCompletionResponse { status, body })
}

#[tauri::command]
async fn llm_chat_completion_stream(
    app: AppHandle,
    request: LlmChatCompletionStreamRequest,
) -> Result<LlmChatCompletionResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "network: failed to create HTTP client".to_string())?;
    let mut body = request.body;

    if let Some(body) = body.as_object_mut() {
        body.insert("stream".to_string(), Value::Bool(true));
    }

    let response = client
        .post(request.url)
        .bearer_auth(request.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("network: {error}"))?;
    let status = response.status().as_u16();

    if !(200..300).contains(&status) {
        let body = response
            .text()
            .await
            .map_err(|error| format!("response: {error}"))?;

        return Ok(LlmChatCompletionResponse { status, body });
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut assistant_content = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("stream: {error}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some((event_text, boundary_len)) = next_sse_event(&buffer) {
            let event_text = event_text.to_string();
            buffer.drain(..event_text.len() + boundary_len);
            process_sse_event(
                &app,
                &request.request_id,
                &event_text,
                &mut assistant_content,
            )?;
        }
    }

    if !buffer.trim().is_empty() {
        let event_text = buffer.clone();
        process_sse_event(
            &app,
            &request.request_id,
            &event_text,
            &mut assistant_content,
        )?;
    }

    let _ = app.emit(
        "llm-stream",
        LlmStreamEvent {
            request_id: request.request_id.clone(),
            delta: String::new(),
            done: true,
            timestamp: Utc::now().to_rfc3339(),
        },
    );

    let body = json!({
        "choices": [
            {
                "message": {
                    "content": assistant_content,
                }
            }
        ]
    })
    .to_string();

    Ok(LlmChatCompletionResponse { status, body })
}

fn next_sse_event(buffer: &str) -> Option<(&str, usize)> {
    if let Some(index) = buffer.find("\r\n\r\n") {
        return Some((&buffer[..index], 4));
    }

    buffer.find("\n\n").map(|index| (&buffer[..index], 2))
}

fn process_sse_event(
    app: &AppHandle,
    request_id: &str,
    event_text: &str,
    assistant_content: &mut String,
) -> Result<(), String> {
    for line in event_text.lines() {
        let line = line.trim();
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();

        if data.is_empty() || data == "[DONE]" {
            continue;
        }

        let parsed = serde_json::from_str::<Value>(data)
            .map_err(|error| format!("stream: failed to parse SSE JSON: {error}"))?;
        let delta = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if delta.is_empty() {
            continue;
        }

        assistant_content.push_str(delta);
        let _ = app.emit(
            "llm-stream",
            LlmStreamEvent {
                request_id: request_id.to_string(),
                delta: delta.to_string(),
                done: false,
                timestamp: Utc::now().to_rfc3339(),
            },
        );
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::DevServerRegistry::default())
        .invoke_handler(tauri::generate_handler![
            llm_chat_completion,
            llm_chat_completion_stream,
            commands::deploy_to_vercel,
            commands::run_command,
            commands::start_dev_server,
            commands::stop_dev_server,
            commands::open_preview_in_browser,
            commands::test_vercel_token,
            projects::create_project,
            projects::delete_files,
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
