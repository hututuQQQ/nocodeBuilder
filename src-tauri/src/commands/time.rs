use chrono::Utc;

pub fn current_timestamp() -> String {
    Utc::now().to_rfc3339()
}
