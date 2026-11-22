use std::fs;
use std::path::PathBuf;

use super::*;

fn vault(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("amby-{name}-{}", ulid::Ulid::generate()));
    fs::create_dir_all(root.join("chosen")).unwrap();
    fs::create_dir_all(root.join("other")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    fs::write(root.join("chosen/a.md"), "# A\nold line\n").unwrap();
    fs::write(root.join("other/b.md"), "# B\nsecret\n").unwrap();
    root
}

fn scope() -> WriteScope {
    WriteScope {
        vault: false,
        notes: vec!["other/b.md".into()],
        folders: vec!["chosen".into()],
    }
}

fn replace(path: &str, old: &str, new: &str) -> ProposalOp {
    ProposalOp::Replace {
        path: path.into(),
        old_text: old.into(),
        new_text: new.into(),
        replace_all: false,
    }
}

#[test]
fn a_proposal_changes_nothing_and_shows_a_diff() {
    let root = vault("prop-diff");
    let before = fs::read(root.join("chosen/a.md")).unwrap();
    let proposal = propose(
        &root,
        &scope(),
        None,
        replace("chosen/a.md", "old line", "new line"),
    )
    .unwrap();
    assert_eq!(proposal.path, "chosen/a.md");
    assert!(proposal.diff.contains("-old line") && proposal.diff.contains("+new line"));
    assert_eq!(fs::read(root.join("chosen/a.md")).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn writes_stay_inside_the_chosen_notes_and_folders_unless_the_vault_switch_is_on() {
    let root = vault("prop-scope");
    fs::write(root.join("c.md"), "# C\nx\n").unwrap();
    let narrow = scope();
    // A chosen note and a note in a chosen folder, including a new one.
    assert!(propose(
        &root,
        &narrow,
        None,
        replace("other/b.md", "secret", "open")
    )
    .is_ok());
    let new = ProposalOp::New {
        path: "chosen/new.md".into(),
        content: "hello".into(),
    };
    assert!(propose(&root, &narrow, None, new).is_ok());
    // Anything else is refused, for every operation.
    for op in [
        replace("c.md", "x", "y"),
        ProposalOp::Append {
            path: "c.md".into(),
            content: "z".into(),
        },
        ProposalOp::New {
            path: "other/new.md".into(),
            content: "hello".into(),
        },
        replace("chosen/../c.md", "x", "y"),
        replace(".amby/x.md", "x", "y"),
    ] {
        assert_eq!(
            propose(&root, &narrow, None, op).unwrap_err(),
            "outsideWriteScope"
        );
    }
    let wide = WriteScope {
        vault: true,
        ..narrow
    };
    assert!(propose(&root, &wide, None, replace("c.md", "x", "y")).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn apply_writes_an_ai_edit_version_and_undo_restores_the_bytes() {
    let root = vault("prop-apply");
    let original = fs::read(root.join("chosen/a.md")).unwrap();
    let proposal = propose(
        &root,
        &scope(),
        None,
        replace("chosen/a.md", "old line", "new line"),
    )
    .unwrap();
    let applied = apply(&root, &scope(), &proposal).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/a.md")).unwrap(),
        "# A\nnew line\n"
    );
    let versions = crate::history::list_snapshots(&root, &root.join("chosen/a.md")).unwrap();
    assert_eq!(versions[0].reason, "ai-edit");
    assert_eq!(Some(versions[0].id.clone()), applied.snapshot_id);
    let plan = undo_plan(&root, &applied).unwrap();
    assert!(matches!(&plan, UndoPlan::Restore { .. }));
    undo(&root, &scope(), &applied).unwrap();
    assert_eq!(fs::read(root.join("chosen/a.md")).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_outdated_proposal_is_refused_and_writes_nothing() {
    let root = vault("prop-outdated");
    let proposal = propose(
        &root,
        &scope(),
        None,
        replace("chosen/a.md", "old line", "new line"),
    )
    .unwrap();
    fs::write(
        root.join("chosen/a.md"),
        "# A\nold line\nedited elsewhere\n",
    )
    .unwrap();
    assert_eq!(apply(&root, &scope(), &proposal).unwrap_err(), "outdated");
    assert_eq!(
        fs::read_to_string(root.join("chosen/a.md")).unwrap(),
        "# A\nold line\nedited elsewhere\n"
    );
    let new = propose(
        &root,
        &scope(),
        None,
        ProposalOp::New {
            path: "chosen/n.md".into(),
            content: "hi".into(),
        },
    )
    .unwrap();
    fs::write(root.join("chosen/n.md"), "someone else").unwrap();
    assert_eq!(apply(&root, &scope(), &new).unwrap_err(), "outdated");
    assert_eq!(
        fs::read_to_string(root.join("chosen/n.md")).unwrap(),
        "someone else"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn undo_refuses_when_the_note_changed_after_the_apply() {
    let root = vault("prop-undo-changed");
    let proposal = propose(
        &root,
        &scope(),
        None,
        replace("chosen/a.md", "old line", "new line"),
    )
    .unwrap();
    let applied = apply(&root, &scope(), &proposal).unwrap();
    fs::write(root.join("chosen/a.md"), "# A\nmine\n").unwrap();
    assert_eq!(undo(&root, &scope(), &applied).unwrap_err(), "changedSince");
    assert_eq!(
        fs::read_to_string(root.join("chosen/a.md")).unwrap(),
        "# A\nmine\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn append_and_new_note_apply_and_a_new_note_undoes_by_trash_plan() {
    let root = vault("prop-new");
    let append = propose(
        &root,
        &scope(),
        None,
        ProposalOp::Append {
            path: "chosen/a.md".into(),
            content: "tail\n".into(),
        },
    )
    .unwrap();
    apply(&root, &scope(), &append).unwrap();
    assert!(fs::read_to_string(root.join("chosen/a.md"))
        .unwrap()
        .ends_with("tail\n"));
    let new = propose(
        &root,
        &scope(),
        None,
        ProposalOp::New {
            path: "chosen/n".into(),
            content: "hi".into(),
        },
    )
    .unwrap();
    assert_eq!(new.path, "chosen/n.md");
    let applied = apply(&root, &scope(), &new).unwrap();
    assert!(applied.snapshot_id.is_none());
    assert!(fs::read_to_string(root.join("chosen/n.md"))
        .unwrap()
        .contains("hi"));
    assert!(
        matches!(undo_plan(&root, &applied).unwrap(), UndoPlan::Trash { path } if path == "chosen/n.md")
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_no_op_proposal_is_refused() {
    let root = vault("prop-noop");
    assert_eq!(
        propose(
            &root,
            &scope(),
            None,
            replace("chosen/a.md", "old line", "old line")
        )
        .unwrap_err(),
        "noChange"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_append_starts_a_new_paragraph_instead_of_continuing_a_quote() {
    let root = vault("prop-paragraph");
    fs::write(root.join("chosen/q.md"), "# Q\n> [!ASK]\n> text").unwrap();
    let append = |path: &str, text: &str| ProposalOp::Append {
        path: path.into(),
        content: text.into(),
    };
    let proposal = propose(&root, &scope(), None, append("chosen/q.md", "Pavel")).unwrap();
    apply(&root, &scope(), &proposal).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/q.md")).unwrap(),
        "# Q\n> [!ASK]\n> text\n\nPavel"
    );
    // A note that already ends with a blank line gets no extra one.
    fs::write(root.join("chosen/r.md"), "# R\ntext\n\n").unwrap();
    let proposal = propose(&root, &scope(), None, append("chosen/r.md", "more")).unwrap();
    apply(&root, &scope(), &proposal).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/r.md")).unwrap(),
        "# R\ntext\n\nmore\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn list_items_appended_to_a_list_continue_it_and_the_final_line_break_stays() {
    let root = vault("prop-list");
    let append = |path: &str, text: &str| ProposalOp::Append {
        path: path.into(),
        content: text.into(),
    };
    let cases = [
        (
            "# S\n\n- Milk\n- Bread\n",
            "- Eggs",
            "# S\n\n- Milk\n- Bread\n- Eggs\n",
        ),
        (
            "# S\n\n- Milk\n- Bread",
            "- Eggs",
            "# S\n\n- Milk\n- Bread\n- Eggs",
        ),
        ("1. One\n", "2. Two", "1. One\n2. Two\n"),
        // Another kind of list, or a paragraph, still starts a new block.
        ("- Milk\n", "1. First", "- Milk\n\n1. First\n"),
        ("- Milk\n", "Plain text", "- Milk\n\nPlain text\n"),
        (
            "# S\r\n\r\n- Milk\r\n",
            "- Eggs",
            "# S\r\n\r\n- Milk\r\n- Eggs\r\n",
        ),
    ];
    for (index, (before, added, after)) in cases.into_iter().enumerate() {
        let path = format!("chosen/l{index}.md");
        fs::write(root.join(&path), before).unwrap();
        let proposal = propose(&root, &scope(), None, append(&path, added)).unwrap();
        apply(&root, &scope(), &proposal).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(&path)).unwrap(),
            after,
            "{before:?}"
        );
    }
    fs::remove_dir_all(root).unwrap();
}

// ----- property proposals -----

#[test]
fn a_note_named_without_its_extension_is_found_for_text_and_property_changes() {
    let (root, conn) = property_vault("prop-no-extension");
    // The note in the context is `chosen/meeting.md`; the model names it without `.md`.
    let narrow = WriteScope {
        vault: false,
        notes: vec!["chosen/meeting.md".into()],
        folders: vec![],
    };
    let set = ProposalOp::SetProperty {
        path: "chosen/meeting".into(),
        name: "status".into(),
        value: serde_json::json!("done"),
        property_type: None,
    };
    let proposal = propose(&root, &narrow, Some(&conn), set).unwrap();
    assert_eq!(proposal.path, "chosen/meeting.md");
    // Applying it finds the note as well (the change itself carries the found path).
    apply(&root, &narrow, &proposal).unwrap();
    assert!(fs::read_to_string(root.join("chosen/meeting.md"))
        .unwrap()
        .contains("status: done"));
    let append = ProposalOp::Append {
        path: "chosen/meeting".into(),
        content: "More".into(),
    };
    assert_eq!(
        propose(&root, &narrow, None, append).unwrap().path,
        "chosen/meeting.md"
    );
    // A name that is not a note stays as it is and is refused as before.
    let missing = ProposalOp::Append {
        path: "chosen/nothing".into(),
        content: "More".into(),
    };
    assert_eq!(
        propose(&root, &narrow, None, missing).unwrap_err(),
        "outsideWriteScope"
    );
    fs::remove_dir_all(root).unwrap();
}

const MEETING: &str = "---\r\namby-id: 01JC0000000000000000000001\r\nstatus: active\r\ntags: [work, meeting]\r\n---\r\n# Meeting\r\n\r\nAgenda\r\n";

fn property_vault(name: &str) -> (PathBuf, rusqlite::Connection) {
    let root = vault(name);
    fs::create_dir_all(root.join(".amby/properties")).unwrap();
    fs::write(
        root.join(".amby/properties/layout.json"),
        "{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":1,\"version\":1}\n",
    )
    .unwrap();
    fs::write(root.join("chosen/meeting.md"), MEETING).unwrap();
    let conn = crate::index::read_only::disk_catalog(&root).unwrap();
    (root, conn)
}

fn set_status(value: &str) -> ProposalOp {
    ProposalOp::SetProperty {
        path: "chosen/meeting.md".into(),
        name: "status".into(),
        value: serde_json::json!(value),
        property_type: None,
    }
}

#[test]
fn a_property_proposal_describes_the_change_and_writes_nothing() {
    let (root, conn) = property_vault("prop-set-preview");
    let before = fs::read(root.join("chosen/meeting.md")).unwrap();
    let proposal = propose(&root, &scope(), Some(&conn), set_status("paused")).unwrap();
    assert_eq!(proposal.path, "chosen/meeting.md");
    assert!(
        proposal.diff.contains("-status: active"),
        "{}",
        proposal.diff
    );
    assert!(
        proposal.diff.contains("+status: paused"),
        "{}",
        proposal.diff
    );
    assert_eq!(fs::read(root.join("chosen/meeting.md")).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn applying_a_property_change_leaves_an_ai_edit_version_and_undo_restores_the_bytes() {
    let (root, conn) = property_vault("prop-set-apply");
    let proposal = propose(&root, &scope(), Some(&conn), set_status("paused")).unwrap();
    let applied = apply(&root, &scope(), &proposal).unwrap();
    let text = fs::read_to_string(root.join("chosen/meeting.md")).unwrap();
    assert!(text.contains("status: paused"), "{text}");
    assert!(
        text.contains("amby-id: 01JC0000000000000000000001"),
        "{text}"
    );
    let versions = crate::history::list_snapshots(&root, &root.join("chosen/meeting.md")).unwrap();
    assert!(
        !versions.is_empty() && versions.iter().all(|v| v.reason == "ai-edit"),
        "{versions:?}"
    );
    assert!(applied.snapshot_id.is_some());
    undo(&root, &scope(), &applied).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/meeting.md")).unwrap(),
        MEETING
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_property_proposal_is_outdated_when_the_note_changed_and_stays_in_scope() {
    let (root, conn) = property_vault("prop-set-outdated");
    let proposal = propose(&root, &scope(), Some(&conn), set_status("paused")).unwrap();
    fs::write(
        root.join("chosen/meeting.md"),
        MEETING.replace("Agenda", "Agenda!"),
    )
    .unwrap();
    assert_eq!(apply(&root, &scope(), &proposal).unwrap_err(), "outdated");
    let outside = ProposalOp::SetProperty {
        path: "other/b.md".into(),
        name: "status".into(),
        value: serde_json::json!("x"),
        property_type: None,
    };
    let narrow = WriteScope {
        notes: vec![],
        ..scope()
    };
    assert_eq!(
        propose(&root, &narrow, Some(&conn), outside).unwrap_err(),
        "outsideWriteScope"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn deleting_and_renaming_a_property_are_proposals_too() {
    let (root, conn) = property_vault("prop-delete");
    let delete = ProposalOp::DeleteProperty {
        path: "chosen/meeting.md".into(),
        name: "status".into(),
    };
    let proposal = propose(&root, &scope(), Some(&conn), delete).unwrap();
    assert!(
        proposal.diff.contains("-status: active"),
        "{}",
        proposal.diff
    );
    let applied = apply(&root, &scope(), &proposal).unwrap();
    assert!(!fs::read_to_string(root.join("chosen/meeting.md"))
        .unwrap()
        .contains("status:"));
    undo(&root, &scope(), &applied).unwrap();
    let rename = ProposalOp::RenameProperty {
        path: "chosen/meeting.md".into(),
        name: "status".into(),
        new_name: "state".into(),
    };
    let proposal = propose(&root, &scope(), Some(&conn), rename).unwrap();
    assert!(
        proposal.diff.contains("-status") && proposal.diff.contains("+state"),
        "{}",
        proposal.diff
    );
    apply(&root, &scope(), &proposal).unwrap();
    assert!(fs::read_to_string(root.join("chosen/meeting.md"))
        .unwrap()
        .contains("state: active"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_property_that_would_not_change_is_refused() {
    let (root, conn) = property_vault("prop-noop");
    assert_eq!(
        propose(&root, &scope(), Some(&conn), set_status("active")).unwrap_err(),
        "noChange"
    );
    fs::remove_dir_all(root).unwrap();
}

// ----- database proposals -----

struct Table {
    root: PathBuf,
    database: String,
    row: String,
    property: String,
}

fn table(name: &str) -> Table {
    use crate::vault_tools::{execute_offline, Mutation};
    let root = vault(name);
    let created = execute_offline(
        &root,
        "",
        &Mutation::CreateDatabase {
            parent: "chosen".into(),
            name: "Tasks".into(),
        },
    )
    .unwrap();
    let database = created["databaseId"].as_str().unwrap().to_owned();
    let property = execute_offline(
        &root,
        "",
        &Mutation::AddDatabaseProperty {
            database_id: database.clone(),
            name: "Done".into(),
            property_type: "checkbox".into(),
            expected_revision: created["revision"].as_str().unwrap().into(),
            options: vec![],
        },
    )
    .unwrap();
    let row = execute_offline(
        &root,
        "",
        &Mutation::CreateDatabaseRow {
            database_id: database.clone(),
            title: "First".into(),
        },
    )
    .unwrap();
    Table {
        root,
        database,
        row: row["noteId"].as_str().unwrap().to_owned(),
        property: property["propertyId"].as_str().unwrap().to_owned(),
    }
}

fn done(table: &Table, checked: bool) -> ProposalOp {
    ProposalOp::SetDatabaseValue {
        database_id: table.database.clone(),
        note_id: table.row.clone(),
        property_id: table.property.clone(),
        value: serde_json::json!({"type":"checkbox","checked":checked}),
        expected_revision: String::new(),
        operation_id: String::new(),
    }
}

fn row_file(table: &Table) -> PathBuf {
    let rows =
        crate::vault_tools::database::query(&table.root, &table.database, None, None, 10).unwrap();
    table.root.join(rows["rows"][0]["path"].as_str().unwrap())
}

#[test]
fn a_cell_proposal_names_the_property_and_the_value_and_writes_nothing() {
    let t = table("db-set-preview");
    let file = row_file(&t);
    let before = fs::read(&file).unwrap();
    let proposal = propose(&t.root, &scope(), None, done(&t, true)).unwrap();
    assert!(proposal.diff.contains("Done"), "{}", proposal.diff);
    assert!(proposal.diff.contains("true"), "{}", proposal.diff);
    assert_eq!(fs::read(&file).unwrap(), before);
    // The proposal carries the revision it was made against, so a stale one is refused.
    let ProposalOp::SetDatabaseValue {
        expected_revision,
        operation_id,
        ..
    } = &proposal.op
    else {
        panic!("{:?}", proposal.op)
    };
    assert!(!expected_revision.is_empty() && !operation_id.is_empty());
    fs::remove_dir_all(t.root).unwrap();
}

#[test]
fn applying_a_cell_leaves_an_ai_edit_version_and_undo_restores_the_row() {
    let t = table("db-set-apply");
    let file = row_file(&t);
    let before = fs::read(&file).unwrap();
    let proposal = propose(&t.root, &scope(), None, done(&t, true)).unwrap();
    let applied = apply(&t.root, &scope(), &proposal).unwrap();
    assert!(fs::read_to_string(&file).unwrap().contains("Done: true"));
    let versions = crate::history::list_snapshots(&t.root, &file).unwrap();
    assert!(
        !versions.is_empty() && versions.iter().all(|v| v.reason == "ai-edit"),
        "{versions:?}"
    );
    undo(&t.root, &scope(), &applied).unwrap();
    assert_eq!(fs::read(&file).unwrap(), before);
    fs::remove_dir_all(t.root).unwrap();
}

#[test]
fn a_cell_proposal_is_outdated_when_the_row_changed_and_stays_in_scope() {
    let t = table("db-set-outdated");
    let file = row_file(&t);
    let proposal = propose(&t.root, &scope(), None, done(&t, true)).unwrap();
    let mut text = fs::read_to_string(&file).unwrap();
    text.push_str("\nedited\n");
    fs::write(&file, text).unwrap();
    assert_eq!(apply(&t.root, &scope(), &proposal).unwrap_err(), "outdated");
    let narrow = WriteScope {
        folders: vec!["other".into()],
        notes: vec![],
        vault: false,
    };
    assert_eq!(
        propose(&t.root, &narrow, None, done(&t, true)).unwrap_err(),
        "outsideWriteScope"
    );
    fs::remove_dir_all(t.root).unwrap();
}

#[test]
fn a_new_row_is_a_proposal_and_undoing_it_deletes_that_row() {
    let t = table("db-row-new");
    let op = ProposalOp::CreateDatabaseRow {
        database_id: t.database.clone(),
        title: "Second".into(),
    };
    let proposal = propose(&t.root, &scope(), None, op).unwrap();
    let count = |t: &Table| {
        crate::vault_tools::database::query(&t.root, &t.database, None, None, 10).unwrap()
            ["totalCount"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(count(&t), 1);
    let applied = apply(&t.root, &scope(), &proposal).unwrap();
    assert_eq!(count(&t), 2);
    assert!(applied.created && applied.snapshot_id.is_none());
    match undo_plan(&t.root, &applied).unwrap() {
        UndoPlan::DeleteRow { database_id, .. } => assert_eq!(database_id, t.database),
        other => panic!("{other:?}"),
    }
    // Outside the chosen folders a row cannot be proposed.
    let narrow = WriteScope {
        folders: vec!["other".into()],
        notes: vec![],
        vault: false,
    };
    let again = ProposalOp::CreateDatabaseRow {
        database_id: t.database.clone(),
        title: "Third".into(),
    };
    assert_eq!(
        propose(&t.root, &narrow, None, again).unwrap_err(),
        "outsideWriteScope"
    );
    fs::remove_dir_all(t.root).unwrap();
}

// Stage 4: move, rename, archive and delete (docs/road/ai-panel-tools.md).

fn wide() -> WriteScope {
    WriteScope {
        vault: true,
        ..WriteScope::default()
    }
}

/// A vault with a folder `chosen/` (a note, a bundle-less sub folder with an attachment), a note
/// outside it that links to `chosen/a.md`, and a target folder.
fn structural_vault(name: &str) -> PathBuf {
    let root = vault(name);
    fs::create_dir_all(root.join("chosen/sub")).unwrap();
    fs::create_dir_all(root.join("target")).unwrap();
    fs::write(root.join("chosen/sub/inner.md"), "# Inner\n").unwrap();
    fs::write(root.join("chosen/sub/pic.png"), [1u8, 2, 3]).unwrap();
    fs::write(root.join("other/ref.md"), "See [[a]] for more.\n").unwrap();
    root
}

fn mv(path: &str, folder: &str) -> ProposalOp {
    ProposalOp::Move {
        path: path.into(),
        folder: folder.into(),
    }
}

fn rename(path: &str, name: &str) -> ProposalOp {
    ProposalOp::Rename {
        path: path.into(),
        name: name.into(),
    }
}

fn tree(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .to_string();
            if name == ".amby"
                || name.starts_with(".amby/")
                    && !name.starts_with(".amby/trash")
                    && !name.starts_with(".amby/archive")
            {
                continue;
            }
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                out.push((name, fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

#[test]
fn structural_proposals_change_nothing_and_list_every_affected_file() {
    let root = structural_vault("struct-preview");
    let before = tree(&root);
    // A rename lists the note, its new path and the note whose link is rewritten.
    let proposal = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    assert_eq!(proposal.path, "chosen/a.md");
    for path in ["chosen/a.md", "chosen/renamed.md", "other/ref.md"] {
        assert!(
            proposal.affected.contains(&path.to_owned()),
            "{path}: {:?}",
            proposal.affected
        );
    }
    assert!(proposal.diff.contains("chosen/renamed.md"));
    // A folder move lists its children, attachments included.
    let proposal = propose(&root, &wide(), None, mv("chosen", "target")).unwrap();
    for path in [
        "chosen",
        "chosen/a.md",
        "chosen/sub/inner.md",
        "chosen/sub/pic.png",
        "target/chosen",
    ] {
        assert!(
            proposal.affected.contains(&path.to_owned()),
            "{path}: {:?}",
            proposal.affected
        );
    }
    assert!(!proposal.affected_truncated);
    // A deletion and an archive list the same children.
    for op in [
        ProposalOp::Delete {
            path: "chosen".into(),
        },
        ProposalOp::Archive {
            path: "chosen".into(),
        },
    ] {
        let proposal = propose(&root, &wide(), None, op).unwrap();
        assert!(
            proposal.affected.contains(&"chosen/sub/pic.png".to_owned()),
            "{:?}",
            proposal.affected
        );
        assert!(proposal
            .affected
            .contains(&"chosen/sub/inner.md".to_owned()));
    }
    assert_eq!(tree(&root), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn structural_proposals_stay_inside_the_write_scope_links_included() {
    let root = structural_vault("struct-scope");
    let narrow = scope();
    // The note is chosen, but the link rewrite would touch `other/ref.md`, which is not.
    assert_eq!(
        propose(&root, &narrow, None, rename("chosen/a.md", "renamed")).unwrap_err(),
        "outsideWriteScope"
    );
    // The source outside the context, and a destination outside it.
    for op in [
        rename("c.md", "x"),
        mv("chosen/a.md", "target"),
        ProposalOp::Delete {
            path: "other/ref.md".into(),
        },
        ProposalOp::Archive {
            path: ".amby/x".into(),
        },
        ProposalOp::Delete {
            path: "chosen/../other/b.md".into(),
        },
    ] {
        fs::write(root.join("c.md"), "# C\n").unwrap();
        assert_eq!(
            propose(&root, &narrow, None, op).unwrap_err(),
            "outsideWriteScope"
        );
    }
    // Inside the chosen folder, moving between its folders is allowed.
    assert!(propose(&root, &narrow, None, mv("chosen/sub/inner.md", "chosen")).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_structural_change_that_changes_nothing_is_refused() {
    let root = structural_vault("struct-nochange");
    assert_eq!(
        propose(&root, &wide(), None, mv("chosen/a.md", "chosen")).unwrap_err(),
        "noChange"
    );
    assert_eq!(
        propose(&root, &wide(), None, rename("chosen/a.md", "a")).unwrap_err(),
        "noChange"
    );
    assert_eq!(
        propose(
            &root,
            &wide(),
            None,
            ProposalOp::Delete {
                path: "missing.md".into()
            }
        )
        .unwrap_err(),
        "notFound"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_rename_applies_with_its_links_and_undoes_back_to_the_same_files() {
    let root = structural_vault("struct-rename");
    let before = tree(&root);
    let proposal = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    let applied = apply(&root, &wide(), &proposal).unwrap();
    assert!(root.join("chosen/renamed.md").exists() && !root.join("chosen/a.md").exists());
    assert!(fs::read_to_string(root.join("other/ref.md"))
        .unwrap()
        .contains("renamed"));
    assert!(matches!(
        undo_plan(&root, &applied).unwrap(),
        UndoPlan::Structural(_)
    ));
    undo(&root, &wide(), &applied).unwrap();
    assert_eq!(tree(&root), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_folder_move_applies_and_undoes() {
    let root = structural_vault("struct-move");
    let before = tree(&root);
    let proposal = propose(&root, &wide(), None, mv("chosen", "target")).unwrap();
    let applied = apply(&root, &wide(), &proposal).unwrap();
    assert!(root.join("target/chosen/sub/pic.png").exists());
    assert!(!root.join("chosen").exists());
    undo(&root, &wide(), &applied).unwrap();
    assert_eq!(tree(&root), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_archive_applies_and_undoes_from_the_archive() {
    let root = structural_vault("struct-archive");
    let before = tree(&root);
    let proposal = propose(
        &root,
        &wide(),
        None,
        ProposalOp::Archive {
            path: "chosen/a.md".into(),
        },
    )
    .unwrap();
    let applied = apply(&root, &wide(), &proposal).unwrap();
    assert!(!root.join("chosen/a.md").exists());
    undo(&root, &wide(), &applied).unwrap();
    assert_eq!(tree(&root), before);
    fs::remove_dir_all(root).unwrap();
}

/// A run that moves a deleted item into a folder of the test instead of the real system trash.
fn fake_trash(
    root: &std::path::Path,
    bin: &std::path::Path,
) -> impl Fn(&Mutation) -> Result<Value, &'static str> {
    let (root, bin) = (root.to_owned(), bin.to_owned());
    move |mutation| match mutation {
        Mutation::Delete { path } => {
            fs::create_dir_all(&bin).unwrap();
            fs::rename(root.join(path), bin.join("item")).map_err(|_| "trashUnavailable")?;
            Ok(serde_json::json!({"path": path}))
        }
        other => crate::vault_tools::execute_offline(&root, "", other),
    }
}

#[test]
fn a_deletion_follows_the_system_trash_setting_and_cannot_be_undone_from_here() {
    let root = structural_vault("struct-delete");
    let bin = root
        .parent()
        .unwrap()
        .join(format!("bin-{}", ulid::Ulid::generate()));
    let proposal = propose(
        &root,
        &wide(),
        None,
        ProposalOp::Delete {
            path: "chosen".into(),
        },
    )
    .unwrap();
    let applied = apply_with(&root, &wide(), &proposal, &fake_trash(&root, &bin)).unwrap();
    assert!(!root.join("chosen").exists());
    // The bytes went to the (fake) system trash; nothing is destroyed.
    assert!(bin.join("item/sub/pic.png").exists());
    assert!(applied.removed && applied.inverse.is_none());
    assert_eq!(undo_plan(&root, &applied).unwrap_err(), "undoUnavailable");
    assert_eq!(
        undo(&root, &wide(), &applied).unwrap_err(),
        "undoUnavailable"
    );
    fs::remove_dir_all(root).unwrap();
    let _ = fs::remove_dir_all(bin);
}

#[test]
fn a_deletion_with_the_archive_setting_goes_to_the_archive_and_undoes() {
    let root = structural_vault("struct-delete-archive");
    let before = tree(&root);
    let proposal = propose(
        &root,
        &wide(),
        None,
        ProposalOp::Delete {
            path: "chosen".into(),
        },
    )
    .unwrap();
    let run = |mutation: &Mutation| crate::vault_tools::execute_offline(&root, "", mutation);
    let applied = apply_deleting(
        &root,
        &wide(),
        &proposal,
        crate::recycle_bin::DeleteMode::Archive,
        &run,
    )
    .unwrap();
    assert!(!root.join("chosen").exists() && !applied.removed);
    undo(&root, &wide(), &applied).unwrap();
    assert_eq!(tree(&root), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_proposal_is_outdated_if_any_affected_file_changed_and_nothing_is_written() {
    let root = structural_vault("struct-outdated");
    let proposal = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    // A note that would have its link rewritten changed since.
    fs::write(root.join("other/ref.md"), "See [[a]] and again.\n").unwrap();
    let before = tree(&root);
    assert_eq!(apply(&root, &wide(), &proposal).unwrap_err(), "outdated");
    assert_eq!(tree(&root), before);
    // A new note now links to the renamed one: the set of rewritten files differs.
    let proposal = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    fs::write(root.join("other/new-ref.md"), "[[a]]\n").unwrap();
    assert_eq!(apply(&root, &wide(), &proposal).unwrap_err(), "outdated");
    // The destination appeared, and the source vanished.
    let proposal = propose(&root, &wide(), None, mv("chosen/sub", "target")).unwrap();
    fs::create_dir_all(root.join("target/sub")).unwrap();
    assert_eq!(apply(&root, &wide(), &proposal).unwrap_err(), "outdated");
    let proposal = propose(
        &root,
        &wide(),
        None,
        ProposalOp::Delete {
            path: "chosen/sub".into(),
        },
    )
    .unwrap();
    fs::write(root.join("chosen/sub/inner.md"), "# Inner\nedited\n").unwrap();
    assert_eq!(apply(&root, &wide(), &proposal).unwrap_err(), "outdated");
    fs::remove_dir_all(root.join("chosen/sub")).unwrap();
    assert_eq!(apply(&root, &wide(), &proposal).unwrap_err(), "outdated");
    assert!(crate::recycle_bin::list(&root).is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_structural_undo_is_refused_when_the_result_changed_since() {
    let root = structural_vault("struct-undo-changed");
    let proposal = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    let applied = apply(&root, &wide(), &proposal).unwrap();
    fs::write(root.join("chosen/renamed.md"), "# A\nedited later\n").unwrap();
    assert_eq!(undo_plan(&root, &applied).unwrap_err(), "changedSince");
    assert_eq!(undo(&root, &wide(), &applied).unwrap_err(), "changedSince");
    assert!(root.join("chosen/renamed.md").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsaved_notes_are_found_among_the_affected_files_and_their_folders() {
    let root = structural_vault("struct-unsaved");
    let proposal = propose(&root, &wide(), None, mv("chosen", "target")).unwrap();
    assert!(proposal.touches(&["chosen/sub/inner.md".to_owned()]));
    assert!(!proposal.touches(&["other/b.md".to_owned()]));
    let rename = propose(&root, &wide(), None, rename("chosen/a.md", "renamed")).unwrap();
    // The note whose link would be rewritten counts too.
    assert!(rename.touches(&["other/ref.md".to_owned()]));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_cell_card_shows_the_value_as_text_not_json() {
    use serde_json::json;
    assert_eq!(
        super::cell_text(&json!({"type":"text","value":"Market"})),
        "Market"
    );
    assert_eq!(super::cell_text(&json!({"type":"number","value":3})), "3");
    assert_eq!(
        super::cell_text(
            &json!({"type":"multiSelect","value":[{"id":"a","name":"Red"},{"id":"b","name":"Blue"}]})
        ),
        "Red, Blue"
    );
    assert_eq!(super::cell_text(&json!(null)), "");
}
