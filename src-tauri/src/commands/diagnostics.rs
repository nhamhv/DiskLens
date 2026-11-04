//! Opt-in usage stats, crash logs and the "Report issue" flow. Logic lives in `diagnostics.rs`.

use crate::diagnostics::{self, CrashLog, IssueReport, TelemetryStatus};

#[tauri::command]
pub fn telemetry_status() -> TelemetryStatus {
    diagnostics::status()
}

#[tauri::command]
pub fn telemetry_set_consent(agreed: bool) -> Result<(), String> {
    diagnostics::set_consent(agreed)
}

/// Crash reports saved on this machine, newest first.
#[tauri::command]
pub fn list_crash_logs() -> Vec<CrashLog> {
    diagnostics::crash_logs()
}

/// Shows the crash folder in the file manager so the user can attach a file to an issue.
#[tauri::command]
pub fn open_crash_folder() -> Result<(), String> {
    let dir = diagnostics::crash_dir().ok_or("the data folder is not ready")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// Records an error thrown in the UI (`window.onerror`, unhandled rejections).
#[tauri::command]
pub fn log_ui_error(message: String, stack: String) {
    diagnostics::write_ui_error(&message, &stack);
}

#[tauri::command]
pub fn issue_report() -> IssueReport {
    diagnostics::issue_report()
}

/// Opens the prefilled issue page. Only DiskLens's own issue tracker is allowed.
#[tauri::command]
pub fn open_issue(url: String) -> Result<(), String> {
    if !url.starts_with(diagnostics::ISSUES_URL) {
        return Err("not an issue link".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}
