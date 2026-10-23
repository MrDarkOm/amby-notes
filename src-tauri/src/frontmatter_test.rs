use super::*;

#[test]
fn parses_existing_id_and_body() {
    let parsed = parse_markdown("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nHello");
    assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    assert_eq!(parsed.body, "Hello");
}

#[test]
fn parses_crlf_frontmatter_without_treating_it_as_note_body() {
    let parsed = parse_markdown(
        "---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\ntags:\r\n  - Finnish\r\n---\r\nHello\r\n",
    );

    assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    assert_eq!(parsed.frontmatter_tags, vec!["Finnish"]);
    assert_eq!(parsed.body, "Hello\r\n");
}

#[test]
fn parses_bom_prefixed_crlf_frontmatter() {
    let parsed =
        parse_markdown("\u{feff}---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n---\r\nHello\r\n");

    assert_eq!(parsed.id.as_deref(), Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    assert_eq!(parsed.body, "Hello\r\n");
}

#[test]
fn parses_independent_display_title_without_claiming_generic_title() {
    let parsed = parse_markdown(
        "---\r\namby-title:  Алекс из YAML  \r\ntitle: Generic\r\n---\r\n# Алекс из body\r\n",
    );
    assert_eq!(parsed.display_title.as_deref(), Some("Алекс из YAML"));

    let empty = parse_markdown("---\namby-title: \"\"\n---\n# Body\n");
    assert_eq!(empty.display_title, None);
}

#[test]
fn reads_properties_without_normalizing_yaml() {
    let properties = note_properties(
        "---\n# keep comment\ntitle: Project\ndone: true\ntags: [work, amby]\n---\nBody",
    );
    assert!(properties.has_frontmatter);
    assert_eq!(properties.parse_error, None);
    assert_eq!(properties.properties.len(), 3);
    assert_eq!(properties.properties[0].key, "title");
    assert_eq!(properties.properties[0].value, "Project");
    assert_eq!(properties.properties[1].value_kind, "checkbox");
    assert_eq!(properties.properties[2].value_kind, "list");
}

#[test]
fn inserts_id_without_frontmatter() {
    let content = body_with_id("Hello", "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert!(content.starts_with("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n"));
    assert!(content.ends_with("Hello"));
}

#[test]
fn inserts_id_before_a_bom_prefixed_body_without_duplicating_the_bom() {
    let content = body_with_id("\u{feff}Hello", "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

    assert!(content.starts_with("\u{feff}---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n"));
    assert_eq!(content.matches('\u{feff}').count(), 1);
    assert_eq!(parse_markdown(&content).body, "Hello");
}

#[test]
fn refuses_to_replace_an_existing_id() {
    let result = body_with_id(
        "---\namby-id: user-managed\n---\nHello",
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    assert!(result.is_err());
}

#[test]
fn id_insertion_preserves_yaml_presentation_and_envelope_bytes() {
    for bom in ["", "\u{feff}"] {
        for eol in ["\n", "\r\n"] {
            for suffix in ["", "\nBody\n\n"] {
                let yaml = concat!(
                    "# before first property\n",
                    "title: 'Single quoted'  # inline comment\n",
                    "double: \"Double quoted\"\n",
                    "inline: [a, b]\n",
                    "\n",
                    "nested: &nested\n",
                    "  value: 1\n",
                    "alias: *nested\n",
                    "literal: |\n",
                    "  keep these lines\n",
                    "  and their indentation\n",
                    "# after last property\n",
                )
                .replace('\n', eol);
                let tail = format!("{yaml}---{}", suffix.replace('\n', eol));
                let original = format!("{bom}---{eol}{tail}");
                let inserted = body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

                assert_eq!(
                    inserted,
                    format!("{bom}---{eol}amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV{eol}{tail}")
                );
                assert_eq!(
                    parse_markdown(&inserted).id.as_deref(),
                    Some("01ARZ3NDEKTSV4RRFFQ69G5FAV")
                );
                assert_eq!(
                    parse_markdown(&inserted).body,
                    parse_markdown(&original).body
                );
            }
        }
    }
}

#[test]
fn id_insertion_accepts_empty_and_comment_only_frontmatter() {
    for yaml in ["", "\n", "# comment\n", "  # comment\n\n"] {
        let original = format!("---\n{yaml}---\nBody");
        assert!(parse_markdown(&original).yaml_is_map);
        assert_eq!(
            body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
            format!("---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n{yaml}---\nBody")
        );
    }
}

#[test]
fn id_insertion_without_frontmatter_uses_source_line_ending() {
    for bom in ["", "\u{feff}"] {
        for body in ["", "# Hello", "# Hello\nBody\n", "# Hello\r\nBody\r\n"] {
            let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
            assert_eq!(
                body_with_id(&format!("{bom}{body}"), "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
                format!("{bom}---{eol}amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV{eol}---{eol}{body}")
            );
        }
    }
}

#[test]
fn id_insertion_refuses_every_existing_id_value() {
    for value in [
        "external", "''", "null", "", "42", "false", "[a, b]", "{a: b}",
    ] {
        let original = format!("---\n'amby-id': {value}\n---\nBody");
        assert!(
            body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err(),
            "{original}"
        );
    }
}

#[test]
fn id_insertion_refuses_yaml_that_cannot_be_extended_losslessly() {
    for yaml in [
        "tags: [one,\n",
        "title: one\n  other: two\n",
        "null\n",
        "~\n",
        "scalar\n",
        "[one, two]\n",
        "{title: 'flow mapping'}\n",
        "{}\n",
        "  title: indented\n",
    ] {
        let original = format!("---\n{yaml}---\nBody");
        assert!(
            body_with_id(&original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err(),
            "{original}"
        );
    }
}

#[test]
fn id_insertion_refuses_unterminated_frontmatter() {
    for original in ["---\ntitle: open\nBody", "\u{feff}---\r\ntags: [one,\r\n"] {
        assert!(body_with_id(original, "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err());
    }
}

#[test]
fn body_replacement_keeps_frontmatter_bytes_exact() {
    let original = concat!(
        "---\n",
        "# User-owned comment\n",
        "title: Example\n",
        "custom: [one, two]\n",
        "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
        "---\n",
        "Original body\n",
    );

    let replaced =
        replace_body_preserving_id(original, "Edited body\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();

    assert_eq!(
        replaced,
        concat!(
            "---\n",
            "# User-owned comment\n",
            "title: Example\n",
            "custom: [one, two]\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
            "---\n",
            "Edited body\n",
        )
    );
}

#[test]
fn body_replacement_keeps_bom_and_crlf_frontmatter_bytes_exact() {
    let original = concat!(
        "\u{feff}---\r\n",
        "# User-owned comment\r\n",
        "title: Example\r\n",
        "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
        "---\r\n",
        "Original body\r\n",
    );

    let replaced =
        replace_body_preserving_id(original, "Edited body\r\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();

    assert_eq!(
        replaced,
        concat!(
            "\u{feff}---\r\n",
            "# User-owned comment\r\n",
            "title: Example\r\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
            "---\r\n",
            "Edited body\r\n",
        )
    );
}

#[test]
fn deleted_note_restore_template_preserves_opaque_yaml_bom_and_crlf() {
    let template = concat!(
        "\u{feff}---\r\n",
        "# User-owned comment\r\n",
        "custom: [one, two]\r\n",
        "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
        "---\r\n",
        "Original body\r\n",
    );
    let next =
        replace_body_preserving_id(template, "Restored\nbody\n", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();
    let bytes = text_bytes_from_template(template, &next).unwrap();

    assert_eq!(
        bytes,
        concat!(
            "\u{feff}---\r\n",
            "# User-owned comment\r\n",
            "custom: [one, two]\r\n",
            "amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n",
            "---\r\n",
            "Restored\r\n",
            "body\r\n",
        )
        .as_bytes()
    );
}

#[test]
fn body_replacement_refuses_an_unexpected_frontmatter_id() {
    let original = "---\namby-id: user-managed\n---\nOriginal body";
    assert!(
        replace_body_preserving_id(original, "Edited body", "01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err()
    );
}

#[test]
fn atomic_write_replaces_existing_content_without_leaving_a_temp_file() {
    let dir = std::env::temp_dir().join(format!(
        "amby-atomic-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    fs::write(&path, "old").unwrap();

    atomic_write(&path, "new").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn atomic_write_preserves_utf8_bom_and_crlf() {
    let dir = std::env::temp_dir().join(format!(
        "amby-text-format-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    fs::write(&path, b"\xEF\xBB\xBFbefore\r\ntext\r\n").unwrap();

    atomic_write(&path, "after\ntext\n").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFafter\r\ntext\r\n");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn id_insertion_preserves_one_bom_crlf_and_terminal_line_breaks() {
    let dir = std::env::temp_dir().join(format!(
        "amby-frontmatter-format-{}-{}",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("note.md");
    fs::write(&path, b"\xEF\xBB\xBFbody\r\n\r\n\r\n").unwrap();

    let source = fs::read_to_string(&path).unwrap();
    let next = body_with_id(&source, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    atomic_write(&path, &next).unwrap();

    let persisted = fs::read(&path).unwrap();
    assert!(persisted.starts_with(b"\xEF\xBB\xBF---\r\n"));
    assert_eq!(
        persisted
            .windows(3)
            .filter(|bytes| *bytes == b"\xEF\xBB\xBF")
            .count(),
        1
    );
    assert!(!persisted.windows(2).any(|bytes| bytes == b"\n\n"));
    assert!(persisted.ends_with(b"body\r\n\r\n\r\n"));
    fs::remove_dir_all(dir).unwrap();
}

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
fn reads_yaml_tag_lists_without_changing_frontmatter() {
    let source = "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntags:\n  - Project\n  - inbox/to-read\n---\nBody";
    let parsed = parse_markdown(source);
    assert_eq!(
        parsed.frontmatter_tags,
        vec!["Project".to_string(), "inbox/to-read".to_string()]
    );
    assert_eq!(parsed.body, "Body");
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
fn yaml_binding_splice_preserves_bom_crlf_comments_and_unknown_keys() {
    let source = "\u{feff}---\r\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n# keep\r\nstatus: old\r\nunknown: keep\r\n---\r\nBody";
    let next =
        replace_yaml_binding_lossless(source, "status", &Value::String("done".into())).unwrap();
    assert!(next.starts_with("\u{feff}---\r\n"));
    assert!(next.contains("# keep\r\n"));
    assert!(next.contains("status: done\r\n"));
    assert!(next.contains("unknown: keep\r\n"));
}

#[test]
fn yaml_binding_splice_refuses_multiline_values_and_malformed_envelopes() {
    let source = "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nBody";
    assert!(
        replace_yaml_binding_lossless(source, "status", &Value::String("a\nb".into())).is_err()
    );
    assert!(replace_yaml_binding_lossless(
        "---\nstatus: [\nBody",
        "status",
        &Value::String("done".into())
    )
    .is_err());
    let sequence = replace_yaml_binding_lossless(
        source,
        "labels",
        &Value::Sequence(vec![
            Value::String("one".into()),
            Value::String("two".into()),
        ]),
    )
    .unwrap();
    assert!(sequence.contains("labels: [one, two]"));

    let mut mapping = serde_yaml::Mapping::new();
    mapping.insert(
        Value::String("start".into()),
        Value::String("2026-09-20".into()),
    );
    mapping.insert(
        Value::String("end".into()),
        Value::String("2026-09-21".into()),
    );
    let with_mapping =
        replace_yaml_binding_lossless(source, "due", &Value::Mapping(mapping)).unwrap();
    assert!(with_mapping.contains("due: {start: 2026-09-20, end: 2026-09-21}"));
    let parsed = parse_markdown(&with_mapping);
    assert_eq!(parsed.frontmatter_status, FrontmatterStatus::Valid);
}

#[test]
fn yaml_binding_splice_changes_only_the_exact_top_level_key() {
    let source = concat!(
        "---\n",
        "Status: old\n",
        "nested:\n",
        "  Status: nested\n",
        "literal: |\n",
        "  Status: literal\n",
        "  status: literal-case\n",
        "status: before  # preserve this comment\n",
        "---\n",
        "Body",
    );

    let next =
        replace_yaml_binding_lossless(source, "status", &Value::String("done".into())).unwrap();

    assert_eq!(
        next,
        concat!(
            "---\n",
            "Status: old\n",
            "nested:\n",
            "  Status: nested\n",
            "literal: |\n",
            "  Status: literal\n",
            "  status: literal-case\n",
            "status: done  # preserve this comment\n",
            "---\n",
            "Body",
        )
    );
    let mapping = frontmatter_yaml_mapping(&next).unwrap().unwrap();
    assert_eq!(
        mapping[&Value::String("Status".into())],
        Value::String("old".into())
    );
    assert_eq!(
        mapping[&Value::String("status".into())],
        Value::String("done".into())
    );
}

#[test]
fn yaml_binding_removal_keeps_nested_mapping_and_block_scalar_bytes() {
    let source = concat!(
        "---\n",
        "status: old\n",
        "nested:\n",
        "  status: nested\n",
        "description: |\n",
        "  status: literal\n",
        "other: keep\n",
        "---\n",
        "Body",
    );
    let next = remove_yaml_binding_lossless(source, "status").unwrap();
    assert_eq!(
        next,
        concat!(
            "---\n",
            "nested:\n",
            "  status: nested\n",
            "description: |\n",
            "  status: literal\n",
            "other: keep\n",
            "---\n",
            "Body",
        )
    );
}

#[test]
fn yaml_binding_splice_respects_quoted_key_semantics_and_case() {
    let source = "---\n'Status': upper\n\"status\": lower\n---\nBody";
    let next =
        replace_yaml_binding_lossless(source, "status", &Value::String("done".into())).unwrap();

    assert_eq!(next, "---\n'Status': upper\n\"status\": done\n---\nBody");
}

#[test]
fn yaml_binding_splice_rejects_ambiguous_duplicate_top_level_keys_before_mutation() {
    let source = "---\nstatus: first\n\"status\": second\n---\nBody";
    let result = replace_yaml_binding_lossless(source, "status", &Value::String("done".into()));
    assert!(result.is_err());

    let result = remove_yaml_binding_lossless(source, "status");
    assert!(result.is_err());
}

#[test]
fn yaml_binding_splice_preserves_bom_crlf_and_block_scalar_bytes_exactly() {
    let source = concat!(
        "\u{feff}---\r\n",
        "# keep\r\n",
        "status: old\r\n",
        "description: |\r\n",
        "  status: untouched\r\n",
        "  keep: this\r\n",
        "---\r\n",
        "Body\r\n",
    );
    let next =
        replace_yaml_binding_lossless(source, "status", &Value::String("new".into())).unwrap();
    assert_eq!(
        next,
        concat!(
            "\u{feff}---\r\n",
            "# keep\r\n",
            "status: new\r\n",
            "description: |\r\n",
            "  status: untouched\r\n",
            "  keep: this\r\n",
            "---\r\n",
            "Body\r\n",
        )
    );
}

#[test]
fn yaml_binding_splice_refuses_removing_multiline_or_anchored_values() {
    let block = "---\nstatus: |\n  first\n  second\nother: keep\n---\nBody";
    assert!(remove_yaml_binding_lossless(block, "status").is_err());
    assert!(replace_yaml_binding_lossless(block, "status", &Value::String("done".into())).is_err());

    let anchored = "---\nstatus: &saved old\nother: keep\n---\nBody";
    assert!(
        replace_yaml_binding_lossless(anchored, "status", &Value::String("done".into())).is_err()
    );
}

#[test]
fn yaml_binding_splice_scans_escaped_quoted_keys_without_touching_them() {
    let source = "---\n'it''s': keep\n\"a\\\"b\": also-keep\nstatus: old\n---\nBody";
    let next =
        replace_yaml_binding_lossless(source, "status", &Value::String("done".into())).unwrap();
    assert_eq!(
        next,
        "---\n'it''s': keep\n\"a\\\"b\": also-keep\nstatus: done\n---\nBody"
    );
}

#[test]
fn yaml_binding_splice_rejects_flow_root_and_complex_top_level_keys() {
    for source in [
        "---\n{status: old}\n---\nBody",
        "---\n? [status]\n: old\n---\nBody",
    ] {
        let result = replace_yaml_binding_lossless(source, "status", &Value::String("done".into()));
        assert!(result.is_err(), "{source}");
    }
}

#[test]
fn upsert_and_remove_frontmatter_property_handles_types_and_missing_envelope() {
    let note_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    // 1. Without initial frontmatter envelope
    let bare = "Just body text here.";
    let with_status =
        upsert_frontmatter_property(bare, note_id, "status", "active", "text").unwrap();
    assert!(with_status.contains("amby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV"));
    assert!(with_status.contains("status: active"));
    assert!(with_status.ends_with("Just body text here."));

    // 2. Add checkbox property
    let with_checkbox =
        upsert_frontmatter_property(&with_status, note_id, "done", "true", "checkbox").unwrap();
    assert!(with_checkbox.contains("done: true"));

    // 3. Add number property
    let with_number =
        upsert_frontmatter_property(&with_checkbox, note_id, "priority", "42", "number").unwrap();
    assert!(with_number.contains("priority: 42"));

    // 4. Add unicode property key (e.g. Russian "статус")
    let with_unicode =
        upsert_frontmatter_property(&with_number, note_id, "статус", "в_работе", "text").unwrap();
    assert!(with_unicode.contains("статус: в_работе"));

    // 5. Update existing property
    let updated =
        upsert_frontmatter_property(&with_unicode, note_id, "done", "false", "checkbox").unwrap();
    assert!(updated.contains("done: false"));

    // 6. Remove property
    let removed = remove_frontmatter_property(&updated, "done").unwrap();
    assert!(!removed.contains("done:"));
    assert!(removed.contains("priority: 42"));
    assert!(removed.contains("статус: в_работе"));
    assert!(removed.ends_with("Just body text here."));
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

#[test]
fn yaml_binding_splice_updates_and_removes_inline_relations_without_changing_neighbors() {
    let source = "\u{feff}---\r\nProject: [one, two] # keep\r\nnested:\r\n  Project: untouched\r\n---\r\nBody\r\n";
    let next = replace_yaml_binding_lossless(
        source,
        "Project",
        &Value::Sequence(vec![Value::String("three".into())]),
    )
    .unwrap();
    assert_eq!(next, source.replace("[one, two]", "[three]"));
    let removed = remove_yaml_binding_lossless(&next, "Project").unwrap();
    assert_eq!(
        removed,
        "\u{feff}---\r\nnested:\r\n  Project: untouched\r\n---\r\nBody\r\n"
    );
    let mapping = "---\nmetadata: {label: 'it''s # fine', ids: [one, two]} # trailing\nother: untouched\n---\nBody";
    assert_eq!(
        replace_yaml_binding_lossless(mapping, "metadata", &Value::String("done".into())).unwrap(),
        "---\nmetadata: done # trailing\nother: untouched\n---\nBody"
    );
    for value in [
        "[&anchor one]",
        "[*anchor]",
        "[!!str one]",
        "[one,\n  two]",
        "|",
    ] {
        let source = format!("---\nanchor: &anchor old\nProject: {value}\n---\nBody");
        assert!(
            replace_yaml_binding_lossless(&source, "Project", &Value::Sequence(vec![])).is_err(),
            "{value}"
        );
        assert!(
            remove_yaml_binding_lossless(&source, "Project").is_err(),
            "{value}"
        );
    }
    let plain = "---\nstatus: ready!\n  # indented comment\n---\nBody";
    assert_eq!(
        replace_yaml_binding_lossless(plain, "status", &Value::String("done".into())).unwrap(),
        plain.replace("ready!", "done")
    );
}

#[test]
fn yaml_plain_apostrophes_do_not_hide_comments_or_flow_anchors() {
    for value in ["Bob's note", "ready 'now", "ready \"now", "plain [text"] {
        let source = format!("---\nBob's: keep\nstatus: {value} # preserve\n---\nBody");
        let expected = "---\nBob's: keep\nstatus: done # preserve\n---\nBody";
        assert_eq!(
            replace_yaml_binding_lossless(&source, "status", &Value::String("done".into()))
                .unwrap(),
            expected
        );
    }
    let flow = "---\nstatus: [Bob's, &saved keep, Sam's] # preserve\n---\nBody";
    assert!(replace_yaml_binding_lossless(flow, "status", &Value::String("done".into())).is_err());
}

#[test]
fn a_replaced_amby_id_changes_that_line_and_nothing_else() {
    // The copy of a conflict that stays as a note of its own gets its own identity
    // (docs/sync-plan.md, Р7, "keep both"): only the value of `amby-id` changes.
    let old = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let new = "01BX5ZZKBKACTAV9WEVGEMMVRY";
    for (source, expected) in [
        (
            format!("---\namby-id: {old}\ntitle: Keep # this\n---\nBody\n"),
            format!("---\namby-id: {new}\ntitle: Keep # this\n---\nBody\n"),
        ),
        (
            format!("\u{feff}---\r\n# mine\r\namby-id: \"{old}\"\r\nx: 1\r\n---\r\nBody\r\n"),
            format!("\u{feff}---\r\n# mine\r\namby-id: {new}\r\nx: 1\r\n---\r\nBody\r\n"),
        ),
    ] {
        let next = with_replaced_amby_id(&source, new).unwrap();
        assert_eq!(next, expected);
        assert_eq!(parse_markdown(&next).note_id(), Some(new));
    }
}

#[test]
fn an_amby_id_is_not_replaced_when_it_cannot_be_done_without_guessing() {
    let new = "01BX5ZZKBKACTAV9WEVGEMMVRY";
    // no id at all
    assert!(with_replaced_amby_id("---\ntitle: x\n---\nBody", new).is_err());
    // no frontmatter
    assert!(with_replaced_amby_id("Just text", new).is_err());
    // an id that is not a ULID cannot be given
    assert!(with_replaced_amby_id(
        "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nBody",
        "not-a-ulid"
    )
    .is_err());
    // the id appears twice (a duplicate key): refuse, do not pick one
    assert!(with_replaced_amby_id(
        "---\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\namby-id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\nBody",
        new
    )
    .is_err());
}
