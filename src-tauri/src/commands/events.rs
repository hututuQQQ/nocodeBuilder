use std::{
    io::{self, BufRead, BufReader, Read},
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
pub const DEFAULT_MAX_OUTPUT_LINE_BYTES: usize = 16 * 1024;
pub const DEFAULT_EVENT_OUTPUT_BYTES: usize = 256 * 1024;
const LINE_TRUNCATED_MARKER: &str = "[line truncated]";
const OUTPUT_TRUNCATED_MARKER: &str = "[command output truncated]";

#[derive(Debug)]
pub struct OutputEventBudget {
    remaining_bytes: Mutex<usize>,
}

impl OutputEventBudget {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            remaining_bytes: Mutex::new(max_bytes),
        }
    }

    fn take_line(&self, line: &str) -> Option<String> {
        let mut remaining = self.remaining_bytes.lock().ok()?;

        if *remaining == 0 {
            return None;
        }

        if line.len() <= *remaining {
            *remaining -= line.len();
            return Some(line.to_string());
        }

        let marker_len = OUTPUT_TRUNCATED_MARKER.len();
        if *remaining < marker_len {
            *remaining = 0;
            return None;
        }

        let available = (*remaining).saturating_sub(marker_len + 1);
        let mut emitted = truncate_to_byte_limit(line, available).to_string();
        if !emitted.is_empty() {
            emitted.push(' ');
        }
        emitted.push_str(OUTPUT_TRUNCATED_MARKER);
        *remaining = 0;
        Some(emitted)
    }
}

pub fn output_event_budget(max_bytes: usize) -> Arc<OutputEventBudget> {
    Arc::new(OutputEventBudget::new(max_bytes))
}

pub fn spawn_output_reader<R>(
    app: AppHandle,
    project_id: String,
    command: String,
    stream: &'static str,
    reader: R,
    output: Option<Arc<Mutex<String>>>,
    url_sender: Option<mpsc::Sender<String>>,
    url_state: Option<Arc<Mutex<Option<String>>>>,
    max_output_bytes: Option<usize>,
    max_line_bytes: Option<usize>,
    event_budget: Option<Arc<OutputEventBudget>>,
    redactions: Option<Arc<Vec<String>>>,
) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let max_line_bytes = max_line_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_LINE_BYTES);

        loop {
            match read_line_limited(&mut reader, max_line_bytes) {
                Ok(None) => break,
                Ok(Some(line)) => {
                    let mut line_text = String::from_utf8_lossy(&line.bytes).to_string();
                    trim_line_end(&mut line_text);
                    let mut clean_line = redact_secrets(
                        &strip_ansi_codes(&line_text),
                        redactions.as_deref().map(Vec::as_slice).unwrap_or(&[]),
                    );

                    if line.truncated {
                        if !clean_line.is_empty() {
                            clean_line.push(' ');
                        }
                        clean_line.push_str(LINE_TRUNCATED_MARKER);
                    }

                    if let Some(output) = &output {
                        if let Ok(mut output) = output.lock() {
                            append_limited_output(
                                &mut output,
                                &format!("[{stream}] {clean_line}\n"),
                                max_output_bytes,
                            );
                        }
                    }

                    let event_line = match &event_budget {
                        Some(budget) => budget.take_line(&clean_line),
                        None => Some(clean_line.clone()),
                    };

                    if let Some(event_line) = event_line {
                        let _ = app.emit(
                            COMMAND_OUTPUT_EVENT,
                            CommandOutputEvent {
                                project_id: project_id.clone(),
                                command: command.clone(),
                                stream: stream.to_string(),
                                line: event_line,
                                timestamp: current_timestamp(),
                            },
                        );
                    }

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

#[derive(Debug, Eq, PartialEq)]
struct LimitedLine {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_line_limited<R: BufRead>(
    reader: &mut R,
    max_line_bytes: usize,
) -> io::Result<Option<LimitedLine>> {
    let mut bytes = Vec::new();
    let mut truncated = false;

    loop {
        let available = reader.fill_buf()?;

        if available.is_empty() {
            if bytes.is_empty() && !truncated {
                return Ok(None);
            }

            return Ok(Some(LimitedLine { bytes, truncated }));
        }

        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());

        if bytes.len() < max_line_bytes {
            let remaining = max_line_bytes - bytes.len();
            let copied = consumed.min(remaining);
            bytes.extend_from_slice(&available[..copied]);

            if copied < consumed {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        let has_newline = available[..consumed].contains(&b'\n');
        reader.consume(consumed);

        if has_newline {
            return Ok(Some(LimitedLine { bytes, truncated }));
        }
    }
}

fn trim_line_end(line: &mut String) {
    while line.ends_with('\n') || line.ends_with('\r') {
        line.pop();
    }
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

pub fn emit_output_line(
    app: &AppHandle,
    project_id: &str,
    command: &str,
    stream: &str,
    line: String,
) {
    let _ = app.emit(
        COMMAND_OUTPUT_EVENT,
        CommandOutputEvent {
            project_id: project_id.to_string(),
            command: command.to_string(),
            stream: stream.to_string(),
            line,
            timestamp: current_timestamp(),
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

pub fn append_limited_output(output: &mut String, text: &str, max_bytes: Option<usize>) {
    let Some(max_bytes) = max_bytes else {
        output.push_str(text);
        return;
    };

    if output.len() >= max_bytes {
        return;
    }

    let remaining = max_bytes - output.len();

    if text.len() <= remaining {
        output.push_str(text);
        return;
    }

    let marker = "\n[command output truncated]\n";
    let available = remaining.saturating_sub(marker.len());
    let split = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= available)
        .last()
        .unwrap_or(0);

    output.push_str(&text[..split]);

    if output.len() + marker.len() <= max_bytes {
        output.push_str(marker);
    }
}

fn truncate_to_byte_limit(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }

    let split = text
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);

    &text[..split]
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

#[cfg(test)]
mod tests {
    use super::{
        append_limited_output, read_line_limited, OutputEventBudget, LINE_TRUNCATED_MARKER,
        OUTPUT_TRUNCATED_MARKER,
    };
    use std::io::{BufReader, Cursor};

    #[test]
    fn caps_captured_output() {
        let mut output = String::new();
        append_limited_output(&mut output, "abcdef", Some(10));
        append_limited_output(&mut output, "ghijklmnopqrstuvwxyz", Some(10));

        assert!(output.len() <= 10);
    }

    #[test]
    fn appends_truncation_marker_when_output_is_capped() {
        let mut output = String::from("prefix");
        append_limited_output(
            &mut output,
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
            Some(40),
        );

        assert!(output.len() <= 40);
        assert!(output.contains("[command output truncated]"));
    }

    #[test]
    fn ignores_more_output_after_limit_is_reached() {
        let mut output = String::from("abcdefghij");
        append_limited_output(&mut output, "klmnopqrstuvwxyz", Some(10));

        assert_eq!(output, "abcdefghij");
    }

    #[test]
    fn truncates_on_utf8_character_boundary() {
        let mut output = String::from("prefix");
        append_limited_output(&mut output, "éééééééééééééééééééé", Some(37));

        assert!(output.len() <= 37);
        assert!(output.contains("[command output truncated]"));
        assert!(output.is_char_boundary(output.len()));
    }

    #[test]
    fn limited_line_reader_caps_oversized_single_line() {
        let input = Cursor::new(vec![b'a'; 64 * 1024]);
        let mut reader = BufReader::new(input);

        let line = read_line_limited(&mut reader, 1024).unwrap().unwrap();

        assert_eq!(line.bytes.len(), 1024);
        assert!(line.truncated);
    }

    #[test]
    fn limited_line_reader_preserves_small_lines() {
        let input = Cursor::new(b"hello\nworld\n".to_vec());
        let mut reader = BufReader::new(input);

        let first = read_line_limited(&mut reader, 1024).unwrap().unwrap();
        let second = read_line_limited(&mut reader, 1024).unwrap().unwrap();
        let done = read_line_limited(&mut reader, 1024).unwrap();

        assert_eq!(first.bytes, b"hello\n");
        assert!(!first.truncated);
        assert_eq!(second.bytes, b"world\n");
        assert!(done.is_none());
    }

    #[test]
    fn shared_event_budget_truncates_and_then_stops_emitting() {
        let budget = OutputEventBudget::new(70);
        let first = budget.take_line("abcdefghijklmnopqrstuvwxyz").unwrap();
        let second = budget
            .take_line("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
            .unwrap();
        let third = budget.take_line("small");

        assert_eq!(first, "abcdefghijklmnopqrstuvwxyz");
        assert!(second.contains(OUTPUT_TRUNCATED_MARKER));
        assert!(third.is_none());
    }

    #[test]
    fn line_truncation_marker_fits_expected_event_text() {
        let mut line = "prefix".to_string();
        line.push(' ');
        line.push_str(LINE_TRUNCATED_MARKER);

        assert_eq!(line, "prefix [line truncated]");
    }
}
