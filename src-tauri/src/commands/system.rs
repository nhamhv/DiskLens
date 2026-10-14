//! File manager, clipboard, OS permissions and volume info.

use crate::platform::{self, Features, HiddenSpace};
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub total: u64,
    pub free: u64,
}

/// Which OS this is and which of its features the UI should offer.
#[tauri::command]
pub fn platform_features() -> Features {
    platform::features()
}

/// Whether `path` is a folder (for a folder dropped on the window).
#[tauri::command]
pub fn is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// Quits from the menu bar / tray menu.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Opens a file or folder with its default app.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Toggles a Quick Look preview of `paths` (macOS only). Returns whether a preview is now open.
#[tauri::command]
pub fn quick_look(paths: Vec<String>) -> Result<bool, String> {
    platform::quick_look(paths)
}

/// Shows the item selected in Finder or the Linux file manager.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_path(path: String, app: AppHandle) -> Result<(), String> {
    app.clipboard().write_text(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_full_disk_access_settings() -> Result<(), String> {
    platform::open_privacy_settings()
}

/// Whether the app can read everything the OS protects (always true where there is no such gate).
#[tauri::command]
pub fn has_full_disk_access() -> bool {
    platform::has_full_disk_access()
}

#[tauri::command]
pub async fn hidden_space() -> Result<HiddenSpace, String> {
    crate::state::blocking(platform::hidden_space).await
}

/// Asks macOS to delete the Time Machine local snapshots. Returns how many are left.
#[tauri::command]
pub async fn thin_snapshots() -> Result<usize, String> {
    crate::state::blocking(platform::thin_snapshots).await?
}

#[tauri::command]
pub fn disk_info() -> Result<DiskInfo, String> {
    let (total, free) = platform::disk_space()?;
    Ok(DiskInfo { total, free })
}
