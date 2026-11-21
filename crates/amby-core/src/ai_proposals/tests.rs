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
        "# R\ntext\n\nmore"
    );
    fs::remove_dir_all(root).unwrap();
}

// ----- property proposals -----

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
