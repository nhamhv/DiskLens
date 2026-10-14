//! Installed applications: listing, icons, disk footprint and update checks. macOS only;
//! elsewhere the same commands exist but report the feature as unavailable, and the UI hides
//! the screen (`platform_features().apps`).

#[cfg(not(target_os = "macos"))]
pub use unsupported::*;

#[cfg(target_os = "macos")]
use {
    crate::apps,
    crate::state::{blocking, build_pool, cache_dir, Speed},
    rayon::prelude::*,
    std::fs,
    std::path::Path,
    std::time::UNIX_EPOCH,
    tauri::{AppHandle, Emitter},
};

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn list_apps() -> Result<Vec<apps::AppInfo>, String> {
    blocking(apps::list).await
}

/// Icon as a PNG data URL, cached on disk per bundle (invalidated when the bundle changes).
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn app_icon(path: String, app: AppHandle) -> Result<Option<String>, String> {
    use base64::Engine;
    use std::hash::{Hash, Hasher};
    let dir = cache_dir(&app)?.join("icons");
    blocking(move || {
        let mtime = fs::metadata(Path::new(&path).join("Contents/Info.plist"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&path, mtime).hash(&mut h);
        let file = dir.join(format!("{:016x}.png", h.finish()));
        let png = match fs::read(&file) {
            Ok(bytes) => Some(bytes),
            Err(_) => {
                let png = apps::icon_png(&path, 128.0);
                if let Some(bytes) = &png {
                    let _ = fs::create_dir_all(&dir);
                    let _ = fs::write(&file, bytes);
                }
                png
            }
        };
        png.map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
    })
    .await
}

/// Measures each app's bundle and data folders, emitting `app-footprint` as each one finishes.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn app_footprints(paths: Vec<String>, speed: Speed, app: AppHandle) -> Result<(), String> {
    blocking(move || {
        build_pool(speed).install(|| {
            paths.par_iter().for_each(|p| {
                let _ = app.emit("app-footprint", apps::footprint(Path::new(p)));
            })
        })
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn check_app_updates(paths: Vec<String>) -> Result<Vec<apps::UpdateInfo>, String> {
    blocking(move || apps::check_updates(paths)).await
}


#[cfg(not(target_os = "macos"))]
mod unsupported {
    use crate::state::Speed;
    use tauri::AppHandle;

    const UNAVAILABLE: &str = "The Applications screen is only available on macOS";

    #[tauri::command]
    pub async fn list_apps() -> Result<Vec<serde_json::Value>, String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn app_icon(_path: String, _app: AppHandle) -> Result<Option<String>, String> {
        Ok(None)
    }

    #[tauri::command]
    pub async fn app_footprints(_paths: Vec<String>, _speed: Speed, _app: AppHandle) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }

    #[tauri::command]
    pub async fn check_app_updates(_paths: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
        Err(UNAVAILABLE.into())
    }
}
