//! Linux (tested on Ubuntu): freedesktop Trash, /proc/self/mounts, nice/ioprio, the `image` crate.

use super::{Features, Gray, HiddenSpace, RootScan};
use crate::state::Speed;
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub fn features() -> Features {
    Features { os: "linux", apps: false, full_disk_access: false, hidden_space: false, quick_look: false, heic: false }
}

/// Runs on each scan thread as it starts. Linux applies `nice` and the I/O priority per thread.
pub fn set_thread_priority(speed: Speed) {
    // ioprio: class in the top bits (2 = best effort, 3 = idle), level 0-7 below.
    let (nice, ioprio) = match speed {
        Speed::Low => (19, 3 << 13),
        Speed::Balanced => (10, (2 << 13) | 7),
        Speed::Fast => return,
    };
    unsafe {
        let tid = libc::gettid();
        libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, nice);
        libc::syscall(libc::SYS_ioprio_set, 1 /* IOPRIO_WHO_PROCESS, i.e. this thread */, tid, ioprio);
    }
}

/// Filesystem types that hold real files on a local disk.
const DISK_FS: &[&str] = &["ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "zfs", "bcachefs", "jfs", "reiserfs"];

/// Scanning `/` also counts other local disk partitions mounted under it (a separate
/// `/home`, `/var`…), but not removable drives, network shares, snaps or virtual filesystems.
pub fn root_scan() -> RootScan {
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    RootScan {
        devices: parse_mounts(&mounts).filter_map(|m| std::fs::metadata(m).ok()).map(|m| m.dev()).collect(),
        skip: ["/proc", "/sys", "/dev", "/run", "/snap", "/media", "/mnt", "/lost+found"].map(PathBuf::from).to_vec(),
    }
}

/// Mount points of local disk partitions, from `/proc/self/mounts`.
fn parse_mounts(mounts: &str) -> impl Iterator<Item = PathBuf> + '_ {
    mounts.lines().filter_map(|l| {
        let mut f = l.split_whitespace();
        let (src, dir, fs) = (f.next()?, f.next()?, f.next()?);
        // Spaces in paths are written as \040.
        let dir = dir.replace("\\040", " ");
        let removable = ["/media/", "/mnt/", "/run/"].iter().any(|p| dir.starts_with(p));
        (src.starts_with("/dev/") && DISK_FS.contains(&fs) && !removable).then(|| PathBuf::from(dir))
    })
}

fn trash_root() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| Some(super::home()?.join(".local/share")))?;
    Some(data.join("Trash"))
}

/// Trashed items (freedesktop spec): `files/` holds them, `info/` one `.trashinfo` each.
pub fn trash_files() -> Option<PathBuf> {
    Some(trash_root()?.join("files"))
}

/// The `.trashinfo` file that goes with a trashed item, removed along with it.
pub fn trash_info(item: &Path) -> Option<PathBuf> {
    let root = trash_root()?;
    (item.parent()? == root.join("files")).then(|| {
        let mut name = item.file_name().unwrap_or_default().to_os_string();
        name.push(".trashinfo");
        root.join("info").join(name)
    })
}

pub const GIT_CANDIDATES: &[&str] = &["/usr/bin/git", "/usr/local/bin/git", "/home/linuxbrew/.linuxbrew/bin/git"];

pub fn quick_look(_paths: Vec<String>) -> Result<bool, String> {
    Err("Quick Look is only available on macOS".into())
}

pub fn open_privacy_settings() -> Result<(), String> {
    Err("Not needed on Linux".into())
}

/// Linux has no app-level file access gate; unreadable folders are just counted as errors.
pub fn has_full_disk_access() -> bool {
    true
}

pub fn hidden_space() -> HiddenSpace {
    HiddenSpace::default()
}

pub fn thin_snapshots() -> Result<usize, String> {
    Err("Time Machine snapshots only exist on macOS".into())
}

/// No index marks screen captures; `photos` falls back to file names.
pub fn screen_captures(_dirs: &[PathBuf]) -> HashSet<PathBuf> {
    HashSet::new()
}

/// Decodes `path`, applies its EXIF orientation and shrinks it to at most `px` on its long side.
fn decode(path: &Path, px: i32) -> Option<image::DynamicImage> {
    use image::{ImageDecoder, ImageReader};
    let mut decoder = ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
    let px = px.max(1) as u32;
    if img.width() > px || img.height() > px {
        img = img.thumbnail(px, px);
    }
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }
    Some(img)
}

/// The image at `path` as a greyscale bitmap at most `px` on its long side, upright.
pub fn thumbnail_gray(path: &Path, px: i32) -> Option<Gray> {
    let g = decode(path, px)?.into_luma8();
    let (width, height) = (g.width() as usize, g.height() as usize);
    (width > 0 && height > 0).then(|| Gray { pixels: g.into_raw(), width, height })
}

/// A JPEG thumbnail at most `px` on its long side.
pub fn thumbnail_jpeg(path: &Path, px: i32) -> Option<Vec<u8>> {
    let rgb = decode(path, px)?.into_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&rgb).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_local_disk_mounts() {
        let mounts = "/dev/nvme0n1p2 / ext4 rw 0 0\nproc /proc proc rw 0 0\n/dev/nvme0n1p3 /home btrfs rw 0 0\n\
                      /dev/loop3 /snap/core/1 squashfs ro 0 0\n/dev/sdb1 /media/me/USB\\040Disk vfat rw 0 0\n\
                      /dev/sdc1 /mnt/backup ext4 rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n";
        let got: Vec<PathBuf> = parse_mounts(mounts).collect();
        assert_eq!(got, [PathBuf::from("/"), PathBuf::from("/home")]);
    }

    #[test]
    fn pairs_trashed_items_with_their_info() {
        let files = trash_files().unwrap();
        assert_eq!(trash_info(&files.join("a b.txt")), Some(files.parent().unwrap().join("info/a b.txt.trashinfo")));
        assert_eq!(trash_info(&files.join("dir/inner")), None);
    }

    #[test]
    fn decodes_and_shrinks() {
        let dir = std::env::temp_dir().join(format!("disklens-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.png");
        image::RgbImage::from_fn(600, 300, |x, _| image::Rgb([(x % 256) as u8, 0, 0])).save(&p).unwrap();
        let g = thumbnail_gray(&p, 256).unwrap();
        assert_eq!((g.width, g.height), (256, 128));
        assert!(thumbnail_jpeg(&p, 64).is_some_and(|j| j.starts_with(&[0xFF, 0xD8])));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
