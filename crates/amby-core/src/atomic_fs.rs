//! Atomic file publication: temp sibling + fsync + rename, no-replace creation
//! (hard link with a `create_new` copy fallback), rename retry on Windows sharing
//! violations, and the test-only fault injection that makes every boundary
//! observable. Text conventions (BOM, line endings) stay in `frontmatter.rs`.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static FORCE_HARD_LINK_UNSUPPORTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NO_REPLACE_FALLBACK_COPY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static CREATE_TARGET_AT_PUBLISH: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
}

/// Flush the containing directory after publishing a rename. On Unix this
/// makes the rename durable across a sudden power loss, rather than merely
/// visible to the running process. Windows does not allow opening directories
/// as files through the standard library, so the renamed file's own sync is
/// still the strongest portable guarantee there.
#[cfg(unix)]
pub fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
pub fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

// Test-only fault injection makes every atomic-write boundary observable. It
// is deliberately compiled out of release builds, so no environment variable
// or hidden production switch can interrupt a user save.
#[cfg(test)]
thread_local! {
    static FAIL_ATOMIC_WRITE_STAGE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

// Test-only operation-level fault: fail the n-th `atomic_write_bytes` call on
// this thread, either before the rename (target untouched) or right after it
// (target published, caller sees an error as after a crash).
#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static FAIL_NTH_ATOMIC_WRITE: std::cell::Cell<(u64, bool)> = const { std::cell::Cell::new((0, false)) };
    static ATOMIC_WRITE_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static ABORT_AT_FAULT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(any(test, feature = "test-support"))]
pub fn inject_nth_atomic_write_failure(nth: u64, after_publish: bool) {
    ATOMIC_WRITE_CALLS.with(|calls| calls.set(0));
    FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.set((nth, after_publish)));
}

/// Like [`inject_nth_atomic_write_failure`] but the process aborts at the
/// fault, with no unwinding and no error return, to model a real crash.
#[cfg(test)]
pub(crate) fn inject_nth_atomic_write_abort(nth: u64, after_publish: bool) {
    ABORT_AT_FAULT.with(|abort| abort.set(true));
    inject_nth_atomic_write_failure(nth, after_publish);
}

#[cfg(any(test, feature = "test-support"))]
pub fn clear_atomic_write_failure() -> u64 {
    FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.set((0, false)));
    ATOMIC_WRITE_CALLS.with(|calls| calls.get())
}

/// Returns `Some(after_publish)` when this call is the one to fail.
#[cfg(any(test, feature = "test-support"))]
fn nth_write_fault() -> Option<bool> {
    let call = ATOMIC_WRITE_CALLS.with(|calls| {
        calls.set(calls.get() + 1);
        calls.get()
    });
    let (nth, after) = FAIL_NTH_ATOMIC_WRITE.with(|fault| fault.get());
    let hit = nth != 0 && call == nth;
    if hit && ABORT_AT_FAULT.with(|abort| abort.get()) && !after {
        // Crash before the rename: the target was never touched.
        std::process::abort();
    }
    hit.then_some(after)
}

#[cfg(not(any(test, feature = "test-support")))]
fn nth_write_fault() -> Option<bool> {
    None
}

#[cfg(test)]
fn fail_if_requested(stage: u64) -> Result<(), String> {
    if FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.get()) == stage {
        return Err(format!("injected atomic-write failure at stage {stage}"));
    }
    Ok(())
}

#[cfg(not(test))]
fn fail_if_requested(_stage: u64) -> Result<(), String> {
    Ok(())
}

/// How many bytes of the target name a temporary sibling keeps. A file name is
/// limited to about 255 bytes by most filesystems, so a temp name that embeds the
/// whole target name (plus the marker, pid and counter) could not be created for a
/// long name. The prefix keeps the `.<name>.amby-tmp-*` shape that the watcher and
/// the sync rules recognise.
const TEMP_NAME_PREFIX_BYTES: usize = 64;

/// A unique temporary sibling for a publication into `parent`.
fn temp_sibling(parent: &Path, name: &str) -> std::path::PathBuf {
    let mut end = name.len().min(TEMP_NAME_PREFIX_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let suffix = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{}.amby-tmp-{}-{suffix}",
        &name[..end],
        std::process::id()
    ))
}

/// Give the replacement the permission bits of the file it replaces, so an atomic
/// save does not widen (or narrow) the access the user set. Extended attributes
/// (Finder tags, quarantine) are not copied: there is no portable std API and the
/// project has no xattr dependency.
fn copy_existing_permissions(target: &Path, temp: &Path) {
    if let Ok(metadata) = fs::metadata(target) {
        let _ = fs::set_permissions(temp, metadata.permissions());
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum AtomicCreateError {
    AlreadyExists,
    Other(String),
}

fn atomic_create_error(error: std::io::Error) -> AtomicCreateError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        AtomicCreateError::AlreadyExists
    } else {
        AtomicCreateError::Other(error.to_string())
    }
}

fn hard_link_is_unsupported(error: &std::io::Error) -> bool {
    if matches!(error.kind(), std::io::ErrorKind::Unsupported) {
        return true;
    }
    // exFAT/FAT and network filesystems commonly report one of these native
    // errors instead of ErrorKind::Unsupported. The fallback remains safe
    // because it reserves the destination with create_new rather than rename.
    matches!(
        error.raw_os_error(),
        Some(1 | 5 | 17 | 18 | 31 | 45 | 50 | 95)
    )
}

fn create_hard_link(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.get()) {
        return Err(std::io::Error::from_raw_os_error(95));
    }
    fs::hard_link(source, target)
}

fn fallback_copy_temp_new(source: &Path, target: &Path) -> Result<(), AtomicCreateError> {
    let mut reader = fs::File::open(source).map_err(atomic_create_error)?;
    let mut created_target = false;
    let result = (|| -> Result<(), AtomicCreateError> {
        let mut writer = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(atomic_create_error)?;
        created_target = true;
        #[cfg(test)]
        if FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.get()) {
            return Err(AtomicCreateError::Other(
                "injected no-replace fallback copy failure".to_string(),
            ));
        }
        std::io::copy(&mut reader, &mut writer).map_err(atomic_create_error)?;
        writer.sync_all().map_err(atomic_create_error)
    })();
    if result.is_err() && created_target {
        let _ = fs::remove_file(target);
    }
    result
}

/// Publish a fully prepared sibling file without replacing an existing target.
/// Hard links give an all-or-nothing publish where supported. Filesystems that
/// reject them use a create_new reservation plus streamed, synced copy; the
/// reservation preserves the no-overwrite guarantee even under a collision.
pub fn publish_prepared_no_replace(temp: &Path, target: &Path) -> Result<(), AtomicCreateError> {
    #[cfg(test)]
    if let Some(content) = CREATE_TARGET_AT_PUBLISH.with(|pending| pending.borrow_mut().take()) {
        fs::write(target, content).map_err(atomic_create_error)?;
    }
    match create_hard_link(temp, target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AtomicCreateError::AlreadyExists)
        }
        Err(error) if hard_link_is_unsupported(&error) => fallback_copy_temp_new(temp, target),
        Err(error) => Err(atomic_create_error(error)),
    }
}

/// Rename `from` to `to` and fail with `AlreadyExists` instead of replacing a
/// file or directory that is already at `to`, even one that appeared a moment
/// ago. The check and the rename are one operation in the kernel
/// (`renameat2(RENAME_NOREPLACE)` on Linux, `renamex_np(RENAME_EXCL)` on macOS,
/// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` on Windows). A filesystem
/// that does not support the flag falls back to "look, then rename", which is
/// the best a plain `rename` can do there.
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    match rename_no_replace_os(from, to) {
        Err(error) if rename_flag_is_unsupported(&error) => {
            if fs::symlink_metadata(to).is_ok() {
                return Err(std::io::ErrorKind::AlreadyExists.into());
            }
            fs::rename(from, to)
        }
        other => other,
    }
}

#[cfg(unix)]
fn rename_flag_is_unsupported(error: &std::io::Error) -> bool {
    // ENOSYS, EINVAL (flag rejected by the filesystem), ENOTSUP / EOPNOTSUPP.
    matches!(
        error.raw_os_error(),
        Some(code) if code == libc::ENOSYS || code == libc::EINVAL || code == libc::ENOTSUP
    )
}

#[cfg(not(unix))]
fn rename_flag_is_unsupported(_error: &std::io::Error) -> bool {
    false
}

#[cfg(unix)]
fn c_path(path: &Path) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
}

#[cfg(target_os = "linux")]
fn rename_no_replace_os(from: &Path, to: &Path) -> std::io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the whole call.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn rename_no_replace_os(from: &Path, to: &Path) -> std::io::Result<()> {
    extern "C" {
        fn renamex_np(
            from: *const libc::c_char,
            to: *const libc::c_char,
            flags: libc::c_uint,
        ) -> libc::c_int;
    }
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: both pointers are valid NUL-terminated strings for the whole call.
    let result = unsafe { renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_no_replace_os(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // Flags 0: no MOVEFILE_REPLACE_EXISTING, so an existing target is an error
    // (ERROR_ALREADY_EXISTS / ERROR_FILE_EXISTS, both mapped to AlreadyExists).
    // SAFETY: both buffers are NUL-terminated and live for the whole call.
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if ok != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn rename_no_replace_os(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

pub(crate) fn rename_with_retry<F>(mut rename_op: F) -> std::io::Result<()>
where
    F: FnMut() -> std::io::Result<()>,
{
    let mut attempts = 0;
    loop {
        match rename_op() {
            Ok(()) => return Ok(()),
            Err(err) => {
                attempts += 1;
                let is_retryable = if cfg!(windows) {
                    matches!(err.raw_os_error(), Some(5) | Some(32))
                } else {
                    #[cfg(test)]
                    {
                        err.raw_os_error() == Some(32) || err.raw_os_error() == Some(5)
                    }
                    #[cfg(not(test))]
                    {
                        false
                    }
                };

                if is_retryable && attempts <= 5 {
                    let sleep_ms = 5 * 3_u64.pow(attempts - 1);
                    std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
                    continue;
                }
                return Err(err);
            }
        }
    }
}

pub fn atomic_rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    rename_with_retry(|| fs::rename(from, to))
}

/// Write a complete replacement beside the target, sync it to disk, then
/// rename it into place. A unique sibling avoids collisions between concurrent
/// writes and keeps a crash from leaving a truncated user file at `path`.
pub fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.to_string_lossy()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = temp_sibling(parent, &name);

    let nth_fault = nth_write_fault();
    let write_result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        if nth_fault == Some(false) {
            return Err("injected atomic-write failure before publish".to_owned());
        }
        fail_if_requested(1)?;
        file.write_all(content).map_err(|e| e.to_string())?;
        fail_if_requested(2)?;
        file.sync_all().map_err(|e| e.to_string())?;
        fail_if_requested(3)?;
        drop(file);
        copy_existing_permissions(path, &tmp);
        fail_if_requested(4)?;
        atomic_rename_with_retry(&tmp, path).map_err(|e| e.to_string())?;
        if nth_fault == Some(true) {
            #[cfg(any(test, feature = "test-support"))]
            if ABORT_AT_FAULT.with(|abort| abort.get()) {
                std::process::abort();
            }
            return Err("injected atomic-write failure after publish".to_owned());
        }
        sync_parent_directory(parent)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Create a new binary file without ever replacing an existing one. The shared
/// publish helper prefers an all-or-nothing hard link and falls back to a
/// create_new reservation plus synced stream copy where hard links are absent.
pub fn atomic_write_bytes_new(path: &Path, content: &[u8]) -> Result<(), AtomicCreateError> {
    let parent = path.parent().ok_or_else(|| {
        AtomicCreateError::Other(format!("Path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = temp_sibling(parent, &name);

    let write_result = (|| -> Result<(), AtomicCreateError> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        file.write_all(content)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        file.sync_all()
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        drop(file);
        publish_prepared_no_replace(&tmp, path)?;
        // The target is now safely published. A stale temp link is harmless,
        // but remove it eagerly so it cannot clutter the user vault.
        let _ = fs::remove_file(&tmp);
        sync_parent_directory(parent).map_err(AtomicCreateError::Other)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

/// Atomically copy a file to a new destination without replacing an existing file.
/// Reads via streaming buffer to avoid allocating the whole source file in memory,
/// enforces `max_bytes`, fsyncs, and uses the shared no-replace publisher.
pub fn atomic_copy_file_new(
    source: &Path,
    path: &Path,
    max_bytes: u64,
) -> Result<u64, AtomicCreateError> {
    let parent = path.parent().ok_or_else(|| {
        AtomicCreateError::Other(format!("Path has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = temp_sibling(parent, &name);

    let copy_result = (|| -> Result<u64, AtomicCreateError> {
        let mut reader =
            fs::File::open(source).map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        let mut writer = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;

        let mut total_copied: u64 = 0;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read_bytes = reader
                .read(&mut buffer)
                .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
            if read_bytes == 0 {
                break;
            }
            total_copied += read_bytes as u64;
            if total_copied > max_bytes {
                return Err(AtomicCreateError::Other(format!(
                    "File size exceeds maximum allowed limit ({max_bytes} bytes)"
                )));
            }
            writer
                .write_all(&buffer[..read_bytes])
                .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        }

        writer
            .sync_all()
            .map_err(|err| AtomicCreateError::Other(err.to_string()))?;
        drop(writer);

        publish_prepared_no_replace(&tmp, path)?;

        let _ = fs::remove_file(&tmp);
        sync_parent_directory(parent).map_err(AtomicCreateError::Other)?;
        Ok(total_copied)
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    copy_result
}

/// Text wrapper for [`atomic_write_bytes_new`].
pub fn atomic_write_new(path: &Path, content: &str) -> Result<(), AtomicCreateError> {
    atomic_write_bytes_new(path, content.as_bytes())
}

#[cfg(test)]
#[path = "atomic_fs_test.rs"]
mod tests;
