//! Photo cleanup: blurry shots, screen captures and near-identical photos.

use crate::photos::{self, PhotoProgress, PhotoReport};
use crate::state::{blocking, build_pool, AppState, Speed};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

/// Looks through `folders` for photos worth reviewing. Emits `photos-progress`. `None` if cancelled.
#[tauri::command]
pub async fn photos_scan(folders: Vec<String>, speed: Speed, app: AppHandle) -> Result<Option<PhotoReport>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = app.state::<AppState>().photos_cancel.lock().unwrap().replace(cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }
    blocking(move || {
        let dirs: Vec<PathBuf> = folders.iter().map(PathBuf::from).collect();
        let progress = |done, total| {
            let _ = app.emit("photos-progress", PhotoProgress { done, total });
        };
        build_pool(speed).install(|| photos::scan(&dirs, &cancel, &progress))
    })
    .await
}

#[tauri::command]
pub fn photos_cancel(state: State<AppState>) {
    if let Some(flag) = state.photos_cancel.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

/// A small JPEG preview of an image as a data URL, or `None` if it can't be decoded.
#[tauri::command]
pub async fn photo_thumb(path: String, size: Option<i32>) -> Result<Option<String>, String> {
    blocking(move || photos::thumbnail_data_url(&PathBuf::from(path), size.unwrap_or(160).clamp(32, 2048))).await
}
