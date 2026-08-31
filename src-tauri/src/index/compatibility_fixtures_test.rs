#[cfg(test)]
mod tests {
    use crate::frontmatter::parse_markdown;
    use crate::index::links::{extract_links, protected_markdown_ranges};
    use crate::index::tags::extract_tags;
    use crate::index::{db_path, load_vault, open_connection, read_note, write_note_filesystem};
    use serde::Deserialize;
    use std::fs;
    use std::path::{Path, PathBuf};
    use ulid::Ulid;

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct ExpectedLink {
        raw: String,
        target: String,
        label: String,
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct ExcludedRegion {
        from: usize,
        to: usize,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CompatibilityFixture {
        name: String,
        markdown: String,
        expected_tags: Vec<String>,
        expected_links: Vec<ExpectedLink>,
        excluded_regions: Vec<ExcludedRegion>,
    }

    fn copy_tree(source: &Path, target: &Path) {
        fs::create_dir_all(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let destination = target.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &destination);
            } else {
                fs::copy(entry.path(), destination).unwrap();
            }
        }
    }

    #[test]
    fn test_shared_markdown_compatibility_fixtures() {
        let json_str = include_str!("../../../tests/fixtures/markdown-compatibility.json");
        let fixtures: Vec<CompatibilityFixture> = serde_json::from_str(json_str)
            .expect("failed to parse shared markdown compatibility fixtures");

        for fixture in fixtures {
            // 1. Excluded regions
            let protected = protected_markdown_ranges(&fixture.markdown);
            let expected_regions: Vec<(usize, usize)> = fixture
                .excluded_regions
                .iter()
                .map(|r| (r.from, r.to))
                .collect();
            assert_eq!(
                protected, expected_regions,
                "failed excluded regions for fixture '{}'",
                fixture.name
            );

            // 2. Tags
            let parsed = parse_markdown(&fixture.markdown);
            let mut actual_tags = extract_tags(&parsed.body, &parsed.frontmatter_tags);
            actual_tags.sort();
            let mut expected_tags = fixture.expected_tags.clone();
            expected_tags.sort();
            assert_eq!(
                actual_tags, expected_tags,
                "failed tags for fixture '{}'",
                fixture.name
            );

            // 3. Wiki links
            let links = extract_links(&fixture.markdown);
            let actual_links: Vec<ExpectedLink> = links
                .into_iter()
                .map(|(raw, target, label)| ExpectedLink { raw, target, label })
                .collect();
            assert_eq!(
                actual_links, fixture.expected_links,
                "failed wiki links for fixture '{}'",
                fixture.name
            );
        }
    }

    #[test]
    fn compatibility_byte_fixtures_have_real_crlf_and_bom() {
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/compatibility-vault");
        let crlf = fs::read(source.join("CRLF.md")).unwrap();
        assert!(crlf.windows(2).any(|pair| pair == b"\r\n"));
        assert!(!String::from_utf8(crlf)
            .unwrap()
            .replace("\r\n", "")
            .contains('\n'));
        assert!(fs::read(source.join("BOM.md"))
            .unwrap()
            .starts_with(&[0xef, 0xbb, 0xbf]));
    }

    #[test]
    fn compatibility_vault_rebuild_does_not_mutate_sources_and_safe_body_save_preserves_envelope() {
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/compatibility-vault");
        let vault = std::env::temp_dir().join(format!("amby-compatibility-{}", Ulid::generate()));
        copy_tree(&source, &vault);
        let snapshots = fs::read_dir(&vault)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "md")
            })
            .map(|entry| (entry.path(), fs::read(entry.path()).unwrap()))
            .collect::<Vec<_>>();

        let conn = open_connection(&vault).unwrap();
        let first = load_vault(&conn, &vault).unwrap();
        assert_eq!(first.notes.len(), snapshots.len());
        drop(conn);
        fs::remove_file(db_path(&vault)).unwrap();

        let rebuilt = open_connection(&vault).unwrap();
        let second = load_vault(&rebuilt, &vault).unwrap();
        assert_eq!(second.notes.len(), snapshots.len());
        for (path, original) in snapshots {
            assert_eq!(fs::read(path).unwrap(), original);
        }

        let safe = second
            .notes
            .iter()
            .find(|note| note.path.ends_with("Plain Markdown.md"))
            .unwrap();
        let current = read_note(&rebuilt, &vault, &safe.id).unwrap();
        write_note_filesystem(
            &rebuilt,
            &vault,
            &safe.id,
            "# Plain Markdown\n\nEdited known body.\n",
            &current.revision,
        )
        .unwrap();
        let saved = fs::read_to_string(vault.join("Plain Markdown.md")).unwrap();
        let original = fs::read_to_string(source.join("Plain Markdown.md")).unwrap();
        let (envelope, _) = crate::frontmatter::split_frontmatter_envelope(&original).unwrap();
        assert!(saved.starts_with(envelope));
        assert!(saved
            .replace("\r\n", "\n")
            .ends_with("Edited known body.\n"));

        drop(rebuilt);
        assert!(db_path(&vault).exists());
        fs::remove_dir_all(vault).unwrap();
    }
}
