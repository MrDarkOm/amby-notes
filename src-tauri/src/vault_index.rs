pub use crate::index::*;
pub use crate::vault::*;

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};
    use ulid::Ulid;

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby-index-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Open a persistent connection for the test vault, matching the app's
    /// one-connection-per-vault lifecycle.
    fn open_conn(vault: &Path) -> Connection {
        open_connection(vault).unwrap()
    }

    #[test]
    fn sync_adds_ulid_to_new_file() {
        let vault = temp_vault("new");
        let note = vault.join("A.md");
        fs::write(&note, "Hello #tag").unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 1);
        assert!(fs::read_to_string(note)
            .unwrap()
            .starts_with("---\namby-id: "));
        assert_eq!(loaded.tree[0].id, loaded.notes[0].id);
    }

    #[test]
    fn refactor_rewrites_resolved_wikilinks_without_losing_anchor_or_alias() {
        let vault = temp_vault("refactor");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "Link [[B#Heading|Readable]]").unwrap();
        fs::write(&target, "# B").unwrap();
        let conn = open_conn(&vault);
        sync_vault(&conn, &vault).unwrap();

        let renamed = vault.join("C.md");
        let changes = vec![crate::model::PathChange {
            old_path: path_string(&target),
            new_path: path_string(&renamed),
        }];
        let plan = plan_inbound_wiki_rewrites(&conn, &vault, &changes).unwrap();
        fs::rename(&target, &renamed).unwrap();
        apply_planned_wiki_rewrites(&vault, &plan).unwrap();

        assert!(fs::read_to_string(&source)
            .unwrap()
            .contains("[[C#Heading|Readable]]"));
        drop(conn);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn refactor_updates_exact_markdown_embed_and_canvas_references() {
        let vault = temp_vault("refactor-assets");
        let source = vault.join("A.md");
        let target = vault.join("Folder/B.md");
        let canvas = vault.join("Board.canvas");
        fs::create_dir(vault.join("Folder")).unwrap();
        fs::write(
            &source,
            "[note](Folder/B.md#Heading)\n![embed](/Folder/B.md^block)",
        )
        .unwrap();
        fs::write(&target, "target").unwrap();
        fs::write(&canvas, r#"{"file":"Folder/B.md"}"#).unwrap();
        let conn = open_conn(&vault);
        sync_vault(&conn, &vault).unwrap();

        let renamed = vault.join("Folder/C.md");
        let changes = vec![crate::model::PathChange {
            old_path: path_string(&target),
            new_path: path_string(&renamed),
        }];
        let plan = plan_inbound_wiki_rewrites(&conn, &vault, &changes).unwrap();
        fs::rename(&target, &renamed).unwrap();
        apply_planned_wiki_rewrites(&vault, &plan).unwrap();

        let markdown = fs::read_to_string(source).unwrap();
        assert!(markdown.contains("](Folder/C.md#Heading)"));
        assert!(markdown.contains("](/Folder/C.md^block)"));
        assert!(fs::read_to_string(canvas).unwrap().contains("Folder/C.md"));
        drop(conn);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sync_leaves_user_managed_and_duplicate_ids_unchanged() {
        let vault = temp_vault("id-conflicts");
        let user_managed = vault.join("UserManaged.md");
        let first = vault.join("First.md");
        let duplicate = vault.join("Duplicate.md");
        let id = Ulid::generate().to_string();
        fs::write(&user_managed, "---\nid: external-system\n---\nUser-managed").unwrap();
        fs::write(&first, format!("---\namby-id: {id}\n---\nFirst")).unwrap();
        fs::write(&duplicate, format!("---\namby-id: {id}\n---\nDuplicate")).unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 3);
        assert!(fs::read_to_string(&user_managed)
            .unwrap()
            .ends_with("id: external-system\n---\nUser-managed"));
        assert_eq!(
            fs::read_to_string(&duplicate).unwrap(),
            format!("---\namby-id: {id}\n---\nDuplicate")
        );
        assert!(!loaded
            .sync
            .warnings
            .iter()
            .any(|warning| warning.contains("not an Amby ULID")));
        assert!(loaded
            .sync
            .warnings
            .iter()
            .any(|warning| warning.contains("duplicate Amby id")));
    }

    #[test]
    fn sync_excludes_obsidian_git_trash_and_amby_directories() {
        let vault = temp_vault("excluded-directories");
        fs::write(vault.join("Visible.md"), "Visible").unwrap();
        for directory in [".obsidian", ".git", ".trash", ".amby", "assets"] {
            let dir = vault.join(directory);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("Hidden.md"), "Hidden").unwrap();
        }

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 1);
        for directory in [".obsidian", ".git", ".trash", ".amby", "assets"] {
            assert_eq!(
                fs::read_to_string(vault.join(directory).join("Hidden.md")).unwrap(),
                "Hidden"
            );
        }
    }

    #[test]
    fn preflight_is_read_only_and_id_migration_creates_a_restore_point() {
        let vault = temp_vault("id-migration");
        let note = vault.join("Untitled.md");
        let original = "# Untitled\n";
        fs::write(&note, original).unwrap();

        let preflight = preflight_vault(&vault).unwrap();
        assert_eq!(preflight.planned_id_writes, vec!["Untitled.md"]);
        assert_eq!(fs::read_to_string(&note).unwrap(), original);
        assert!(!vault.join(".amby").exists());

        let migration = apply_id_migration(&vault).unwrap();
        assert_eq!(migration.modified_paths, vec!["Untitled.md"]);
        assert!(fs::read_to_string(&note)
            .unwrap()
            .starts_with("---\namby-id: "));
        assert_eq!(
            fs::read_to_string(format!("{}/Untitled.md", migration.backup_path)).unwrap(),
            original
        );
        assert!(Path::new(&migration.journal_path).is_file());
        assert_eq!(migration.status, IdMigrationStatus::Completed);
    }

    #[test]
    fn id_migration_recognizes_crlf_frontmatter_after_the_first_write() {
        let vault = temp_vault("id-migration-crlf");
        let note = vault.join("Finnish.md");
        let original = b"---\r\ntitle: Finnish\r\ntags: [language]\r\n---\r\nBody\r\n";
        fs::write(&note, original).unwrap();

        assert_eq!(
            preflight_vault(&vault).unwrap().planned_id_writes,
            vec!["Finnish.md"]
        );
        apply_id_migration(&vault).unwrap();

        let migrated = fs::read(&note).unwrap();
        assert!(migrated.windows(2).any(|pair| pair == b"\r\n"));
        assert!(!migrated.windows(2).any(|pair| pair == [b'\n', b'\n']));
        let migrated_text = String::from_utf8(migrated).unwrap();
        assert_eq!(migrated_text.matches("id: ").count(), 1);
        assert_eq!(
            crate::frontmatter::parse_markdown(&migrated_text).body,
            "Body\r\n"
        );
        assert!(preflight_vault(&vault)
            .unwrap()
            .planned_id_writes
            .is_empty());

        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        assert_eq!(
            fs::read_to_string(&note).unwrap().matches("id: ").count(),
            1
        );
        drop(conn);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn id_insertion_persists_exact_bytes_in_sync_incremental_and_migration_paths() {
        for operation in ["sync", "incremental", "migration"] {
            let vault = temp_vault(operation);
            let note = vault.join("Note.md");
            // Mixed endings deliberately exercise the identity-only write path:
            // it must not run the body editor's dominant-EOL normalization.
            let original = "\u{feff}---\r\n# keep\r\ntitle: 'Quoted'\r\n---\r\nBody\n\n";
            fs::write(&note, original).unwrap();
            let conn = open_conn(&vault);
            let migration = match operation {
                "sync" => {
                    sync_vault(&conn, &vault).unwrap();
                    None
                }
                "incremental" => {
                    prepare_note_at_path(&conn, &vault, &note).unwrap();
                    None
                }
                "migration" => {
                    let migration = apply_id_migration(&vault).unwrap();
                    assert_eq!(
                        fs::read(Path::new(&migration.backup_path).join("Note.md")).unwrap(),
                        original.as_bytes()
                    );
                    Some(migration)
                }
                _ => unreachable!(),
            };
            let persisted = fs::read_to_string(&note).unwrap();
            let id = crate::frontmatter::parse_markdown(&persisted).id.unwrap();
            let expected = original.replacen("---\r\n", &format!("---\r\namby-id: {id}\r\n"), 1);
            assert_eq!(persisted.as_bytes(), expected.as_bytes(), "{operation}");

            // A subsequent scan must not add a second ID or normalize the file.
            sync_vault(&conn, &vault).unwrap();
            assert_eq!(fs::read(&note).unwrap(), expected.as_bytes());
            if let Some(migration) = migration {
                let recovery = recover_id_migration(
                    &vault,
                    &migration.journal_path,
                    IdMigrationRecoveryAction::Rollback,
                )
                .unwrap();
                assert_eq!(recovery.status, IdMigrationStatus::RolledBack);
            } else {
                let snapshots = crate::history::list_snapshots(&vault, &note).unwrap();
                assert_eq!(snapshots.len(), 1);
                assert_eq!(snapshots[0].reason, "id-assignment");
                let restore =
                    crate::history::prepare_snapshot_restore(&vault, &snapshots[0].id).unwrap();
                assert_eq!(restore.bytes, original.as_bytes());
                crate::history::restore_snapshot(&vault, &snapshots[0].id).unwrap();
            }
            assert_eq!(fs::read(&note).unwrap(), original.as_bytes());
            drop(conn);
            fs::remove_dir_all(vault).unwrap();
        }
    }

    #[test]
    fn id_insertion_failure_leaves_original_files_intact() {
        for operation in ["sync", "incremental", "migration"] {
            for original in [
                "\u{feff}---\r\n{title: 'Flow'}\r\n---\r\nBody\n",
                "---\namby-id: 42\n---\nBody",
                "---\ntitle: open\nBody",
            ] {
                let vault = temp_vault(operation);
                let note = vault.join("Note.md");
                fs::write(&note, original).unwrap();
                let conn = open_conn(&vault);
                match operation {
                    "sync" => {
                        let report = sync_vault(&conn, &vault).unwrap();
                        assert!(report
                            .warnings
                            .iter()
                            .any(|warning| warning.contains("Note.md")));
                    }
                    "incremental" => {
                        let prepared = prepare_note_at_path(&conn, &vault, &note).unwrap();
                        let prefix = if crate::frontmatter::parse_markdown(original)
                            .frontmatter_status
                            .is_malformed()
                        {
                            "amby-opaque:"
                        } else {
                            "amby-conflict:"
                        };
                        assert!(prepared.note_id.starts_with(prefix));
                    }
                    "migration" => {
                        assert!(apply_id_migration(&vault)
                            .unwrap()
                            .modified_paths
                            .is_empty());
                    }
                    _ => unreachable!(),
                }
                assert_eq!(fs::read(&note).unwrap(), original.as_bytes());
                drop(conn);
                fs::remove_dir_all(vault).unwrap();
            }
        }
    }

    #[test]
    fn completed_legacy_migration_journal_does_not_block_preflight() {
        let vault = temp_vault("legacy-id-migration-journal");
        fs::write(
            vault.join("Note.md"),
            "---\nid: 01J1K2M3N4P5Q6R7S8T9V0WXYZ\n---\nNote\n",
        )
        .unwrap();
        let directory = migration_directory(&vault);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("id-migration-legacy.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "kind": "add-amby-ids",
                "createdAtMs": 1,
                "backupPath": ".amby/backups/id-migration-1",
                "modifiedPaths": ["Note.md"]
            }))
            .unwrap(),
        )
        .unwrap();

        let preflight = preflight_vault(&vault).unwrap();
        assert!(preflight.unfinished_migrations.is_empty());
        assert_eq!(preflight.planned_id_writes, vec!["Note.md"]);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn failed_id_migration_can_resume_after_note_write_before_journal_progress() {
        let vault = temp_vault("id-migration-resume");
        let first = vault.join("First.md");
        let second = vault.join("Second.md");
        fs::write(&first, "First original").unwrap();
        fs::write(&second, "Second original").unwrap();

        fail_next_migration_stage(2);
        assert!(apply_id_migration(&vault).is_err());

        let unfinished = unfinished_id_migrations(&vault).unwrap();
        assert_eq!(unfinished.len(), 1);
        let recovery = &unfinished[0];
        assert_eq!(recovery.status, IdMigrationStatus::InProgress);
        assert_eq!(
            preflight_vault(&vault).unwrap().unfinished_migrations.len(),
            1
        );
        assert!(recovery
            .files
            .iter()
            .any(|file| file.status == IdMigrationFileStatus::BackupCreated));
        assert!(crate::frontmatter::read_markdown(&first)
            .unwrap()
            .id
            .is_some());

        let resumed = recover_id_migration(
            &vault,
            &recovery.journal_path,
            IdMigrationRecoveryAction::Resume,
        )
        .unwrap();
        assert_eq!(resumed.status, IdMigrationStatus::Completed);
        assert!(resumed
            .files
            .iter()
            .all(|file| file.status == IdMigrationFileStatus::Applied));
        assert!(crate::frontmatter::read_markdown(&first)
            .unwrap()
            .id
            .is_some());
        assert!(crate::frontmatter::read_markdown(&second)
            .unwrap()
            .id
            .is_some());
        assert!(unfinished_id_migrations(&vault).unwrap().is_empty());
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn failed_id_migration_can_roll_back_created_backup_without_overwriting_user_edits() {
        let vault = temp_vault("id-migration-rollback");
        let note = vault.join("Untitled.md");
        let original = "Untitled original\n";
        fs::write(&note, original).unwrap();

        fail_next_migration_stage(1);
        assert!(apply_id_migration(&vault).is_err());
        let recovery = unfinished_id_migrations(&vault).unwrap().pop().unwrap();
        assert_eq!(recovery.files[0].status, IdMigrationFileStatus::Pending);
        let rolled_back = recover_id_migration(
            &vault,
            &recovery.journal_path,
            IdMigrationRecoveryAction::Rollback,
        )
        .unwrap();
        assert_eq!(rolled_back.status, IdMigrationStatus::RolledBack);
        assert_eq!(fs::read_to_string(&note).unwrap(), original);
        assert!(unfinished_id_migrations(&vault).unwrap().is_empty());

        let completed = recover_id_migration(
            &vault,
            &recovery.journal_path,
            IdMigrationRecoveryAction::Rollback,
        )
        .unwrap();
        assert_eq!(completed.status, IdMigrationStatus::RolledBack);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn migration_rollback_refuses_to_overwrite_later_user_frontmatter() {
        let vault = temp_vault("id-migration-user-edit");
        let note = vault.join("Untitled.md");
        fs::write(&note, "Untitled original\n").unwrap();
        let migration = apply_id_migration(&vault).unwrap();
        let user_edit = "---\nid: external-system\n---\nUser edit\n";
        fs::write(&note, user_edit).unwrap();

        assert!(recover_id_migration(
            &vault,
            &migration.journal_path,
            IdMigrationRecoveryAction::Rollback,
        )
        .is_err());
        assert_eq!(fs::read_to_string(&note).unwrap(), user_edit);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sync_hard_deletes_missing_files() {
        let vault = temp_vault("delete");
        let note = vault.join("A.md");
        fs::write(&note, "Hello").unwrap();
        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        fs::remove_file(&note).unwrap();

        let loaded = load_vault(&conn, &vault).unwrap();

        assert!(loaded.notes.is_empty());
        assert_eq!(loaded.sync.deleted, 1);
    }

    #[test]
    fn sync_updates_moved_file_by_frontmatter_id() {
        let vault = temp_vault("move");
        let note = vault.join("A.md");
        fs::write(&note, "Hello").unwrap();
        let conn = open_conn(&vault);
        let first = load_vault(&conn, &vault).unwrap();
        let id = first.notes[0].id.clone();
        fs::rename(&note, vault.join("B.md")).unwrap();

        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes[0].id, id);
        assert!(loaded.notes[0].path.ends_with("B.md"));
    }

    #[test]
    fn incremental_create_indexes_new_note_without_full_sync() {
        let vault = temp_vault("incremental-create");
        let note = vault.join("Created.md");
        fs::write(&note, "Created #tag").unwrap();
        let conn = open_conn(&vault);

        index_apply_path_changes(
            &conn,
            &vault,
            &[crate::model::PathChange {
                old_path: String::new(),
                new_path: path_string(&note),
            }],
        )
        .unwrap();

        let id = note_id_for_path(&conn, &vault, &note).unwrap().unwrap();
        assert!(!id.is_empty());
        assert!(fs::read_to_string(&note)
            .unwrap()
            .starts_with("---\namby-id: "));
        assert_eq!(list_notes(&conn, &vault).unwrap().len(), 1);
    }

    #[test]
    fn incremental_move_preserves_note_id_and_link_targets() {
        let vault = temp_vault("incremental-move");
        let source = vault.join("A.md");
        let target = vault.join("Renamed.md");
        let incoming = vault.join("Incoming.md");
        fs::write(&source, "A note without a heading").unwrap();
        fs::write(&incoming, "Link to [[A]]").unwrap();
        let conn = open_conn(&vault);
        let initial = load_vault(&conn, &vault).unwrap();
        let id = initial
            .notes
            .iter()
            .find(|note| note.path.ends_with("A.md"))
            .unwrap()
            .id
            .clone();

        fs::rename(&source, &target).unwrap();
        index_apply_path_changes(
            &conn,
            &vault,
            &[crate::model::PathChange {
                old_path: path_string(&source),
                new_path: path_string(&target),
            }],
        )
        .unwrap();

        assert_eq!(note_id_for_path(&conn, &vault, &target).unwrap(), Some(id));
        let graph = link_graph(&conn, &vault).unwrap();
        assert!(graph.edges.iter().any(|edge| edge.unresolved == Some(true)));
    }

    #[test]
    fn incremental_delete_returns_id_and_unresolves_inbound_links() {
        let vault = temp_vault("incremental-delete");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "Link to [[B]]").unwrap();
        fs::write(&target, "# B").unwrap();
        let conn = open_conn(&vault);
        let initial = load_vault(&conn, &vault).unwrap();
        let target_id = initial
            .notes
            .iter()
            .find(|note| note.path.ends_with("B.md"))
            .unwrap()
            .id
            .clone();

        fs::remove_file(&target).unwrap();
        let deleted = index_apply_mutation(&conn, &vault, &[], &[path_string(&target)]).unwrap();

        assert_eq!(deleted, vec![target_id]);
        assert!(note_id_for_path(&conn, &vault, &target).unwrap().is_none());
        assert!(link_graph(&conn, &vault)
            .unwrap()
            .edges
            .iter()
            .any(|edge| edge.unresolved == Some(true)));
    }

    #[test]
    fn failed_incremental_upsert_rolls_back_notes_tags_and_links() {
        let vault = temp_vault("incremental-rollback");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "Old body #old [[B]]").unwrap();
        fs::write(&target, "# B").unwrap();
        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();
        let source_id = loaded
            .notes
            .iter()
            .find(|note| note.path.ends_with("A.md"))
            .unwrap()
            .id
            .clone();

        let before_content: String = conn
            .query_row(
                "SELECT content FROM notes WHERE id = ?1",
                [&source_id],
                |row| row.get(0),
            )
            .unwrap();
        let before_tags: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT tag FROM tags WHERE note_id = ?1 ORDER BY tag")
                .unwrap();
            statement
                .query_map([&source_id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap()
        };
        let before_links: Vec<(String, String, Option<String>)> = {
            let mut statement = conn
                .prepare(
                    "SELECT raw, target, target_note_id FROM links WHERE note_id = ?1 ORDER BY rowid",
                )
                .unwrap();
            statement
                .query_map([&source_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap()
                .collect::<Result<Vec<(String, String, Option<String>)>, _>>()
                .unwrap()
        };

        let updated = format!("---\namby-id: {source_id}\n---\nNew body #new [[Missing]]");
        fs::write(&source, &updated).unwrap();
        let updated_body = crate::frontmatter::parse_markdown(&updated).body;
        fail_next_index_stage(3);
        assert!(upsert_note_index(&conn, &vault, &source_id, &updated_body, &source).is_err());

        let content_after_failure: String = conn
            .query_row(
                "SELECT content FROM notes WHERE id = ?1",
                [&source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content_after_failure, before_content);
        let tags_after_failure: Vec<String> = conn
            .prepare("SELECT tag FROM tags WHERE note_id = ?1 ORDER BY tag")
            .unwrap()
            .query_map([&source_id], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        assert_eq!(tags_after_failure, before_tags);
        let links_after_failure: Vec<(String, String, Option<String>)> = conn
            .prepare(
                "SELECT raw, target, target_note_id FROM links WHERE note_id = ?1 ORDER BY rowid",
            )
            .unwrap()
            .query_map([&source_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<(String, String, Option<String>)>, _>>()
            .unwrap();
        assert_eq!(links_after_failure, before_links);

        sync_vault(&conn, &vault).unwrap();
        let recovered: String = conn
            .query_row(
                "SELECT content FROM notes WHERE id = ?1",
                [&source_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recovered, updated_body);
        drop(conn);
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn bundle_main_is_file_node_with_children() {
        let vault = temp_vault("bundle");
        fs::create_dir(vault.join("Parent")).unwrap();
        fs::write(vault.join("Parent/Parent.md"), "Parent").unwrap();
        fs::write(vault.join("Parent/Child.md"), "Child").unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.tree.len(), 1);
        assert_eq!(loaded.tree[0].name, "Parent");
        assert_eq!(loaded.tree[0].item_type, "file");
        assert_eq!(loaded.tree[0].children.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn incremental_reload_keeps_links_resolved() {
        let vault = temp_vault("incr-links");
        fs::write(vault.join("A.md"), "Link to [[B]]").unwrap();
        fs::write(vault.join("B.md"), "# B").unwrap();

        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert!(graph.edges.iter().all(|e| e.unresolved.is_none()));

        let graph2 = link_graph(&conn, &vault).unwrap();
        assert!(graph2.edges.iter().all(|e| e.unresolved.is_none()));
    }

    #[test]
    fn normalizes_heading_and_block_anchors() {
        assert_eq!(normalize_wiki_target("Note#Heading"), "note");
        assert_eq!(normalize_wiki_target("Note^block-id"), "note");
        assert_eq!(normalize_wiki_target("Note#Heading|Alias"), "note");
        assert_eq!(normalize_wiki_target("Folder/Note^abc"), "folder/note");
    }

    #[test]
    fn resolves_anchored_and_bundle_links() {
        let vault = temp_vault("anchors");
        fs::write(
            vault.join("A.md"),
            "[[Target#Intro]] [[Target^para1]] [[Bundle]]",
        )
        .unwrap();
        fs::write(vault.join("Target.md"), "# Target").unwrap();
        fs::create_dir(vault.join("Bundle")).unwrap();
        fs::write(vault.join("Bundle/Bundle.md"), "# Bundle").unwrap();

        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();

        assert_eq!(graph.edges.len(), 3);
        assert!(
            graph.edges.iter().all(|e| e.unresolved.is_none()),
            "all anchored/bundle links should resolve: {:?}",
            graph.edges
        );
    }

    #[test]
    fn deleting_target_unresolves_links_on_reload() {
        let vault = temp_vault("unresolve");
        fs::write(vault.join("A.md"), "Link to [[B]]").unwrap();
        fs::write(vault.join("B.md"), "# B").unwrap();
        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        assert!(link_graph(&conn, &vault)
            .unwrap()
            .edges
            .iter()
            .all(|e| e.unresolved.is_none()));

        fs::remove_file(vault.join("B.md")).unwrap();
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();
        assert!(graph.edges.iter().any(|e| e.unresolved == Some(true)));
    }

    #[test]
    fn extracts_obsidian_tags_and_ignores_code_comments_and_numeric_tags() {
        let body = "#visible #inbox/to-read #1984\n`#inline`\n```md\n#fenced\n```\n%% #hidden %%";
        assert_eq!(
            extract_tags(body, &["YamlTag".to_string(), "1984".to_string()]),
            vec![
                "inbox/to-read".to_string(),
                "visible".to_string(),
                "yamltag".to_string()
            ]
        );
    }

    #[test]
    fn extracts_links_only_from_markdown_content() {
        let body = "---\nalias: [[Yaml]]\n---\n[[Visible]] `[[Inline]]`\n```md\n[[Fence]]\n```\n%% [[Comment]] %%";
        let targets: Vec<_> = extract_links(body)
            .into_iter()
            .map(|(_, target, _)| target)
            .collect();
        assert_eq!(targets, vec!["visible".to_string()]);
    }
}
