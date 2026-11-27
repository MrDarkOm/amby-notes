use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn desktop_binary() -> Option<PathBuf> {
    if let Some(path) = env::var_os("AMBY_DESKTOP_BIN").filter(|path| !path.is_empty()) {
        return Some(path.into());
    }
    let name = if cfg!(windows) {
        "amby-notes.exe"
    } else {
        "amby-notes"
    };
    let current = env::current_exe().ok()?;
    let sibling = current.parent()?.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }
    if cfg!(target_os = "macos") {
        return None; // LaunchServices can find an installed app bundle.
    }
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

pub fn open(root: &Path, relative: &str) -> Result<(), &'static str> {
    const FLAG: &str = amby_core::desktop_launch::OPEN_NOTE_FLAG;
    if let Some(bin) = desktop_binary() {
        Command::new(bin)
            .arg(FLAG)
            .arg(root)
            .arg(relative)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "desktopUnavailable")?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if Command::new("/usr/bin/open")
        // Launch a second process when needed so the single-instance plugin
        // forwards the CLI arguments to the running app.
        .args(["-n", "-a", "Amby", "--args", FLAG])
        .arg(root)
        .arg(relative)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
    {
        return Ok(());
    }
    Err("desktopUnavailable")
}
