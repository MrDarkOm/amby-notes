//! К3а (docs/sync-plan.md): when one pass deletes every file of the folder of a super note
//! (`Name/Name.md` with its canvas, sketch, database views and attachments), the folder goes to the
//! trash as one item; a partial deletion, a folder that holds anything else, and a folder that is
//! no super note stay per file. Nothing is ever erased. Written before the code (раздел 6): the
//! real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

const BUNDLE: [&str; 5] = [
    "Note/Note.md",
    "Note/Note.canvas",
    "Note/Note.excalidraw",
    "Note/ambd.json",
    "Note/.ambd/views/01M2D4.json",
];

fn with_bundle() -> World {
    let w = pair_with_a(Engine::boxed);
    for path in BUNDLE {
        w.save(0, path, &format!("text of {path}"));
    }
    w.pass(0);
    w.pass(1);
    for path in BUNDLE {
        assert!(w.dev(1).fs.exists(path), "{path} arrived");
    }
    w
}

fn k3a_a_whole_super_note_goes_to_the_trash_as_one_folder(_b: EngineBuilder) {
    let w = with_bundle();
    for path in BUNDLE {
        w.dev(0).fs.user_delete(path);
    }
    w.pass(0);
    w.pass(1);
    let folders = w.dev(1).fs.dir_trashes();
    assert_eq!(folders.len(), 1, "one trash item: {folders:?}");
    assert_eq!(folders[0].0, "Note");
    let mut files = folders[0].1.clone();
    files.sort();
    let mut expected: Vec<String> = BUNDLE.iter().map(|p| (*p).to_string()).collect();
    expected.sort();
    assert_eq!(files, expected, "every file of the folder is inside it");
    for path in BUNDLE {
        assert!(!w.dev(1).fs.exists(path), "{path} left its place");
    }
    // Nothing is erased: every content is in the trash.
    let trash = w.dev(1).fs.trash();
    for path in BUNDLE {
        assert!(
            trash
                .iter()
                .any(|entry| entry.bytes == format!("text of {path}").as_bytes()),
            "{path} is kept in the trash"
        );
    }
    w.finish(false);
}

fn k3a_a_partial_deletion_stays_per_file(_b: EngineBuilder) {
    let w = with_bundle();
    w.dev(0).fs.user_delete("Note/Note.canvas");
    w.dev(0).fs.user_delete("Note/Note.excalidraw");
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.dir_trashes().is_empty(), "no folder was moved");
    assert_eq!(w.dev(1).fs.trash().len(), 2, "two files, one by one");
    assert!(w.dev(1).fs.exists("Note/Note.md"));
    assert!(w.dev(1).fs.exists("Note/ambd.json"));
    w.finish(false);
}

fn k3a_a_folder_with_a_file_of_the_person_stays_per_file(_b: EngineBuilder) {
    let w = with_bundle();
    for path in BUNDLE {
        w.dev(0).fs.user_delete(path);
    }
    w.pass(0);
    // A file the other computer never sent: it is not part of the deletion and must stay.
    w.save(1, "Note/mine.md", "my own text");
    w.pass(1);
    assert!(w.dev(1).fs.dir_trashes().is_empty(), "no folder was moved");
    assert_eq!(w.read(1, "Note/mine.md").as_deref(), Some("my own text"));
    w.finish(false);
}

fn k3a_a_folder_that_is_no_super_note_stays_per_file(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Plain/one.md", "one");
    w.save(0, "Plain/two.md", "two");
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_delete("Plain/one.md");
    w.dev(0).fs.user_delete("Plain/two.md");
    w.pass(0);
    w.pass(1);
    assert!(w.dev(1).fs.dir_trashes().is_empty());
    assert_eq!(w.dev(1).fs.trash().len(), 2);
    w.finish(false);
}

real_only!(
    k3a_a_whole_super_note_goes_to_the_trash_as_one_folder,
    k3a_a_partial_deletion_stays_per_file,
    k3a_a_folder_with_a_file_of_the_person_stays_per_file,
    k3a_a_folder_that_is_no_super_note_stays_per_file,
);
