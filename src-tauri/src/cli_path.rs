//! Puts the bundled `amby` command on the person's PATH from Settings, and takes it off again.
//!
//! macOS and Linux: a link `~/.local/bin/amby` to the CLI beside the app (a small wrapper script for an
//! AppImage), and, when the login shell does not already search `~/.local/bin`, one marked block in the
//! shell profile. Windows: the folder of the installed app in the user's `Path`.
//!
//! Only what Amby wrote is ever changed or removed: a foreign `~/.local/bin/amby` is left alone and reported,
//! a profile is only appended to, and removal deletes exactly the marked block.

use std::path::{Path, PathBuf};

use serde::Serialize;
use specta::Type;

/// Where the `amby` command stands for this person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CliPathState {
    /// No bundled CLI next to this app (a development build, or an unsupported package).
    Unavailable,
    /// `amby` is not set up by Amby.
    Off,
    /// `amby` runs this app's CLI from a new terminal.
    On,
    /// The link is in place but the shell does not search its folder, and Amby cannot add it (an
    /// unknown shell): the person adds the folder themself.
    #[cfg_attr(not(unix), allow(dead_code))]
    NeedsPath,
    /// Another program already has the name `amby` where Amby would put it.
    #[cfg_attr(not(unix), allow(dead_code))]
    Taken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliPathStatus {
    pub state: CliPathState,
    /// Where the command is (or would be) put: the link on macOS and Linux, the folder on Windows.
    pub location: Option<String>,
    /// The shell profile that gets (or has) Amby's PATH line, when one is needed.
    pub profile: Option<String>,
}

/// Stable codes for the interface; never raw OS text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CliPathError {
    Unavailable,
    #[cfg_attr(not(unix), allow(dead_code))]
    Taken,
    Failed,
}

#[cfg(unix)]
pub use unix::{install, remove, status, UnixEnv};

#[cfg(windows)]
pub use windows::{install, remove, status};

#[cfg_attr(not(unix), allow(dead_code))]
const BLOCK_START: &str = "# >>> Amby: the amby command >>>";
#[cfg_attr(not(unix), allow(dead_code))]
const BLOCK_END: &str = "# <<< Amby: the amby command <<<";
#[cfg_attr(not(unix), allow(dead_code))]
const WRAPPER_MARK: &str = "# Amby: runs the CLI inside the AppImage";

#[cfg_attr(not(unix), allow(dead_code))]
/// The profile text with Amby's block appended (a separating newline when the file does not end in one).
fn with_block(profile: &str) -> String {
    let mut text = profile.to_owned();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(BLOCK_START);
    text.push_str("\nexport PATH=\"$HOME/.local/bin:$PATH\"\n");
    text.push_str(BLOCK_END);
    text.push('\n');
    text
}

#[cfg_attr(not(unix), allow(dead_code))]
fn has_block(profile: &str) -> bool {
    profile.lines().any(|line| line.trim_end() == BLOCK_START)
}

#[cfg_attr(not(unix), allow(dead_code))]
/// The profile without Amby's block, or `None` when it has none (or an unfinished one, which is left alone).
/// Every other byte, line endings included, stays as it was.
fn without_block(profile: &str) -> Option<String> {
    let start = profile
        .match_indices(BLOCK_START)
        .map(|(at, _)| at)
        .find(|&at| at == 0 || profile[..at].ends_with('\n'))?;
    let end_mark = start + profile[start..].find(BLOCK_END)?;
    let mut end = end_mark + BLOCK_END.len();
    if profile[end..].starts_with("\r\n") {
        end += 2;
    } else if profile[end..].starts_with('\n') {
        end += 1;
    }
    let mut text = String::with_capacity(profile.len());
    text.push_str(&profile[..start]);
    text.push_str(&profile[end..]);
    Some(text)
}

/// Whether a `PATH` value searches `dir` (with or without a trailing slash).
fn path_has(path: &str, dir: &Path, separator: char) -> bool {
    let want = dir.to_string_lossy();
    let want = want.trim_end_matches(['/', '\\']);
    path.split(separator)
        .map(|entry| entry.trim().trim_end_matches(['/', '\\']))
        .any(|entry| {
            if separator == ';' {
                entry.eq_ignore_ascii_case(want)
            } else {
                entry == want
            }
        })
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    /// Everything the logic reads from the machine, so that tests run against a temporary home.
    pub struct UnixEnv {
        pub home: PathBuf,
        /// The login shell (`$SHELL`).
        pub shell: Option<PathBuf>,
        /// The CLI bundled next to this app.
        pub cli: Option<PathBuf>,
        /// The AppImage this app runs from (`$APPIMAGE`), on Linux.
        pub appimage: Option<PathBuf>,
        /// `PATH` of a new login shell, when it could be read.
        pub login_path: Option<String>,
    }

    impl UnixEnv {
        pub fn current() -> Self {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();
            let shell = std::env::var_os("SHELL").map(PathBuf::from);
            let cli = std::env::current_exe()
                .ok()
                .map(|exe| exe.with_file_name("amby"))
                .filter(|cli| cli.is_file());
            let appimage = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .filter(|path| path.is_file());
            let login_path = shell
                .as_deref()
                .and_then(|shell| read_login_path(shell, &home));
            Self {
                home,
                shell,
                cli,
                appimage,
                login_path,
            }
        }

        fn bin(&self) -> PathBuf {
            self.home.join(".local").join("bin")
        }

        fn link(&self) -> PathBuf {
            self.bin().join("amby")
        }

        fn available(&self) -> bool {
            self.cli.is_some() || self.appimage.is_some()
        }

        /// The profile Amby writes for this shell, or `None` for a shell it does not know.
        fn profile(&self) -> Option<PathBuf> {
            let name = self.shell.as_deref()?.file_name()?.to_str()?;
            match name {
                "zsh" => Some(self.home.join(".zprofile")),
                "bash" => {
                    let bash_profile = self.home.join(".bash_profile");
                    if cfg!(target_os = "macos") || bash_profile.exists() {
                        Some(bash_profile)
                    } else {
                        Some(self.home.join(".profile"))
                    }
                }
                "sh" | "dash" | "ksh" => Some(self.home.join(".profile")),
                _ => None,
            }
        }

        fn wrapper(&self, appimage: &Path) -> String {
            let quoted = appimage.to_string_lossy().replace('\'', "'\\''");
            format!("#!/bin/sh\n{WRAPPER_MARK}\nexec '{quoted}' --amby-cli \"$@\"\n")
        }

        /// What `~/.local/bin/amby` is to Amby: absent, Amby's (current or left from an older place of
        /// the app), or someone else's.
        fn link_kind(&self) -> LinkKind {
            let link = self.link();
            let Ok(meta) = fs::symlink_metadata(&link) else {
                return LinkKind::Absent;
            };
            if meta.file_type().is_symlink() {
                let Ok(target) = fs::read_link(&link) else {
                    return LinkKind::Foreign;
                };
                if self.cli.as_deref() == Some(target.as_path()) {
                    return LinkKind::Current;
                }
                let text = target.to_string_lossy();
                return if text.ends_with(".app/Contents/MacOS/amby") && !target.exists() {
                    LinkKind::Stale
                } else {
                    LinkKind::Foreign
                };
            }
            if meta.is_file() && meta.len() < 4096 {
                if let Ok(text) = fs::read_to_string(&link) {
                    if text.contains(WRAPPER_MARK) {
                        return match &self.appimage {
                            Some(appimage) if text == self.wrapper(appimage) => LinkKind::Current,
                            _ => LinkKind::Stale,
                        };
                    }
                }
            }
            LinkKind::Foreign
        }

        fn on_path(&self) -> bool {
            self.login_path
                .as_deref()
                .is_some_and(|path| path_has(path, &self.bin(), ':'))
        }

        fn profile_has_block(&self) -> bool {
            self.profile()
                .and_then(|profile| fs::read_to_string(profile).ok())
                .is_some_and(|text| has_block(&text))
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    enum LinkKind {
        Absent,
        Current,
        Stale,
        Foreign,
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    pub fn status(env: &UnixEnv) -> CliPathStatus {
        let location = Some(text(&env.link()));
        if !env.available() {
            return CliPathStatus {
                state: CliPathState::Unavailable,
                location: None,
                profile: None,
            };
        }
        let searched = env.on_path() || env.profile_has_block();
        let profile = if env.on_path() {
            None
        } else {
            env.profile().map(|p| text(&p))
        };
        let state = match env.link_kind() {
            LinkKind::Foreign => CliPathState::Taken,
            LinkKind::Current if searched => CliPathState::On,
            LinkKind::Current if env.profile().is_none() => CliPathState::NeedsPath,
            _ => CliPathState::Off,
        };
        CliPathStatus {
            state,
            location,
            profile,
        }
    }

    pub fn install(env: &UnixEnv) -> Result<CliPathStatus, CliPathError> {
        if !env.available() {
            return Err(CliPathError::Unavailable);
        }
        let link = env.link();
        match env.link_kind() {
            LinkKind::Foreign => return Err(CliPathError::Taken),
            LinkKind::Stale => fs::remove_file(&link).map_err(|_| CliPathError::Failed)?,
            LinkKind::Current | LinkKind::Absent => {}
        }
        if env.link_kind() == LinkKind::Absent {
            fs::create_dir_all(env.bin()).map_err(|_| CliPathError::Failed)?;
            if let Some(appimage) = &env.appimage {
                let script = env.wrapper(appimage);
                crate::frontmatter::atomic_write_bytes_new(&link, script.as_bytes())
                    .map_err(|_| CliPathError::Failed)?;
                fs::set_permissions(&link, fs::Permissions::from_mode(0o755))
                    .map_err(|_| CliPathError::Failed)?;
            } else if let Some(cli) = &env.cli {
                std::os::unix::fs::symlink(cli, &link).map_err(|_| CliPathError::Failed)?;
            }
        }
        if !env.on_path() && !env.profile_has_block() {
            if let Some(profile) = env.profile() {
                append_block(&profile)?;
            }
        }
        Ok(status(env))
    }

    /// Appends the block to the end of the profile. Appending never rewrites what the person wrote, and a
    /// profile that is a link (a dotfiles manager) is written through the link.
    fn append_block(profile: &Path) -> Result<(), CliPathError> {
        let current = match fs::read_to_string(profile) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => return Err(CliPathError::Failed),
        };
        let addition = &with_block(&current)[current.len()..];
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(profile)
            .map_err(|_| CliPathError::Failed)?;
        file.write_all(addition.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| CliPathError::Failed)
    }

    pub fn remove(env: &UnixEnv) -> Result<CliPathStatus, CliPathError> {
        match env.link_kind() {
            LinkKind::Current | LinkKind::Stale => {
                fs::remove_file(env.link()).map_err(|_| CliPathError::Failed)?
            }
            LinkKind::Absent | LinkKind::Foreign => {}
        }
        for name in [".zprofile", ".bash_profile", ".profile"] {
            let profile = env.home.join(name);
            let Ok(current) = fs::read_to_string(&profile) else {
                continue;
            };
            let Some(cleaned) = without_block(&current) else {
                continue;
            };
            // Through a link the real file is replaced, so the link of a dotfiles manager stays.
            let real = fs::canonicalize(&profile).map_err(|_| CliPathError::Failed)?;
            crate::frontmatter::atomic_write_bytes(&real, cleaned.as_bytes())
                .map_err(|_| CliPathError::Failed)?;
        }
        Ok(status(env))
    }

    /// `PATH` as a new login shell sets it. A shell that does not answer within a few seconds counts as
    /// unknown, which only means Amby adds its own line.
    fn read_login_path(shell: &Path, home: &Path) -> Option<String> {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let mut child = Command::new(shell)
            .args(["-l", "-c", "printf '%s' \"$PATH\""])
            .current_dir(home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
        Some(out)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // The value is read and written raw (REG_EXPAND_SZ, `%USERPROFILE%` kept unexpanded), then Windows is
    // told the environment changed so that new terminals see it.
    const READ: &str = "$k = Get-Item -LiteralPath 'HKCU:\\Environment'; \
        [Console]::Out.Write($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))";
    const WRITE: &str = "New-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'Path' \
        -PropertyType ExpandString -Value $env:AMBY_USER_PATH -Force | Out-Null; \
        [Environment]::SetEnvironmentVariable('AMBY_PATH_REFRESH', '1', 'User'); \
        [Environment]::SetEnvironmentVariable('AMBY_PATH_REFRESH', $null, 'User')";

    fn powershell(script: &str, value: Option<&str>) -> Option<String> {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(value) = value {
            command.env("AMBY_USER_PATH", value);
        }
        let output = command.output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn folder() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        exe.with_file_name("amby.exe")
            .is_file()
            .then(|| exe.parent().map(Path::to_path_buf))
            .flatten()
    }

    fn state(dir: &Path, user_path: &str) -> CliPathStatus {
        CliPathStatus {
            state: if path_has(user_path, dir, ';') {
                CliPathState::On
            } else {
                CliPathState::Off
            },
            location: Some(dir.to_string_lossy().into_owned()),
            profile: None,
        }
    }

    pub fn status() -> CliPathStatus {
        let Some(dir) = folder() else {
            return CliPathStatus {
                state: CliPathState::Unavailable,
                location: None,
                profile: None,
            };
        };
        state(&dir, &powershell(READ, None).unwrap_or_default())
    }

    pub fn install() -> Result<CliPathStatus, CliPathError> {
        let dir = folder().ok_or(CliPathError::Unavailable)?;
        let current = powershell(READ, None).ok_or(CliPathError::Failed)?;
        if !path_has(&current, &dir, ';') {
            let next = super::windows_path_with(&current, &dir);
            powershell(WRITE, Some(&next)).ok_or(CliPathError::Failed)?;
        }
        Ok(status())
    }

    pub fn remove() -> Result<CliPathStatus, CliPathError> {
        let dir = folder().ok_or(CliPathError::Unavailable)?;
        let current = powershell(READ, None).ok_or(CliPathError::Failed)?;
        if path_has(&current, &dir, ';') {
            let next = super::windows_path_without(&current, &dir);
            powershell(WRITE, Some(&next)).ok_or(CliPathError::Failed)?;
        }
        Ok(status())
    }
}

/// The user `Path` with `dir` appended; every existing entry stays exactly as written.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_path_with(current: &str, dir: &Path) -> String {
    let dir = dir.to_string_lossy();
    let trimmed = current.trim_end_matches(';');
    if trimmed.trim().is_empty() {
        dir.into_owned()
    } else {
        format!("{trimmed};{dir}")
    }
}

/// The user `Path` without the entries that are `dir`; the others stay exactly as written.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_path_without(current: &str, dir: &Path) -> String {
    current
        .split(';')
        .filter(|entry| !path_has(entry, dir, ';'))
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(test)]
#[path = "cli_path_tests.rs"]
mod tests;
