//! DiskLens backend. `commands` holds everything the UI can call;
//! `scanner`, `cache`, `apps`, `dev` and `photos` hold the logic behind them, and
//! `platform` everything that differs between operating systems.

#[cfg(target_os = "macos")]
mod apps;
mod cache;
mod classify;
mod commands;
mod dev;
mod diagnostics;
mod photos;
mod platform;
mod scanner;
mod state;

use tauri::Manager;
use commands::{apps as app_cmds, delete, dev as dev_cmds, diagnostics as diag_cmds, photos as photo_cmds, scan, system, trash};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state::AppState::default())
        .setup(|app| {
            // Crash logs and the stats choice live in the app data folder.
            if let Ok(dir) = app.path().app_data_dir() {
                diagnostics::init(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan::start_scan,
            scan::cancel_scan,
            scan::rescan_folder,
            scan::load_cache,
            scan::list_caches,
            scan::forget_cache,
            scan::clear_caches,
            scan::set_cache_mode,
            scan::scan_threads,
            scan::list_children,
            scan::largest_files,
            scan::scan_summary,
            scan::scan_changes,
            photo_cmds::photos_scan,
            photo_cmds::photos_cancel,
            photo_cmds::photo_thumb,
            delete::delete_paths,
            trash::trash_contents,
            app_cmds::list_apps,
            app_cmds::app_icon,
            app_cmds::app_footprints,
            app_cmds::check_app_updates,
            dev_cmds::dev_scan,
            dev_cmds::dev_cancel,
            dev_cmds::dev_cached_report,
            dev_cmds::dev_worktree_status,
            dev_cmds::dev_prune_worktrees,
            dev_cmds::dev_rules_read,
            dev_cmds::dev_rules_stat,
            dev_cmds::dev_rules_check,
            dev_cmds::dev_rules_save,
            diag_cmds::telemetry_status,
            diag_cmds::telemetry_set_consent,
            diag_cmds::list_crash_logs,
            diag_cmds::open_crash_folder,
            diag_cmds::log_ui_error,
            diag_cmds::issue_report,
            diag_cmds::open_issue,
            system::platform_features,
            system::open_path,
            system::is_dir,
            system::quit_app,
            system::reveal_in_finder,
            system::quick_look,
            system::copy_path,
            system::open_full_disk_access_settings,
            system::has_full_disk_access,
            system::disk_info,
            system::hidden_space,
            system::thin_snapshots,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
