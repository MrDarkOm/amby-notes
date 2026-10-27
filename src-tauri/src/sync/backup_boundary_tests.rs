//! A published receipt must never point at a copy removed during error cleanup.

use super::backup;
use crate::frontmatter::{clear_atomic_write_failure, inject_nth_atomic_write_failure};

#[test]
fn an_error_after_receipt_publication_keeps_the_complete_copy_for_retry() {
    let container =
        std::env::temp_dir().join(format!("amby-backup-boundary-{}", ulid::Ulid::generate()));
    let vault = container.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(vault.join("n.md"), b"the only version").unwrap();

    let result = backup::create_with_hook(&vault, &container, || {
        inject_nth_atomic_write_failure(1, true);
        Ok(())
    });
    clear_atomic_write_failure();
    assert!(
        result.is_err(),
        "the caller must see the durability failure"
    );
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(vault.join(".amby/sync/pre-sync-backup.json")).unwrap(),
    )
    .unwrap();
    let path = std::path::PathBuf::from(receipt["backup_root"].as_str().unwrap());
    let bytes = std::fs::read(path.join("vault/n.md"));
    let retry = backup::ensure(&vault);
    // Clean up before assertions, including on the broken implementation.
    std::fs::remove_dir_all(&container).unwrap();
    assert_eq!(bytes.unwrap(), b"the only version");
    assert_eq!(retry.unwrap(), path.to_str().unwrap());
}
