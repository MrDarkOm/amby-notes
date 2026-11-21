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
    assert!(propose(&root, &narrow, replace("other/b.md", "secret", "open")).is_ok());
    let new = ProposalOp::New {
        path: "chosen/new.md".into(),
        content: "hello".into(),
    };
    assert!(propose(&root, &narrow, new).is_ok());
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
            propose(&root, &narrow, op).unwrap_err(),
            "outsideWriteScope"
        );
    }
    let wide = WriteScope {
        vault: true,
        ..narrow
    };
    assert!(propose(&root, &wide, replace("c.md", "x", "y")).is_ok());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn apply_writes_an_ai_edit_version_and_undo_restores_the_bytes() {
    let root = vault("prop-apply");
    let original = fs::read(root.join("chosen/a.md")).unwrap();
    let proposal = propose(
        &root,
        &scope(),
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
    let proposal = propose(&root, &scope(), append("chosen/q.md", "Pavel")).unwrap();
    apply(&root, &scope(), &proposal).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/q.md")).unwrap(),
        "# Q\n> [!ASK]\n> text\n\nPavel"
    );
    // A note that already ends with a blank line gets no extra one.
    fs::write(root.join("chosen/r.md"), "# R\ntext\n\n").unwrap();
    let proposal = propose(&root, &scope(), append("chosen/r.md", "more")).unwrap();
    apply(&root, &scope(), &proposal).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("chosen/r.md")).unwrap(),
        "# R\ntext\n\nmore"
    );
    fs::remove_dir_all(root).unwrap();
}
