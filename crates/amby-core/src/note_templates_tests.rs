//! The two note modules (docs/vault-format.md#templates-and-daily-notes): when they count as
//! enabled, what their settings say, and how a template becomes the text of a new note.

use super::*;
use crate::vault_tools::modules::{Module, Modules};
use std::fs;
use std::path::Path;

/// A vault folder removed when the test ends.
struct Vault(std::path::PathBuf);

impl Vault {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn vault(workspace: Option<&str>) -> Vault {
    let dir = std::env::temp_dir().join(format!("amby-note-modules-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&dir).unwrap();
    let dir = Vault(dir.canonicalize().unwrap());
    if let Some(workspace) = workspace {
        fs::create_dir_all(dir.path().join(".amby")).unwrap();
        fs::write(dir.path().join(".amby/workspace.json"), workspace).unwrap();
    }
    dir
}

fn enabled(root: &Path) -> (bool, bool) {
    let modules = Modules::read(root).unwrap();
    (
        modules.includes(Module::Templates),
        modules.includes(Module::Daily),
    )
}

#[test]
fn templates_are_on_and_daily_notes_opt_in_without_a_workspace_file() {
    assert_eq!(enabled(vault(None).path()), (true, false));
    let minimal = vault(Some(r#"{"layout":{"activePresetId":"minimal"}}"#));
    assert_eq!(enabled(minimal.path()), (false, false));
}

#[test]
fn a_module_list_saved_before_the_note_modules_gets_templates_only() {
    let old = vault(Some(
        r#"{"profile":{"id":"custom","catalogRevision":"2026-09-20"},"enabledModules":["amby.tags"]}"#,
    ));
    assert_eq!(enabled(old.path()), (true, false));
    let unrevised = vault(Some(r#"{"profile":{"id":"custom"},"enabledModules":[]}"#));
    assert_eq!(enabled(unrevised.path()), (true, false));
    let chosen = vault(Some(
        r#"{"profile":{"id":"custom","catalogRevision":"2026-09-20"},"enabledModules":["amby.daily"]}"#,
    ));
    assert_eq!(enabled(chosen.path()), (true, true));
}

#[test]
fn a_current_list_is_taken_as_written() {
    let off = vault(Some(&format!(
        r#"{{"profile":{{"id":"custom","catalogRevision":"{NOTE_MODULES_REVISION}"}},"enabledModules":["amby.daily"]}}"#
    )));
    assert_eq!(enabled(off.path()), (false, true));
    let minimal = vault(Some(
        r#"{"profile":{"id":"minimal","catalogRevision":"2026-09-20"},"enabledModules":[]}"#,
    ));
    assert_eq!(enabled(minimal.path()), (false, false));
}

#[test]
fn settings_default_and_read_back() {
    let defaults = NoteSettings::read(vault(None).path()).unwrap();
    assert_eq!(defaults.templates_folder, "Templates");
    assert_eq!(defaults.daily_folder, "Daily");
    assert_eq!(defaults.daily_template, None);
    let custom = vault(Some(
        r#"{"moduleSettings":{"templates":{"folder":"Meta/Шаблоны/"},"daily":{"folder":"Journal\\2026","template":"Day"}}}"#,
    ));
    let settings = NoteSettings::read(custom.path()).unwrap();
    assert_eq!(settings.templates_folder, "Meta/Шаблоны");
    assert_eq!(settings.daily_folder, "Journal/2026");
    assert_eq!(settings.daily_template.as_deref(), Some("Day"));
}

#[test]
fn unsafe_folder_settings_fall_back_to_the_defaults() {
    for folder in ["../out", ".amby", "/abs", "a/../b", ""] {
        let workspace = format!(
            r#"{{"moduleSettings":{{"templates":{{"folder":{folder:?}}},"daily":{{"folder":{folder:?},"template":""}}}}}}"#
        );
        let settings = NoteSettings::read(vault(Some(&workspace)).path()).unwrap();
        assert_eq!(settings.templates_folder, "Templates", "{folder}");
        assert_eq!(settings.daily_folder, "Daily", "{folder}");
        assert_eq!(settings.daily_template, None, "{folder}");
    }
    let root = vault(Some(r#"{"moduleSettings":{"daily":{"folder":"."}}}"#));
    assert_eq!(NoteSettings::read(root.path()).unwrap().daily_folder, "");
}

#[test]
fn render_drops_the_template_id_and_fills_placeholders() {
    let moment = Moment::on("2026-11-20").unwrap();
    let text = "---\r\namby-id: 01JC0000000000000000000009\r\nkind: x\r\n---\r\n# {{title}}\r\n{{date}} {{time}}\r\n";
    let rendered = render(text, "Plan", &moment).unwrap();
    assert!(!rendered.contains("amby-id"), "{rendered}");
    assert!(rendered.contains("kind: x\r\n"), "{rendered}");
    assert!(rendered.contains("# Plan\r\n2026-11-20 "), "{rendered}");
    assert!(!rendered.contains("{{"), "{rendered}");
    assert!(Moment::on("2026-02-30").is_none());
}

#[test]
fn templates_are_listed_from_the_configured_folder() {
    let root = vault(None);
    fs::create_dir_all(root.path().join("Meta/Sub")).unwrap();
    fs::write(root.path().join("Meta/A.md"), "a").unwrap();
    fs::write(root.path().join("Meta/Sub/B.md"), "b").unwrap();
    fs::write(root.path().join("Meta/.hidden.md"), "h").unwrap();
    let names: Vec<_> = list(root.path(), "Meta")
        .unwrap()
        .into_iter()
        .map(|template| (template.name, template.path))
        .collect();
    assert_eq!(
        names,
        [
            ("A".to_owned(), "Meta/A.md".to_owned()),
            ("Sub/B".to_owned(), "Meta/Sub/B.md".to_owned())
        ]
    );
    assert!(list(root.path(), "Missing").unwrap().is_empty());
    assert_eq!(template_text(root.path(), "Meta", "Sub/B").unwrap(), "b");
    assert_eq!(template_text(root.path(), "Meta", "Nope"), Err("notFound"));
    assert_eq!(daily_relative("", "2026-11-20"), "2026-11-20.md");
    assert_eq!(daily_relative("Daily", "2026-11-20"), "Daily/2026-11-20.md");
}
