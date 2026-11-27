//! Whether a program that serves local models is on this computer, so the connection form can
//! offer to download it. Only a fixed list of providers is known, the renderer never passes a
//! path, and nothing is run: the answer comes from looking for the program's files.

use std::path::{Path, PathBuf};

/// Where one provider's program may be.
struct Program {
    /// The provider id used by the connection form.
    provider: &'static str,
    /// Application bundles / folders under the usual application roots (`/Applications`, `~/Applications`).
    macos_apps: &'static [&'static str],
    /// Files under `%LOCALAPPDATA%\Programs` and `%ProgramFiles%`.
    windows_files: &'static [&'static str],
    /// Files under the home folder.
    home_files: &'static [&'static str],
    /// Command line programs looked up in `PATH` and the usual places missing from a GUI app's `PATH`.
    commands: &'static [&'static str],
}

const PROGRAMS: &[Program] = &[
    Program {
        provider: "lmstudio",
        macos_apps: &["LM Studio.app"],
        windows_files: &["LM Studio\\LM Studio.exe", "LM-Studio\\LM Studio.exe"],
        home_files: &[".lmstudio/bin/lms", ".lmstudio/bin/lms.exe"],
        commands: &["lms"],
    },
    Program {
        provider: "ollama",
        macos_apps: &["Ollama.app"],
        windows_files: &["Ollama\\ollama app.exe", "Ollama\\ollama.exe"],
        home_files: &[],
        commands: &["ollama"],
    },
    Program {
        provider: "mlx",
        macos_apps: &[],
        windows_files: &[],
        home_files: &[],
        commands: &["mlx_lm.server", "mlx_lm"],
    },
    Program {
        provider: "llamacpp",
        macos_apps: &[],
        windows_files: &[],
        home_files: &[],
        commands: &["llama-server"],
    },
];

/// Where a start from the Dock or the Start menu does not look.
const EXTRA_COMMAND_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

struct Places {
    app_roots: Vec<PathBuf>,
    program_roots: Vec<PathBuf>,
    home: Option<PathBuf>,
    command_dirs: Vec<PathBuf>,
}

impl Places {
    fn of_this_computer() -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from);
        let mut app_roots = vec![PathBuf::from("/Applications")];
        app_roots.extend(home.iter().map(|home| home.join("Applications")));
        let mut program_roots = Vec::new();
        for variable in ["LOCALAPPDATA", "ProgramFiles"] {
            if let Some(root) = std::env::var_os(variable) {
                let root = PathBuf::from(root);
                program_roots.push(if variable == "LOCALAPPDATA" {
                    root.join("Programs")
                } else {
                    root
                });
            }
        }
        let mut command_dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        command_dirs.extend(EXTRA_COMMAND_DIRS.iter().map(PathBuf::from));
        command_dirs.extend(home.iter().map(|home| home.join(".local/bin")));
        Self {
            app_roots,
            program_roots,
            home,
            command_dirs,
        }
    }
}

fn exists_in(roots: &[PathBuf], names: &[&str]) -> bool {
    roots
        .iter()
        .any(|root| names.iter().any(|name| root.join(name).exists()))
}

fn is_present(program: &Program, places: &Places) -> bool {
    if exists_in(&places.app_roots, program.macos_apps)
        || exists_in(&places.program_roots, program.windows_files)
    {
        return true;
    }
    if let Some(home) = &places.home {
        if program
            .home_files
            .iter()
            .any(|file| Path::new(home).join(file).exists())
        {
            return true;
        }
    }
    program.commands.iter().any(|name| {
        places
            .command_dirs
            .iter()
            .any(|dir| dir.join(name).is_file() || dir.join(format!("{name}.exe")).is_file())
    })
}

fn check(provider: &str, places: &Places) -> Result<bool, String> {
    PROGRAMS
        .iter()
        .find(|program| program.provider == provider)
        .map(|program| is_present(program, places))
        .ok_or_else(|| "UnknownProvider".to_string())
}

/// Whether the program of a local provider (`lmstudio`, `ollama`, `mlx`, `llamacpp`) is installed.
#[tauri::command]
#[specta::specta]
pub fn ai_local_app_installed(provider: String) -> Result<bool, String> {
    check(&provider, &Places::of_this_computer())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby-local-apps-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn empty_places(root: &Path) -> Places {
        Places {
            app_roots: vec![root.join("Applications")],
            program_roots: vec![root.join("Programs")],
            home: Some(root.join("home")),
            command_dirs: vec![root.join("bin")],
        }
    }

    #[test]
    fn nothing_found_in_an_empty_computer() {
        let root = temp_dir("empty");
        let places = empty_places(&root);
        for provider in ["lmstudio", "ollama", "mlx", "llamacpp"] {
            assert_eq!(check(provider, &places), Ok(false), "{provider}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_an_application_bundle_a_home_file_and_a_command() {
        let root = temp_dir("found");
        fs::create_dir_all(root.join("Applications/Ollama.app")).unwrap();
        fs::create_dir_all(root.join("home/.lmstudio/bin")).unwrap();
        fs::write(root.join("home/.lmstudio/bin/lms"), "x").unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/llama-server"), "x").unwrap();
        let places = empty_places(&root);
        assert_eq!(check("ollama", &places), Ok(true));
        assert_eq!(check("lmstudio", &places), Ok(true));
        assert_eq!(check("llamacpp", &places), Ok(true));
        assert_eq!(check("mlx", &places), Ok(false));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_provider_it_does_not_know() {
        let root = temp_dir("unknown");
        assert_eq!(
            check("../etc/passwd", &empty_places(&root)),
            Err("UnknownProvider".to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }
}
