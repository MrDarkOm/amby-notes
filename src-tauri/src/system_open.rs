//! Handing something to the system's own program: a file or a folder to open, a file to show
//! in the file manager, a web address to open in the browser. One place for what used to be four
//! copies. The caller has already decided that the thing may be opened; this module only knows
//! how each system wants to be asked, never goes through a shell, and never waits for the program.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The code the webview turns into a message when the system could not be asked.
pub const ERR_OPEN_FAILED: &str = "OpenFailed";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }
}

/// A program with its arguments, ready to be started. `raw_tail` is one more argument that is passed
/// to the program exactly as written (Windows `explorer` wants `/select,"path"` with its own quotes).
#[derive(Debug, PartialEq, Eq)]
pub struct SystemCommand {
    pub program: &'static str,
    pub args: Vec<OsString>,
    pub raw_tail: Option<OsString>,
}

/// Windows returns `\\?\C:\...` for a real path; the shell wants the plain form.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Asks the system to open `target` (a file, a folder or an address) with its own program.
pub fn open_command(platform: Platform, target: &OsStr) -> SystemCommand {
    let program = match platform {
        Platform::Windows => "explorer",
        Platform::MacOs => "open",
        Platform::Linux => "xdg-open",
    };
    SystemCommand {
        program,
        args: vec![target.to_os_string()],
        raw_tail: None,
    }
}

/// Opens a directory itself in the file manager. For files, macOS and Windows select the item in its
/// folder. Linux has no common way to select, so a file is shown by opening the folder that holds
/// it: handing the file to `xdg-open` would run it, past the
/// list of types that `open_attachment` keeps.
pub fn reveal_command(platform: Platform, target: &Path, is_dir: bool) -> SystemCommand {
    let target = plain_path(target);
    if is_dir {
        return open_command(platform, target.as_os_str());
    }
    match platform {
        Platform::Windows => SystemCommand {
            program: "explorer",
            args: Vec::new(),
            raw_tail: Some(OsString::from(format!("/select,\"{}\"", target.display()))),
        },
        Platform::MacOs => SystemCommand {
            program: "open",
            args: vec![OsString::from("-R"), target.into_os_string()],
            raw_tail: None,
        },
        Platform::Linux => {
            let shown = target.parent().map(Path::to_path_buf).unwrap_or(target);
            open_command(platform, shown.as_os_str())
        }
    }
}

fn run(spec: SystemCommand) -> Result<(), &'static str> {
    let mut command = Command::new(spec.program);
    command.args(&spec.args);
    #[cfg(target_os = "windows")]
    if let Some(tail) = &spec.raw_tail {
        use std::os::windows::process::CommandExt;
        command.raw_arg(tail);
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(tail) = &spec.raw_tail {
        command.arg(tail);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ERR_OPEN_FAILED)?;
    // Reap the helper so it does not stay a zombie; its exit code says nothing useful
    // (`explorer` answers 1 when it worked).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens a file or a folder with the system's program.
pub fn open_path(path: &Path) -> Result<(), &'static str> {
    run(open_command(
        Platform::current(),
        plain_path(path).as_os_str(),
    ))
}

/// Opens a web address in the system's browser. The caller has checked it; it is one argument.
pub fn open_address(address: &str) -> Result<(), &'static str> {
    run(open_command(Platform::current(), OsStr::new(address)))
}

/// Shows a file or a folder in the system's file manager.
pub fn reveal_path(path: &Path) -> Result<(), &'static str> {
    run(reveal_command(Platform::current(), path, path.is_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(text: &str) -> OsString {
        OsString::from(text)
    }

    #[test]
    fn linux_shows_the_folder_of_a_file_and_never_runs_the_file() {
        let command = reveal_command(Platform::Linux, Path::new("/vault/Note.md"), false);
        assert_eq!(command.program, "xdg-open");
        assert_eq!(command.args, vec![arg("/vault")]);
        let command = reveal_command(Platform::Linux, Path::new("/vault/assets/run.sh"), false);
        assert_eq!(command.args, vec![arg("/vault/assets")]);
    }

    #[test]
    fn folders_open_themselves_instead_of_selecting_them_in_the_parent() {
        for (platform, program, folder) in [
            (Platform::Linux, "xdg-open", "/vault/My Notes"),
            (Platform::MacOs, "open", "/Users/owner/Documents/My Notes"),
            (Platform::Windows, "explorer", r"\\?\C:\Vault\My Notes"),
        ] {
            let command = reveal_command(platform, Path::new(folder), true);
            assert_eq!(command.program, program);
            assert_eq!(
                command.args,
                vec![plain_path(Path::new(folder)).into_os_string()]
            );
            assert_eq!(command.raw_tail, None);
        }
    }

    #[test]
    fn macos_selects_the_item_in_finder() {
        let command = reveal_command(Platform::MacOs, Path::new("/vault/Note.md"), false);
        assert_eq!(command.program, "open");
        assert_eq!(command.args, vec![arg("-R"), arg("/vault/Note.md")]);
    }

    #[test]
    fn windows_selects_the_item_without_the_extended_prefix() {
        let command = reveal_command(
            Platform::Windows,
            Path::new(r"\\?\C:\Vault\Мои заметки\Note.md"),
            false,
        );
        assert_eq!(command.program, "explorer");
        assert!(command.args.is_empty());
        assert_eq!(
            command.raw_tail,
            Some(arg(r#"/select,"C:\Vault\Мои заметки\Note.md""#))
        );
    }

    #[test]
    fn windows_keeps_a_network_path_as_it_is() {
        let command = reveal_command(
            Platform::Windows,
            Path::new(r"\\?\UNC\server\share\Note.md"),
            false,
        );
        assert_eq!(
            command.raw_tail,
            Some(arg(r#"/select,"\\?\UNC\server\share\Note.md""#))
        );
    }

    #[test]
    fn opening_asks_each_system_for_its_own_program_with_one_argument() {
        for (platform, program) in [
            (Platform::Windows, "explorer"),
            (Platform::MacOs, "open"),
            (Platform::Linux, "xdg-open"),
        ] {
            let command = open_command(platform, OsStr::new("https://example.com/"));
            assert_eq!(command.program, program);
            assert_eq!(command.args, vec![arg("https://example.com/")]);
            assert_eq!(command.raw_tail, None);
        }
    }

    #[test]
    fn the_extended_prefix_is_dropped_only_for_a_drive_path() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\a\b")),
            PathBuf::from(r"C:\a\b")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\s\x")),
            PathBuf::from(r"\\?\UNC\s\x")
        );
        assert_eq!(plain_path(Path::new("/a/b")), PathBuf::from("/a/b"));
    }

    #[test]
    fn a_missing_program_is_the_code_not_the_text_of_the_error() {
        let result = run(SystemCommand {
            program: "amby-no-such-program-for-the-test",
            args: Vec::new(),
            raw_tail: None,
        });
        assert_eq!(result, Err(ERR_OPEN_FAILED));
    }

    #[cfg(unix)]
    #[test]
    fn a_started_program_is_reaped() {
        // `true` ends at once; the helper thread must collect it, and starting must succeed.
        let result = run(SystemCommand {
            program: "true",
            args: Vec::new(),
            raw_tail: None,
        });
        assert_eq!(result, Ok(()));
    }
}
