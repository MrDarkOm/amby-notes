use super::*;
use crate::index::schema::init_schema;

const DB: &str = "01J00000000000000000000000";
const OTHER_DB: &str = "01J000000000000000000000ZZ";

fn id(index: u32) -> String {
    format!("01J{index:023}")
}

fn connection(titles: &[&str]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    for database in [DB, OTHER_DB] {
        conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, ?1, 'D', 0, 1, 'm', 'healthy')",
            [database],
        )
        .unwrap();
    }
    for (index, title) in titles.iter().enumerate() {
        let note_id = id(index as u32 + 1);
        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
            params![note_id, format!("Folder{index}/{title}.md"), title],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO db_members (database_id, note_id, relative_path, category_path, depth, title_sort_key) VALUES (?1, ?2, ?3, '[]', 0, ?4)",
            params![DB, note_id, format!("{title}.md"), title.to_lowercase().into_bytes()],
        )
        .unwrap();
    }
    conn
}

fn request(
    search: Option<&str>,
    cursor: Option<String>,
    limit: u32,
) -> SearchRelationCandidatesRequest {
    SearchRelationCandidatesRequest {
        expected_generation: 1,
        database_id: DB.to_owned(),
        search: search.map(str::to_owned),
        cursor,
        limit: Some(limit),
    }
}

#[test]
fn pages_through_every_candidate_in_title_order_without_gaps() {
    let titles: Vec<String> = (0..250).map(|index| format!("Page {index:03}")).collect();
    let refs: Vec<&str> = titles.iter().map(String::as_str).collect();
    let conn = connection(&refs);
    let mut seen = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let page = search_relation_candidates(&conn, &request(None, cursor, 100)).unwrap();
        pages += 1;
        seen.extend(
            page.candidates
                .iter()
                .map(|candidate| candidate.title.clone()),
        );
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(pages, 3);
    assert_eq!(seen, titles);
}

#[test]
fn finds_a_page_far_beyond_the_first_hundred() {
    let titles: Vec<String> = (0..500).map(|index| format!("Page {index:03}")).collect();
    let refs: Vec<&str> = titles.iter().map(String::as_str).collect();
    let conn = connection(&refs);
    let page = search_relation_candidates(&conn, &request(Some("page 437"), None, 50)).unwrap();
    assert_eq!(page.candidates.len(), 1);
    assert_eq!(page.candidates[0].title, "Page 437");
    assert!(page.next_cursor.is_none());
}

#[test]
fn equal_titles_stay_distinguishable_by_path_and_id() {
    let conn = connection(&["Site", "Site", "Other"]);
    let page = search_relation_candidates(&conn, &request(Some("site"), None, 10)).unwrap();
    assert_eq!(page.candidates.len(), 2);
    assert_ne!(page.candidates[0].note_id, page.candidates[1].note_id);
    assert_ne!(page.candidates[0].path, page.candidates[1].path);
}

#[test]
fn search_text_is_data_not_a_pattern() {
    let conn = connection(&["100% done", "100 items", "a_b", "axb"]);
    let percent = search_relation_candidates(&conn, &request(Some("100%"), None, 10)).unwrap();
    assert_eq!(percent.candidates.len(), 1);
    let underscore = search_relation_candidates(&conn, &request(Some("a_b"), None, 10)).unwrap();
    assert_eq!(underscore.candidates.len(), 1);
    assert_eq!(underscore.candidates[0].title, "a_b");
}

#[test]
fn rejects_unknown_databases_bad_cursors_and_clamps_the_page_size() {
    let conn = connection(&["A"]);
    let mut unknown = request(None, None, 10);
    unknown.database_id = id(900);
    assert!(search_relation_candidates(&conn, &unknown).is_err());
    assert!(
        search_relation_candidates(&conn, &request(None, Some("zz:nope".to_owned()), 10)).is_err()
    );
    let huge = search_relation_candidates(&conn, &request(None, None, 100_000)).unwrap();
    assert_eq!(huge.candidates.len(), 1);
}

#[test]
fn only_members_of_the_target_database_are_candidates() {
    let conn = connection(&["Member"]);
    conn.execute(
        "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'x.md', 'Outsider', 0, 0, '', 0, 0, 0)",
        [id(500)],
    )
    .unwrap();
    let page = search_relation_candidates(&conn, &request(Some("outsider"), None, 10)).unwrap();
    assert!(page.candidates.is_empty());
}

#[test]
fn resolves_known_and_missing_references_in_request_order() {
    let conn = connection(&["Alpha", "Beta"]);
    let missing = id(777);
    let resolved = resolve_record_references(
        &conn,
        &ResolveRecordReferencesRequest {
            expected_generation: 1,
            note_ids: vec![id(2), missing.clone(), id(1)],
        },
    )
    .unwrap();
    let states: Vec<_> = resolved
        .references
        .iter()
        .map(|reference| {
            (
                reference.note_id.clone(),
                reference.state,
                reference.title.clone(),
            )
        })
        .collect();
    assert_eq!(
        states,
        vec![
            (id(2), RecordReferenceState::Ok, Some("Beta".to_owned())),
            (missing, RecordReferenceState::Missing, None),
            (id(1), RecordReferenceState::Ok, Some("Alpha".to_owned())),
        ]
    );
}

#[test]
fn resolve_rejects_oversized_or_malformed_requests() {
    let conn = connection(&["A"]);
    let too_many = ResolveRecordReferencesRequest {
        expected_generation: 1,
        note_ids: (0..=MAX_RESOLVED_REFERENCES as u32).map(id).collect(),
    };
    assert!(resolve_record_references(&conn, &too_many).is_err());
    let malformed = ResolveRecordReferencesRequest {
        expected_generation: 1,
        note_ids: vec!["not-an-id".to_owned()],
    };
    assert!(resolve_record_references(&conn, &malformed).is_err());
}

/// Benchmark for docs/performance-baseline.md:
/// `cargo test --lib relation_search_p95 -- --ignored --nocapture`
#[test]
#[ignore = "benchmark"]
fn relation_search_p95_on_10k_records() {
    use std::time::Instant;
    let titles: Vec<String> = (0..10_000)
        .map(|index| {
            format!(
                "Project {} — page {index:05}",
                ["Alpha", "Beta", "Gamma", "Delta"][index % 4]
            )
        })
        .collect();
    let refs: Vec<&str> = titles.iter().map(String::as_str).collect();
    let conn = connection(&refs);
    let mut samples = Vec::new();
    let searches = ["", "page 09999", "gamma", "delta — page 077", "zzz", "5"];
    for round in 0..40 {
        for search in searches {
            let started = Instant::now();
            let page = search_relation_candidates(&conn, &request(Some(search), None, 50)).unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            // A deep page through the keyset cursor.
            if round % 4 == 0 {
                if let Some(cursor) = page.next_cursor {
                    let started = Instant::now();
                    search_relation_candidates(&conn, &request(Some(search), Some(cursor), 50))
                        .unwrap();
                    samples.push(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
        }
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| samples[((samples.len() as f64 * q) as usize).min(samples.len() - 1)];
    println!(
        "relation search, 10k records, {} samples: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms",
        samples.len(),
        p(0.5),
        p(0.95),
        samples.last().unwrap()
    );
    assert!(p(0.95) <= 150.0);
}
