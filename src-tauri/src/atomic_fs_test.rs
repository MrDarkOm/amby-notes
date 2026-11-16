use super::*;

#[test]
fn atomic_write_failure_at_each_phase_keeps_original_and_cleans_temp() {
    let dir = std::env::temp_dir().join(format!(
        "amby-atomic-failure-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");

    for stage in 1..=4 {
        fs::write(&path, "original").unwrap();
        FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.set(stage));
        let error = atomic_write_bytes(&path, b"replacement").unwrap_err();
        assert!(error.contains("injected"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "stage {stage}");
    }
    FAIL_ATOMIC_WRITE_STAGE.with(|requested| requested.set(0));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn atomic_write_new_never_replaces_an_existing_file() {
    let dir = std::env::temp_dir().join(format!(
        "amby-create-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    fs::write(&path, "original").unwrap();

    assert_eq!(
        atomic_write_new(&path, "replacement"),
        Err(AtomicCreateError::AlreadyExists)
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");

    let new_path = dir.join("copy.md");
    atomic_write_new(&new_path, "copy").unwrap();
    assert_eq!(fs::read_to_string(&new_path).unwrap(), "copy");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn target_created_at_publish_barrier_is_never_replaced() {
    let dir = std::env::temp_dir().join(format!(
        "amby-publish-race-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    let sentinel = b"foreign target bytes".to_vec();

    CREATE_TARGET_AT_PUBLISH.with(|pending| pending.replace(Some(sentinel.clone())));
    let result = atomic_write_new(&path, "our prepared bytes");

    eprintln!("WIN-FS.4b: foreign target created at pre-publication barrier");
    assert_eq!(result, Err(AtomicCreateError::AlreadyExists));
    assert_eq!(fs::read(&path).unwrap(), sentinel);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn no_replace_fallback_handles_unsupported_hard_links_and_collisions() {
    let dir = std::env::temp_dir().join(format!(
        "amby-no-replace-fallback-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    let source = dir.join("source.bin");
    let copied = dir.join("copied.bin");
    fs::write(&source, b"source bytes").unwrap();

    FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(true));
    atomic_write_new(&path, "created by fallback").unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "created by fallback");
    assert_eq!(
        atomic_write_new(&path, "must not replace"),
        Err(AtomicCreateError::AlreadyExists)
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "created by fallback");

    assert_eq!(
        atomic_copy_file_new(&source, &copied, 1024).unwrap(),
        b"source bytes".len() as u64
    );
    assert_eq!(fs::read(&copied).unwrap(), b"source bytes");
    FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(false));

    assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn no_replace_fallback_cleans_a_reserved_target_after_copy_failure() {
    let dir = std::env::temp_dir().join(format!(
        "amby-no-replace-cleanup-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");

    FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(true));
    FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.set(true));
    let error = atomic_write_new(&path, "partial").unwrap_err();
    FAIL_NO_REPLACE_FALLBACK_COPY.with(|fail| fail.set(false));
    FORCE_HARD_LINK_UNSUPPORTED.with(|forced| forced.set(false));

    assert!(matches!(error, AtomicCreateError::Other(_)));
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unsupported_hard_link_error_classes_select_the_fallback() {
    for code in [1, 5, 17, 18, 31, 45, 50, 95] {
        assert!(hard_link_is_unsupported(
            &std::io::Error::from_raw_os_error(code)
        ));
    }
}

#[test]
fn atomic_copy_file_new_streams_file_and_enforces_max_bytes() {
    let dir = std::env::temp_dir().join(format!(
        "amby-copy-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let src = dir.join("source.bin");
    let dest = dir.join("dest.bin");

    // Write 1KB payload
    let payload = vec![0x42u8; 1024];
    fs::write(&src, &payload).unwrap();

    // 1. Success copy
    let copied = atomic_copy_file_new(&src, &dest, 2048).unwrap();
    assert_eq!(copied, 1024);
    assert_eq!(fs::read(&dest).unwrap(), payload);

    // 2. Reject existing destination
    assert_eq!(
        atomic_copy_file_new(&src, &dest, 2048),
        Err(AtomicCreateError::AlreadyExists)
    );

    // 3. Reject if source exceeds max_bytes
    let dest_small_limit = dir.join("dest2.bin");
    assert!(atomic_copy_file_new(&src, &dest_small_limit, 512).is_err());
    assert!(!dest_small_limit.exists());

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn test_rename_with_retry_succeeds_after_transient_sharing_violations() {
    let mut count = 0;
    let result = rename_with_retry(|| {
        count += 1;
        if count < 3 {
            Err(std::io::Error::from_raw_os_error(32))
        } else {
            Ok(())
        }
    });
    assert!(result.is_ok());
    assert_eq!(count, 3);
}

#[test]
fn test_rename_with_retry_fails_when_non_retryable() {
    let mut count = 0;
    let result = rename_with_retry(|| {
        count += 1;
        Err(std::io::Error::from_raw_os_error(2)) // ENOENT
    });
    assert!(result.is_err());
    assert_eq!(count, 1);
}
