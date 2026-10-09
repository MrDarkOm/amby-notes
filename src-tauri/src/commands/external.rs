//! Opening something with the system's own program: an attachment of a note, or a web
//! address in the browser. Both are the user's explicit click, and both are narrow:
//!
//! * a file is opened only when it lies in an `assets` folder inside the vault and its
//!   type is on the list below. Opening a program or a script means running it, and a
//!   note with an attachment can come from outside, so there is a list of what may be
//!   opened and not a list of what may not;
//! * an address is opened only when it is an `http` or `https` one.
//!
//! The webview passes the note and the address of the attachment as the note wrote it;
//! everything else is decided here.

use std::path::{Component, Path, PathBuf};

use crate::paths;
use crate::vault_context::VaultContext;

/// What may be handed to the system program. Documents and media, no archives, no
/// scripts, no programs, no macro-enabled Office files, no SVG (it can carry scripts).
const OPENABLE_EXTENSIONS: &[&str] = &[
    // documents
    "pdf", "txt", "csv", "docx", "xlsx", "pptx", "odt", "ods", "odp", // audio
    "mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac", // video
    "mp4", "m4v", "mov", "webm", "ogv", // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif",
];

const MAX_ADDRESS_LEN: usize = 2048;

/// The codes the webview turns into a message.
pub const ERR_NOT_FOUND: &str = "AttachmentNotFound";
pub const ERR_OUTSIDE_ASSETS: &str = "AttachmentOutsideAssets";
pub const ERR_TYPE_NOT_ALLOWED: &str = "AttachmentTypeNotAllowed";
pub const ERR_ADDRESS_NOT_ALLOWED: &str = "AddressNotAllowed";
pub const ERR_OPEN_FAILED: &str = "OpenFailed";

fn extension_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            OPENABLE_EXTENSIONS
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(ext))
        })
        .unwrap_or(false)
}

/// Where an attachment written as `attachment` in `note` can be: next to the note, in the
/// vault for `assets/...` (notes outside bundles keep them there), and, for the bare name
/// of an Obsidian embed, in the `assets` folders.
fn candidates(vault: &Path, note: &Path, attachment: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let note_dir = note.parent().unwrap_or(vault);
    let normalized = attachment.replace('\\', "/");
    found.push(note_dir.join(&normalized));
    if normalized.starts_with("assets/") {
        found.push(vault.join(&normalized));
    }
    if !normalized.contains('/') {
        found.push(note_dir.join("assets").join(&normalized));
        found.push(vault.join("assets").join(&normalized));
    }
    found
}

/// The real path of the attachment, if and only if it may be opened.
pub(crate) fn resolve_openable_attachment(
    vault: &Path,
    note: &Path,
    attachment: &str,
) -> Result<PathBuf, &'static str> {
    if attachment.is_empty() || attachment.len() > 1024 || attachment.contains('\0') {
        return Err(ERR_NOT_FOUND);
    }
    let relative = Path::new(attachment);
    if relative.has_root()
        || relative
            .components()
            .any(|part| matches!(part, Component::Prefix(_) | Component::ParentDir))
    {
        return Err(ERR_OUTSIDE_ASSETS);
    }
    let vault_real = vault.canonicalize().map_err(|_| ERR_NOT_FOUND)?;
    let mut refusal = ERR_NOT_FOUND;
    for candidate in candidates(vault, note, attachment) {
        // `confine` follows symbolic links: a link to something outside the vault fails
        // here, and a link inside it is judged by the file it leads to below.
        let real = match paths::confine(vault, &candidate) {
            Ok(real) => real,
            Err(_) if candidate.exists() => {
                refusal = ERR_OUTSIDE_ASSETS;
                continue;
            }
            Err(_) => continue,
        };
        if !real.is_file() {
            continue;
        }
        let Ok(inside) = real.strip_prefix(&vault_real) else {
            refusal = ERR_OUTSIDE_ASSETS;
            continue;
        };
        let parts: Vec<_> = inside.components().collect();
        let normal_only = parts.iter().all(|part| match part {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            _ => false,
        });
        let in_assets = parts[..parts.len().saturating_sub(1)].iter().any(|part| {
            matches!(part, Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case("assets"))
        });
        if !normal_only || !in_assets {
            return Err(ERR_OUTSIDE_ASSETS);
        }
        if !extension_allowed(&real) {
            return Err(ERR_TYPE_NOT_ALLOWED);
        }
        return Ok(real);
    }
    Err(refusal)
}

/// An `http` or `https` address, written the way it is handed to the system.
pub(crate) fn parse_web_address(address: &str) -> Result<String, &'static str> {
    let address = address.trim();
    if address.is_empty()
        || address.len() > MAX_ADDRESS_LEN
        || address.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(ERR_ADDRESS_NOT_ALLOWED);
    }
    let url = reqwest::Url::parse(address).map_err(|_| ERR_ADDRESS_NOT_ALLOWED)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ERR_ADDRESS_NOT_ALLOWED);
    }
    Ok(url.into())
}

/// Windows returns `\\?\C:\...` for a real path; the shell wants the plain form.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

fn hand_to_system(target: &std::ffi::OsStr) -> Result<(), &'static str> {
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    let mut child = command.arg(target).spawn().map_err(|_| ERR_OPEN_FAILED)?;
    // Reap the helper so it does not stay a zombie; its exit code says nothing useful.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Opens an attachment of a note with the system's program for its type.
#[tauri::command]
#[specta::specta]
pub fn open_attachment(
    context: tauri::State<'_, VaultContext>,
    note_path: String,
    attachment_path: String,
) -> Result<(), String> {
    let note = paths::guard(&context, &note_path)?;
    let vault = context.root()?;
    let file = resolve_openable_attachment(&vault, &note, &attachment_path)
        .map_err(|code| code.to_string())?;
    hand_to_system(plain_path(&file).as_os_str()).map_err(|code| code.to_string())
}

/// Opens a web address in the system's browser.
#[tauri::command]
#[specta::specta]
pub fn open_web_address(address: String) -> Result<(), String> {
    let address = parse_web_address(&address).map_err(|code| code.to_string())?;
    hand_to_system(std::ffi::OsStr::new(&address)).map_err(|code| code.to_string())
}

/// The title and the description of the page at a web address, fetched once because the
/// person asked for it. The rules (public addresses only, size, time, plain text) are in
/// [`crate::page_info`].
#[tauri::command]
#[specta::specta]
pub async fn fetch_page_info(address: String) -> Result<crate::page_info::PageInfo, String> {
    crate::page_info::fetch_page_info(&address, &crate::page_info::Limits::production())
        .await
        .map_err(|code| code.to_string())
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
        let dir = std::env::temp_dir().join(format!("amby-open-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn vault_with(files: &[&str]) -> (PathBuf, PathBuf) {
        let vault = temp_dir("vault");
        for file in files {
            let path = vault.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "x").unwrap();
        }
        let note = vault.join("Note.md");
        fs::write(&note, "x").unwrap();
        (vault, note)
    }

    #[test]
    fn opens_an_allowed_file_in_the_vault_assets_folder() {
        let (vault, note) = vault_with(&["assets/report.pdf", "assets/Song.MP3"]);
        let found = resolve_openable_attachment(&vault, &note, "assets/report.pdf").unwrap();
        assert_eq!(
            found,
            vault.join("assets/report.pdf").canonicalize().unwrap()
        );
        // The extension is judged in any letter case.
        assert!(resolve_openable_attachment(&vault, &note, "assets/Song.MP3").is_ok());
    }

    #[test]
    fn opens_the_assets_folder_of_a_bundle_note_and_a_bare_embed_name() {
        let (vault, _) = vault_with(&["Project/assets/plan.pdf", "assets/clip.mp4"]);
        let bundle_note = vault.join("Project/index.md");
        fs::write(&bundle_note, "x").unwrap();
        assert!(resolve_openable_attachment(&vault, &bundle_note, "assets/plan.pdf").is_ok());
        let note = vault.join("Note.md");
        assert!(resolve_openable_attachment(&vault, &note, "clip.mp4").is_ok());
    }

    #[test]
    fn refuses_a_file_that_is_not_in_an_assets_folder() {
        let (vault, note) = vault_with(&["docs/report.pdf", "report.pdf"]);
        for path in ["docs/report.pdf", "report.pdf"] {
            assert_eq!(
                resolve_openable_attachment(&vault, &note, path),
                Err(ERR_OUTSIDE_ASSETS),
                "{path}"
            );
        }
    }

    #[test]
    fn refuses_a_file_in_a_hidden_folder_even_under_assets() {
        let (vault, note) = vault_with(&[".amby/assets/data.pdf", "assets/.hidden/x.pdf"]);
        for path in [".amby/assets/data.pdf", "assets/.hidden/x.pdf"] {
            assert_eq!(
                resolve_openable_attachment(&vault, &note, path),
                Err(ERR_OUTSIDE_ASSETS),
                "{path}"
            );
        }
    }

    #[test]
    fn refuses_traversal_absolute_paths_and_empty_names() {
        let (vault, note) = vault_with(&["assets/report.pdf"]);
        let outside = temp_dir("outside");
        fs::create_dir_all(outside.join("assets")).unwrap();
        fs::write(outside.join("assets/secret.pdf"), "x").unwrap();
        let absolute = outside.join("assets/secret.pdf");
        for path in [
            "../assets/report.pdf",
            "assets/../../secret.pdf",
            "assets/../report.pdf",
            absolute.to_str().unwrap(),
            "/etc/passwd",
        ] {
            assert_eq!(
                resolve_openable_attachment(&vault, &note, path),
                Err(ERR_OUTSIDE_ASSETS),
                "{path}"
            );
        }
        assert_eq!(
            resolve_openable_attachment(&vault, &note, ""),
            Err(ERR_NOT_FOUND)
        );
        assert_eq!(
            resolve_openable_attachment(&vault, &note, "assets/missing.pdf"),
            Err(ERR_NOT_FOUND)
        );
    }

    #[test]
    fn refuses_types_that_would_run_something() {
        let names = [
            "tool.command",
            "tool.sh",
            "tool.bat",
            "tool.exe",
            "tool.scpt",
            "tool.jar",
            "tool.app",
            "tool.TXT.command",
            "tool.COMMAND",
            "macro.docm",
            "image.svg",
            "bundle.zip",
            "noextension",
            "report.pdf.command",
            "report.pdf.",
        ];
        let files: Vec<String> = names.iter().map(|name| format!("assets/{name}")).collect();
        let refs: Vec<&str> = files.iter().map(String::as_str).collect();
        let (vault, note) = vault_with(&refs);
        for file in &files {
            let result = resolve_openable_attachment(&vault, &note, file);
            assert!(
                matches!(
                    result,
                    Err(ERR_TYPE_NOT_ALLOWED) | Err(ERR_OUTSIDE_ASSETS) | Err(ERR_NOT_FOUND)
                ),
                "{file}: {result:?}"
            );
        }
    }

    #[test]
    fn refuses_a_double_extension_only_when_the_last_one_is_not_allowed() {
        let (vault, note) = vault_with(&["assets/a.pdf.command", "assets/b.command.pdf"]);
        assert_eq!(
            resolve_openable_attachment(&vault, &note, "assets/a.pdf.command"),
            Err(ERR_TYPE_NOT_ALLOWED)
        );
        // A name that merely contains a program's extension is a PDF to the system.
        assert!(resolve_openable_attachment(&vault, &note, "assets/b.command.pdf").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symbolic_link_that_leads_outside_the_vault() {
        use std::os::unix::fs::symlink;
        let (vault, note) = vault_with(&["assets/report.pdf"]);
        let outside = temp_dir("link-outside");
        fs::write(outside.join("secret.pdf"), "x").unwrap();
        fs::write(outside.join("run.command"), "x").unwrap();
        symlink(outside.join("secret.pdf"), vault.join("assets/link.pdf")).unwrap();
        symlink(&outside, vault.join("assets/dir")).unwrap();
        symlink(
            outside.join("run.command"),
            vault.join("assets/looks-fine.pdf"),
        )
        .unwrap();
        for path in [
            "assets/link.pdf",
            "assets/dir/secret.pdf",
            "assets/looks-fine.pdf",
        ] {
            assert_eq!(
                resolve_openable_attachment(&vault, &note, path),
                Err(ERR_OUTSIDE_ASSETS),
                "{path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn judges_a_link_inside_the_vault_by_the_file_it_leads_to() {
        use std::os::unix::fs::symlink;
        let (vault, note) = vault_with(&["docs/report.pdf", "assets/script.command"]);
        symlink(
            vault.join("docs/report.pdf"),
            vault.join("assets/shortcut.pdf"),
        )
        .unwrap();
        symlink(
            vault.join("assets/script.command"),
            vault.join("assets/nice.pdf"),
        )
        .unwrap();
        // Leads out of `assets` inside the vault: refused.
        assert_eq!(
            resolve_openable_attachment(&vault, &note, "assets/shortcut.pdf"),
            Err(ERR_OUTSIDE_ASSETS)
        );
        // Looks like a PDF but is a script: the real file's type decides.
        assert_eq!(
            resolve_openable_attachment(&vault, &note, "assets/nice.pdf"),
            Err(ERR_TYPE_NOT_ALLOWED)
        );
    }

    #[test]
    fn accepts_only_http_and_https_addresses() {
        assert_eq!(
            parse_web_address("https://example.com/a?b=1#c").as_deref(),
            Ok("https://example.com/a?b=1#c")
        );
        assert_eq!(
            parse_web_address(" http://example.com ").as_deref(),
            Ok("http://example.com/")
        );
        for address in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "ftp://example.com/f",
            "mailto:a@b.c",
            "ssh://host",
            "vscode://open",
            "x-apple.systempreferences:",
            "https://user:pass@example.com/",
            "example.com",
            "https://exa mple.com",
            "https://example.com/\nsecond",
            "",
            "   ",
            "-a",
        ] {
            assert_eq!(
                parse_web_address(address),
                Err(ERR_ADDRESS_NOT_ALLOWED),
                "{address:?}"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_ADDRESS_LEN));
        assert_eq!(parse_web_address(&long), Err(ERR_ADDRESS_NOT_ALLOWED));
    }

    #[test]
    fn the_list_of_types_holds_nothing_that_runs() {
        for ext in [
            "app", "command", "sh", "bat", "cmd", "exe", "msi", "scpt", "jar", "py", "js", "svg",
            "html", "zip", "dmg", "docm", "xlsm", "pkg", "lnk", "url", "webloc", "ps1", "vbs",
        ] {
            assert!(!OPENABLE_EXTENSIONS.contains(&ext), "{ext}");
        }
    }
}
