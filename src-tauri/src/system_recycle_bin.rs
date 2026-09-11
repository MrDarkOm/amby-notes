use crate::bundle::path_string;
use crate::model::FsMutationResult;
use std::path::Path;

/// Move a vault item into the operating system's trash instead of keeping a
/// second application-owned copy. The preview is shared with the archive
/// implementation so bundles and their Markdown index entries are handled in
/// exactly the same way.
pub fn move_to_system_trash(vault: &Path, path: &Path) -> Result<FsMutationResult, String> {
    let preview = crate::recycle_bin::preview_move_to_trash(vault, path)?;
    let deleted_paths = preview
        .deleted_paths
        .iter()
        .map(|path| path_string(path))
        .collect();
    move_path(&preview.original_path)?;
    Ok(FsMutationResult {
        primary_id: None,
        primary_path: None,
        path_changes: Vec::new(),
        deleted_paths,
        deleted_ids: Vec::new(),
    })
}

#[cfg(target_os = "windows")]
fn move_path(path: &Path) -> Result<(), String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    let source = windows_shell_source(path);
    let mut operation = SHFILEOPSTRUCTW {
        hwnd: null_mut(),
        wFunc: FO_DELETE,
        pFrom: source.as_ptr(),
        pTo: null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: null_mut(),
        lpszProgressTitle: null(),
    };
    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 {
        return Err(format!(
            "Could not move {} to the system Recycle Bin (code {code})",
            path_string(path)
        ));
    }
    if operation.fAnyOperationsAborted != 0 {
        return Err("Moving the path to the system Recycle Bin was cancelled".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_shell_source(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    let mut source: Vec<u16> = path.as_os_str().encode_wide().collect();
    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    // std::fs::canonicalize returns verbatim paths on Windows, while the
    // legacy shell operation rejects their `\\?\` prefix as DE_INVALIDFILES.
    if source.starts_with(VERBATIM_UNC_PREFIX) {
        source.splice(0..VERBATIM_UNC_PREFIX.len(), [b'\\' as u16, b'\\' as u16]);
    } else if source.starts_with(VERBATIM_PREFIX) {
        source.drain(0..VERBATIM_PREFIX.len());
    }
    source.extend([0, 0]);
    source
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::windows_shell_source;
    use std::path::Path;

    #[test]
    fn shell_source_removes_verbatim_prefix_and_is_double_null_terminated() {
        let source = windows_shell_source(Path::new(r"\\?\C:\vault\Note.md"));
        let expected: Vec<u16> = "C:\\vault\\Note.md\0\0".encode_utf16().collect();
        assert_eq!(source, expected);
    }

    #[test]
    fn shell_source_converts_verbatim_unc_prefix() {
        let source = windows_shell_source(Path::new(r"\\?\UNC\server\share\Note.md"));
        let expected: Vec<u16> = "\\\\server\\share\\Note.md\0\0".encode_utf16().collect();
        assert_eq!(source, expected);
    }
}

#[cfg(target_os = "macos")]
fn move_path(path: &Path) -> Result<(), String> {
    let path_text = path.to_string_lossy().into_owned();
    let script = r#"on run argv
tell application "Finder" to delete POSIX file (item 1 of argv)
end run"#;
    let status = std::process::Command::new("osascript")
        .args(["-e", script, &path_text])
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not move {} to the system Trash",
            path_string(path)
        ))
    }
}

#[cfg(target_os = "linux")]
fn move_path(path: &Path) -> Result<(), String> {
    let status = std::process::Command::new("gio")
        .arg("trash")
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not move {} to the system Trash",
            path_string(path)
        ))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn move_path(path: &Path) -> Result<(), String> {
    Err(format!(
        "Moving {} to the system Trash is not supported on this platform",
        path_string(path)
    ))
}
