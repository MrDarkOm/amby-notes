#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::frontmatter::{atomic_copy_file_new, atomic_write_new};
    use crate::model::IndexState;
    use crate::paths::{confine, confine_rel};
    use crate::recovery::{read_recovery, save_recovery};
    use crate::vault_context::VaultContext;

    fn temp_test_dir(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby_security_test_{name}_{timestamp}"));
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn test_security_no_active_vault() {
        let context = VaultContext::default();
        // Initial state has no active vault
        assert!(context.root().is_err());
        assert!(context.generation().is_err());
    }

    #[test]
    fn test_security_path_outside_vault() {
        let temp = temp_test_dir("path_outside");
        let vault_root = temp.join("vault");
        let outside = temp.join("outside");
        fs::create_dir_all(&vault_root).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside");

        let secret_file = outside.join("passwords.txt");
        fs::write(&secret_file, "secret").expect("write secret");

        // Relative path traversal attempts under vault root
        assert!(confine_rel(&vault_root, "../outside/passwords.txt").is_err());
        assert!(confine_rel(&vault_root, "subdir/../../outside/passwords.txt").is_err());
        assert!(confine_rel(&vault_root, "/etc/passwd").is_err());

        // Confining candidate against vault root
        assert!(confine(&vault_root, &outside.join("passwords.txt")).is_err());

        let _ = fs::remove_dir_all(&temp);
    }

    #[cfg(unix)]
    #[test]
    fn test_security_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = temp_test_dir("symlink_escape");
        let vault_root = temp.join("vault");
        let outside = temp.join("outside");
        fs::create_dir_all(&vault_root).expect("create vault");
        fs::create_dir_all(&outside).expect("create outside");

        let secret_file = outside.join("secret.md");
        fs::write(&secret_file, "# Secret").expect("write secret");

        let link_inside = vault_root.join("leak_link.md");
        symlink(&secret_file, &link_inside).expect("symlink");

        assert!(confine(&vault_root, &link_inside).is_err());

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_security_stale_generation() {
        let context = VaultContext::default();
        let temp = temp_test_dir("stale_gen");
        let vault_path = temp.join("vault");
        fs::create_dir_all(&vault_path).expect("create dir");

        let gen1 = context
            .activate(
                vault_path.to_str().unwrap(),
                |_| Ok(()),
                |_, generation| generation,
            )
            .expect("activate gen1");

        // Advance vault load/generation
        let gen2 = context
            .activate(
                vault_path.to_str().unwrap(),
                |_| Ok(()),
                |_, generation| generation,
            )
            .expect("activate gen2");

        assert!(gen2 > gen1);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_security_filesystem_success_index_failure_marks_rebuild() {
        let context = VaultContext::default();
        let temp = temp_test_dir("fs_success_idx_fail");
        let vault_path = temp.join("vault");
        fs::create_dir_all(&vault_path).expect("create dir");

        context
            .activate(vault_path.to_str().unwrap(), |_| Ok(()), |_, _| ())
            .expect("activate vault");

        context
            .with_active(|active| {
                assert_eq!(active.index_health, IndexState::Healthy);
                Ok(())
            })
            .expect("check healthy");

        // File is created on filesystem safely
        let note_path = vault_path.join("Note.md");
        atomic_write_new(&note_path, "# User content").expect("atomic write new");
        assert!(note_path.exists());

        // An index failure marks context for rebuild without deleting or corrupting the user note
        context
            .mark_index_rebuild_required()
            .expect("mark rebuild required");

        context
            .with_active(|active| {
                assert_eq!(active.index_health, IndexState::RebuildRequired);
                Ok(())
            })
            .expect("check rebuild required");

        assert_eq!(
            fs::read_to_string(&note_path).expect("read note"),
            "# User content"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_security_recovery_corruption_and_size_limits() {
        let temp = temp_test_dir("recovery_sec");
        let vault = &temp;

        // 1. Oversized recovery entry is rejected (MAX_ENTRY_SIZE_BYTES is 5 MB)
        let oversized = "a".repeat(5 * 1024 * 1024 + 1);
        let res = save_recovery(vault, 1, "huge-note", "markdown", "huge.md", &oversized);
        assert!(res.is_err());

        // 2. Normal recovery entry is saved and readable
        save_recovery(
            vault,
            1,
            "valid-note",
            "markdown",
            "valid.md",
            "# Recovered text",
        )
        .expect("save recovery");

        let entry = read_recovery(vault, "valid-note")
            .expect("read recovery")
            .expect("found");
        assert_eq!(entry.content, "# Recovered text");

        // 3. Corrupting the file on disk is handled safely
        let recovery_file = vault.join(".amby").join("recovery").join("valid-note.json");
        fs::write(&recovery_file, "INVALID JSON {{").expect("write corrupt");

        assert!(read_recovery(vault, "valid-note").unwrap_or(None).is_none());

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_security_attachment_limits() {
        let temp = temp_test_dir("attachment_limits");
        let src = temp.join("source.dat");
        let dst = temp.join("dest.dat");

        // Write a 100-byte file
        fs::write(&src, vec![0u8; 100]).expect("write src");

        // Enforce a max_bytes limit of 50 bytes -> should fail
        let res = atomic_copy_file_new(&src, &dst, 50);
        assert!(res.is_err());
        assert!(!dst.exists());

        // Enforce a max_bytes limit of 200 bytes -> should succeed
        let res = atomic_copy_file_new(&src, &dst, 200);
        assert!(res.is_ok());
        assert!(dst.exists());

        let _ = fs::remove_dir_all(&temp);
    }
}
