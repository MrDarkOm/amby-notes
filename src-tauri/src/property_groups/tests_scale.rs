//! The measurement at one million notes (docs/sync-plan.md, appendix З: З43). Not a gate: the
//! tests are `#[ignore]`d and print numbers; the threshold of the gate is set after the first
//! measurement. Run: `cargo test --release property_groups::tests_scale -- --ignored --nocapture`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Instant;

use serde_json::json;

use super::testkit::*;
use super::*;

/// One million ids, a third with a design of ~200 bytes, written straight into the 256 groups.
fn fill_groups(fx: &Fx, notes: u32) {
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, GroupFile> = BTreeMap::new();
    for n in 0..notes {
        if n % 3 != 0 {
            continue;
        }
        let note = format!("01JD{n:022}");
        let entry = NoteEntry {
            hint: Some(Hint {
                path: format!("Папка/Заметка {n}.md"),
                title: format!("Заметка {n}"),
            }),
            properties: vec![Design {
                id: format!("01JE{n:022}"),
                icon: "📌".into(),
                property_type: "select".into(),
                settings: "Идея,В работе,Готово".into(),
                ..design(&format!("Статус {}", n % 7))
            }],
            legacy: Some(LegacyMark {
                entry: "a".repeat(64),
                record: "b".repeat(64),
            }),
            ..NoteEntry::default()
        };
        groups
            .entry(amby_sync_core::engine::props_groups::group_of(&note))
            .or_insert_with(|| GroupFile {
                version: 1,
                notes: Default::default(),
                extra: Default::default(),
            })
            .notes
            .insert(note, entry);
    }
    for (g, file) in groups {
        fx.write_bytes(
            &format!(".amby/properties/{g}.json"),
            &canonical_group_bytes(&file),
        );
    }
}

#[test]
#[ignore = "measurement, minutes of work: run by hand (З43)"]
fn one_million_notes_size_of_a_group_one_edit_and_a_full_walk() {
    // З43: group ≈ 0.45 MB, all groups ≈ 115 MB; an edit writes one group; the panel reads SQLite
    let fx = fx();
    fill_groups(&fx, 1_000_000);
    let sizes: Vec<usize> = fx
        .files_under(".amby/properties/")
        .iter()
        .filter(|p| !p.ends_with("layout.json"))
        .map(|p| fx.bytes(p).unwrap().len())
        .collect();
    let (total, biggest) = (
        sizes.iter().sum::<usize>(),
        sizes.iter().max().copied().unwrap(),
    );
    println!(
        "scale groups={} total={total} biggest={biggest}",
        sizes.len()
    );
    assert!(
        biggest < 16_000_000,
        "the limit of the merge (З30) is never near"
    );

    let note = "01JD0000000000000000000000".to_string();
    fx.note(&note, "N.md", "");
    let started = Instant::now();
    set_appearance(
        &fx.conn,
        &fx.vault,
        &note,
        "01JE0000000000000000000000",
        "🔥",
        "",
    )
    .ok();
    println!("scale one-edit={:?}", started.elapsed());

    let started = Instant::now();
    rebuild_cache(&fx.conn, &fx.vault).ok();
    println!("scale rebuild-cache={:?}", started.elapsed());

    let started = Instant::now();
    let report = migration::preview(&fx.conn, &fx.vault);
    println!(
        "scale migration-report={:?} ok={}",
        started.elapsed(),
        report.is_ok()
    );
    let _ = json!(null);
}
