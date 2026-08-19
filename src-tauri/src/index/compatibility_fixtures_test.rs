#[cfg(test)]
mod tests {
    use crate::frontmatter::parse_markdown;
    use crate::index::links::{extract_links, protected_markdown_ranges};
    use crate::index::tags::extract_tags;
    use serde::Deserialize;

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
}
