use std::{
    io::{BufRead, BufReader, Read},
    sync::{mpsc, Arc, Mutex},
    thread,
};

use tauri::{AppHandle, Emitter};

use super::{
    time::current_timestamp,
    types::{CommandOutputEvent, CommandStatusEvent},
};

const COMMAND_OUTPUT_EVENT: &str = "command-output";
const COMMAND_STATUS_EVENT: &str = "command-status";

pub struct OutputReaderOptions<R> {
    pub app: AppHandle,
    pub project_id: String,
    pub command: String,
    pub stream: &'static str,
    pub reader: R,
    pub output: Option<Arc<Mutex<String>>>,
    pub url_sender: Option<mpsc::Sender<String>>,
    pub url_state: Option<Arc<Mutex<Option<String>>>>,
    pub redactions: Option<Arc<Vec<String>>>,
}

pub fn spawn_output_reader<R>(options: OutputReaderOptions<R>) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    let OutputReaderOptions {
        app,
        project_id,
        command,
        stream,
        reader,
        output,
        url_sender,
        url_state,
        redactions,
    } = options;

    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();

        loop {
            line.clear();

            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let clean_line = redact_secrets(
                        &strip_ansi_codes(line.trim_end_matches(['\r', '\n'])),
                        redactions.as_deref().map(Vec::as_slice).unwrap_or(&[]),
                    );

                    if let Some(output) = &output {
                        if let Ok(mut output) = output.lock() {
                            output.push('[');
                            output.push_str(stream);
                            output.push_str("] ");
                            output.push_str(&clean_line);
                            output.push('\n');
                        }
                    }

                    let _ = app.emit(
                        COMMAND_OUTPUT_EVENT,
                        CommandOutputEvent {
                            project_id: project_id.clone(),
                            command: command.clone(),
                            stream: stream.to_string(),
                            line: clean_line.clone(),
                            timestamp: current_timestamp(),
                        },
                    );

                    if let (Some(url_sender), Some(url_state)) = (&url_sender, &url_state) {
                        if let Some(url) = detect_local_url(&clean_line) {
                            if let Ok(mut current_url) = url_state.lock() {
                                if current_url.is_none() {
                                    *current_url = Some(url.clone());
                                    let _ = url_sender.send(url);
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        COMMAND_OUTPUT_EVENT,
                        CommandOutputEvent {
                            project_id: project_id.clone(),
                            command: command.clone(),
                            stream: "stderr".to_string(),
                            line: format!("command: failed to read {stream}: {error}"),
                            timestamp: current_timestamp(),
                        },
                    );
                    break;
                }
            }
        }
    })
}

pub fn emit_status(
    app: &AppHandle,
    project_id: &str,
    command: &str,
    status: &str,
    exit_code: Option<i32>,
    message: Option<String>,
    url: Option<String>,
) {
    let _ = app.emit(
        COMMAND_STATUS_EVENT,
        CommandStatusEvent {
            project_id: project_id.to_string(),
            command: command.to_string(),
            status: status.to_string(),
            exit_code,
            message,
            timestamp: current_timestamp(),
            url,
        },
    );
}

pub fn strip_ansi_codes(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek().is_some_and(|next| *next == '[') {
            chars.next();

            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            output.push(character);
        }
    }

    output
}

pub fn redact_secrets<S: AsRef<str>>(input: &str, secrets: &[S]) -> String {
    secrets
        .iter()
        .map(|secret| secret.as_ref().trim())
        .filter(|secret| secret.len() >= 8)
        .fold(input.to_string(), |current, secret| {
            current.replace(secret, "[redacted]")
        })
}

fn detect_local_url(line: &str) -> Option<String> {
    ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"]
        .iter()
        .filter_map(|marker| {
            let start = line.find(marker)?;
            let tail = &line[start..];
            let url = tail
                .chars()
                .take_while(|character| {
                    !character.is_whitespace()
                        && *character != '"'
                        && *character != '\''
                        && *character != '<'
                        && *character != '>'
                })
                .collect::<String>();

            if url.is_empty() {
                None
            } else {
                Some(url)
            }
        })
        .next()
}
