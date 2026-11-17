//! Which files a rename or move may rewrite links in (CORE-15): notes and the archive only.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_vault(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("amby-scope-{name}-{nanos}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(vault: &Path, rel: &str, text: &str) -> PathBuf {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}

const LINK: &str = "see [b](Folder/B.md) and [[Folder/B]]";

fn rename_b(vault: &Path) -> Vec<PathBuf> {
    let target = write(vault, "Folder/B.md", "target");
    let conn = open_connection(vault).unwrap();
    sync_vault(&conn, vault).unwrap();
    let renamed = vault.join("Folder/C.md");
    let changes = vec![crate::model::PathChange {
        old_path: target.to_string_lossy().into_owned(),
        new_path: renamed.to_string_lossy().into_owned(),
    }];
    let plan = plan_inbound_wiki_rewrites(&conn, vault, &changes).unwrap();
    let planned = plan.iter().map(|p| p.source_path.clone()).collect();
    fs::rename(&target, &renamed).unwrap();
    apply_planned_wiki_rewrites(vault, &plan).unwrap();
    planned
}

#[test]
fn rewrites_notes_and_archive_but_not_trash_backups_or_service_folders() {
    let vault = temp_vault("scope");
    let note = write(&vault, "A.md", LINK);
    let archived = write(&vault, ".amby/archive/item1/Old.md", LINK);
    let untouched = [
        ".trash/T.md",
        ".trash/files/Board.canvas",
        ".amby/backups/mig1/A.md",
        ".amby/history/abc/1.md",
        ".amby/recovery/A.md",
        ".amby/archive/.meta/item1.md",
        ".obsidian/N.md",
        ".git/N.md",
        ".hidden/N.md",
        "assets/N.md",
    ]
    .map(|rel| (write(&vault, rel, LINK), rel));

    let planned = rename_b(&vault);

    assert!(fs::read_to_string(&note)
        .unwrap()
        .contains("](Folder/C.md)"));
    assert!(fs::read_to_string(&archived)
        .unwrap()
        .contains("](Folder/C.md)"));
    for (path, rel) in &untouched {
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            LINK,
            "{rel} was rewritten"
        );
        assert!(!planned.contains(path), "{rel} was planned");
    }
    assert!(planned.contains(&archived));
    fs::remove_dir_all(vault).unwrap();
}

#[cfg(unix)]
#[test]
fn does_not_follow_symlinks_out_of_the_vault() {
    let vault = temp_vault("symlink");
    let outside = temp_vault("symlink-outside");
    let foreign = write(&outside, "X.md", LINK);
    std::os::unix::fs::symlink(&outside, vault.join("Link")).unwrap();

    rename_b(&vault);

    assert_eq!(fs::read_to_string(&foreign).unwrap(), LINK);
    fs::remove_dir_all(vault).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn quoted_paths_are_rewritten_only_in_canvas_and_sketches() {
    let vault = temp_vault("syntax");
    let prose = "Say \"Folder/B.md\" in quotes";
    let note = write(&vault, "A.md", prose);
    let canvas = write(&vault, "Board.canvas", r#"{"file":"Folder/B.md"}"#);
    let sketch = write(&vault, "S.excalidraw", r#"{"link":"Folder/B.md"}"#);

    rename_b(&vault);

    assert!(fs::read_to_string(&note).unwrap().ends_with(prose));
    assert!(fs::read_to_string(&canvas).unwrap().contains("Folder/C.md"));
    assert!(fs::read_to_string(&sketch).unwrap().contains("Folder/C.md"));
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn archived_wikilinks_follow_the_rename_with_the_index_rules() {
    let vault = temp_vault("archive-wiki");
    write(&vault, "Other/B.md", "another note named B");
    let body = "[[B]] [[B|alias]] ![[B]] [[B#h]] [[B^blk]] [[Folder/B]] [[Folder/B.md]]\r\n\
                `[[B]]`\r\n```\r\n[[B]]\r\n```\r\n[[Other/B]] [[Unrelated]]";
    let archived = write(&vault, ".amby/archive/item1/Old.md", body);
    let trashed = write(&vault, ".trash/T.md", body);

    // "B" is shared with Other/B.md, so a bare [[B]] is undecidable and must stay.
    let planned = rename_b(&vault);

    assert!(planned.contains(&archived));
    assert_eq!(
        fs::read_to_string(&archived).unwrap(),
        "[[B]] [[B|alias]] ![[B]] [[B#h]] [[B^blk]] [[Folder/C]] [[Folder/C]]\r\n\
         `[[B]]`\r\n```\r\n[[B]]\r\n```\r\n[[Other/B]] [[Unrelated]]"
    );
    assert_eq!(fs::read_to_string(&trashed).unwrap(), body);
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn archived_wikilinks_by_name_are_rewritten_when_the_name_is_unique() {
    let vault = temp_vault("archive-wiki-unique");
    let body = "[[B]] [[B|alias]] ![[B]] [[B#h]] [[B^blk]] [[Folder/B]]\n```\n[[B]]\n```\n";
    let archived = write(&vault, ".amby/archive/item1/Old.md", body);

    rename_b(&vault);

    assert_eq!(
        fs::read_to_string(&archived).unwrap(),
        "[[Folder/C]] [[Folder/C|alias]] ![[Folder/C]] [[Folder/C#h]] [[Folder/C^blk]] [[Folder/C]]\n```\n[[B]]\n```\n"
    );
    fs::remove_dir_all(vault).unwrap();
}

#[test]
fn a_property_link_in_frontmatter_follows_the_rename_as_before() {
    // Relation properties are stored as wikilinks in frontmatter; the rewrite keeps updating them
    // in a note it rewrites (only code and comments are protected).
    let vault = temp_vault("frontmatter-link");
    let note = write(
        &vault,
        "A.md",
        "---\nrelated: \"[[Folder/B]]\"\n---\nsee [[Folder/B]]\n```\n[[Folder/B]]\n```\n",
    );
    rename_b(&vault);
    let text = fs::read_to_string(&note).unwrap();
    assert!(text.contains("related: \"[[Folder/C]]\"\n"), "{text}");
    assert!(
        text.ends_with("---\nsee [[Folder/C]]\n```\n[[Folder/B]]\n```\n"),
        "{text}"
    );
    fs::remove_dir_all(vault).unwrap();
}
