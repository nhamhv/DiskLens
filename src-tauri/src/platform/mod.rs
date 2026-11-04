//! Everything that differs between operating systems lives here, behind one set of functions.
//! `macos.rs` and `linux.rs` each implement the same API; the rest of the backend only calls
//! `platform::…`. Windows will get its own file.
//!
//! Features a platform lacks return an empty result (or an error for actions), and
//! `features()` tells the UI which ones to hide.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

/// What this build of the app can do, so the UI hides the rest.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// "macos", "linux" or "windows".
    pub os: &'static str,
    /// Applications screen (list, uninstall, update checks).
    pub apps: bool,
    /// The OS hides folders until the app is granted access (macOS Full Disk Access).
    pub full_disk_access: bool,
    /// Time Machine local snapshots and purgeable space.
    pub hidden_space: bool,
    /// Space-bar preview.
    pub quick_look: bool,
    /// HEIC/HEIF photos can be decoded.
    pub heic: bool,
}

/// Space a folder scan can't see.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HiddenSpace {
    /// Time Machine local snapshots of the startup disk, oldest first, as `YYYY-MM-DD-HHMMSS`.
    pub snapshots: Vec<String>,
    /// Space the OS frees by itself when it's needed (caches, snapshots).
    pub purgeable: u64,
}

/// A greyscale bitmap, one byte per pixel, row by row.
pub struct Gray {
    pub pixels: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

/// Total and available bytes of the volume holding `/`.
pub fn disk_space() -> Result<(u64, u64), String> {
    disk_space_at(Path::new("/"))
}

/// Total and available bytes of the volume holding `path`.
#[allow(clippy::unnecessary_cast)] // field types differ between macOS and Linux
pub fn disk_space_at(path: &Path) -> Result<(u64, u64), String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let frsize = s.f_frsize as u64;
    Ok((s.f_blocks as u64 * frsize, s.f_bavail as u64 * frsize))
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Extra devices to count and paths to skip when scanning `/`.
pub struct RootScan {
    pub devices: Vec<u64>,
    pub skip: Vec<PathBuf>,
}

pub fn has_ext(p: &Path, exts: &[&str]) -> bool {
    p.extension().is_some_and(|x| exts.iter().any(|e| x.eq_ignore_ascii_case(e)))
}
