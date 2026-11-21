//! The Templates and Daily notes commands: notes are made through the regular creation path
//! (fresh ID, indexed), today's note is made once, and a switched-off module refuses.

use crate::commands::note_templates::{
    create_from_template_inner, create_template_inner, open_daily_inner,
};
use crate::vault_context::VaultContext;
use crate::watcher::WatcherState;
use amby_core::note_templates::Moment;
use std::fs;
use std::path::{Path, PathBuf};
use ulid::Ulid;

const TEMPLATE_ID: &str = "01JC0000000000000000000009";

struct Vault(PathBuf);

impl Vault {
    fn new(workspace: Option<&str>) -> Self {
        let root = std::env::temp_dir().join(format!("amby-note-modules-{}", Ulid::generate()));
        fs::create_dir_all(root.join("Templates")).unwrap();
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(
            root.join("Templates/Meeting.md"),
            format!("---\namby-id: {TEMPLATE_ID}\nkind: meeting\n---\n# {{{{title}}}}\n"),
        )
        .unwrap();
        if let Some(workspace) = workspace {
            fs::create_dir_all(root.join(".amby")).unwrap();
            fs::write(root.join(".amby/workspace.json"), workspace).unwrap();
        }
        Self(root.canonicalize().unwrap())
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn activate(root: &Path) -> VaultContext {
    let context = VaultContext::new();
    context
        .activate(root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    context
}

fn id_of(text: &str) -> Option<&str> {
    text.lines().find_map(|line| line.strip_prefix("amby-id: "))
}

#[test]
fn a_note_from_a_template_is_created_and_indexed_with_its_own_id() {
    let vault = Vault::new(None);
    let context = activate(&vault.0);
    let before = fs::read_to_string(vault.path("Templates/Meeting.md")).unwrap();
    let outcome = create_from_template_inner(
        &context,
        &WatcherState::new(),
        vault.path("Projects").to_string_lossy().into_owned(),
        "Standup".to_owned(),
        "Meeting",
    )
    .unwrap();
    let text = fs::read_to_string(vault.path("Projects/Standup.md")).unwrap();
    assert!(
        text.contains("kind: meeting\n") && text.contains("# Standup\n"),
        "{text}"
    );
    let id = id_of(&text).unwrap();
    assert_ne!(id, TEMPLATE_ID);
    assert_eq!(outcome.mutation.primary_id.as_deref(), Some(id));
    assert_eq!(
        fs::read_to_string(vault.path("Templates/Meeting.md")).unwrap(),
        before
    );
}

#[test]
fn todays_note_is_created_once_in_the_configured_folder_from_its_template() {
    let vault = Vault::new(Some(
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-20"},"enabledModules":["amby.templates","amby.daily"],"moduleSettings":{"daily":{"folder":"Journal/2026","template":"Meeting"}}}"#,
    ));
    let context = activate(&vault.0);
    let moment = Moment::on("2026-11-20").unwrap();
    let (first, folder) = open_daily_inner(&context, &WatcherState::new(), &moment).unwrap();
    let note = vault.path("Journal/2026/2026-11-20.md");
    assert!(first.created);
    assert_eq!(PathBuf::from(&first.path), note);
    // The highest new folder, which brings the rest with it.
    assert_eq!(folder, Some(vault.path("Journal")));
    assert!(first.mutation.is_some());
    let text = fs::read_to_string(&note).unwrap();
    assert!(text.contains("# 2026-11-20\n"), "{text}");
    let (again, folder) = open_daily_inner(&context, &WatcherState::new(), &moment).unwrap();
    assert!(!again.created && again.mutation.is_none() && folder.is_none());
    assert_eq!(PathBuf::from(&again.path), note);
    assert_eq!(fs::read_to_string(&note).unwrap(), text);
}

#[test]
fn a_switched_off_module_creates_nothing() {
    let vault = Vault::new(Some(
        r#"{"profile":{"id":"custom","catalogRevision":"2026-11-20"},"enabledModules":[]}"#,
    ));
    let context = activate(&vault.0);
    let error = open_daily_inner(
        &context,
        &WatcherState::new(),
        &Moment::on("2026-11-20").unwrap(),
    )
    .err()
    .unwrap();
    assert_eq!(error.detail, "moduleDisabled");
    let error = create_from_template_inner(
        &context,
        &WatcherState::new(),
        vault.path("Projects").to_string_lossy().into_owned(),
        "X".to_owned(),
        "Meeting",
    )
    .err()
    .unwrap();
    assert_eq!(error.detail, "moduleDisabled");
    assert!(!vault.path("Daily").exists() && !vault.path("Projects/X.md").exists());
}

#[test]
fn a_new_template_is_made_in_the_configured_folder_with_the_placeholders() {
    let vault = Vault::new(Some(
        r#"{"moduleSettings":{"templates":{"folder":"Meta/Шаблоны"}}}"#,
    ));
    let context = activate(&vault.0);
    let (outcome, folder) =
        create_template_inner(&context, &WatcherState::new(), "Встреча".to_owned()).unwrap();
    let note = vault.path("Meta/Шаблоны/Встреча.md");
    assert_eq!(
        outcome.mutation.primary_path.as_deref().map(PathBuf::from),
        Some(note.clone())
    );
    assert_eq!(folder, Some(vault.path("Meta")));
    let text = fs::read_to_string(&note).unwrap();
    assert!(
        text.contains("{{title}}") && text.contains("{{date}}"),
        "{text}"
    );
    assert!(id_of(&text).is_some(), "{text}");
    // The same name again does not replace it.
    assert!(create_template_inner(&context, &WatcherState::new(), "Встреча".to_owned()).is_err());
    assert_eq!(fs::read_to_string(&note).unwrap(), text);
}
