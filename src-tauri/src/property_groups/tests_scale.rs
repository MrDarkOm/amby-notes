//! The measurement at one million notes (docs/sync-plan.md, appendix З: З56). Not a gate: the
//! tests are `#[ignore]`d and print numbers; the threshold of the gate is set after the first
//! measurement. Run: `cargo test --release property_groups::tests_scale -- --ignored --nocapture`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::time::Instant;

use super::testkit::*;
use super::*;

/// One million ids, every `every`-th with one difference (an icon and options), written straight
/// into the 16 files as sorted lines.
fn fill_groups(fx: &Fx, notes: u32, every: u32) -> u32 {
    let mut files: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut lines = 0;
    for n in 0..notes {
        if n % every != 0 {
            continue;
        }
        let note = format!("01JD{n:022}");
        let line = format!(
            "{{\"hint\":{{\"path\":\"Папка/Заметка {n}.md\"}},\"id\":\"{note}\",\"props\":{{\"Статус {}\":{{\"icon\":\"📌\",\"settings\":\"Идея,В работе,Готово\"}}}}}}",
            n % 7
        );
        files
            .entry(amby_sync_core::engine::props_groups::group_of(&note))
            .or_default()
            .push((note, line));
        lines += 1;
    }
    for (x, mut recs) in files {
        recs.sort();
        let mut text = String::from("{\"version\":1}\n");
        for (_, line) in recs {
            text.push_str(&line);
            text.push('\n');
        }
        fx.write(&format!(".amby/properties/prop_{x}.jsonl"), &text);
    }
    lines
}

fn measure(every: u32, label: &str) {
    let fx = fx();
    let lines = fill_groups(&fx, 1_000_000, every);
    let sizes: Vec<usize> = fx
        .files_under(".amby/properties/")
        .iter()
        .filter(|p| p.ends_with(".jsonl"))
        .map(|p| fx.bytes(p).unwrap().len())
        .collect();
    let (total, biggest) = (
        sizes.iter().sum::<usize>(),
        sizes.iter().max().copied().unwrap(),
    );
    println!(
        "scale {label} lines={lines} files={} total={total} biggest={biggest}",
        sizes.len()
    );
    assert!(
        biggest < 16_000_000,
        "the limit of the merge (З30) is never near"
    );

    let note = "01JD0000000000000000000000".to_string();
    fx.note(&note, "N.md", "Статус 0: x\n");
    let started = Instant::now();
    set_appearance(&fx.conn, &fx.vault, &note, "Статус 0", "🔥", "").ok();
    println!("scale {label} one-edit={:?}", started.elapsed());

    let started = Instant::now();
    rebuild_cache(&fx.conn, &fx.vault).ok();
    println!("scale {label} rebuild-cache={:?}", started.elapsed());

    let started = Instant::now();
    let report = migration::preview(&fx.conn, &fx.vault);
    println!(
        "scale {label} migration-report={:?} ok={}",
        started.elapsed(),
        report.is_ok()
    );
}

#[test]
#[ignore = "measurement, minutes of work: run by hand (З56)"]
fn one_million_notes_with_differences_in_five_per_cent() {
    // З56: a line is 100–150 bytes; a file ≈ 0.3 MB, all files ≈ 5 MB
    measure(20, "5%");
}

#[test]
#[ignore = "measurement, minutes of work: run by hand (З56)"]
fn one_million_notes_with_differences_in_thirty_per_cent() {
    // З56: the extreme case, a file ≈ 2 MB
    measure(3, "30%");
}

/// A vault before the migration: `notes` notes, each with three properties in `properties.json`
/// (version 1); one in ten lacks the key of one property in its header, so the migration writes
/// into that note (З20). Returns the size of `properties.json`.
fn fill_old_vault(fx: &Fx, notes: u32) -> usize {
    let mut map = serde_json::Map::new();
    for n in 0..notes {
        let note = format!("01JD{n:022}");
        let folder = n % 50;
        let rel = format!("Папка {folder}/Заметка {n}.md");
        let header = if n % 10 == 0 {
            "Статус: Идея\nЗаказчик: Иван\n".to_string()
        } else {
            "Статус: Идея\nЗаказчик: Иван\nСрок: 2026-11-06\n".to_string()
        };
        fx.note(&note, &rel, &header);
        let prop = |id: &str, name: &str, ty: &str, value: &str, settings: &str, icon: &str| {
            serde_json::json!({"id": id, "name": name, "icon": icon, "propertyType": ty,
                "value": value, "settings": settings})
        };
        map.insert(
            note,
            serde_json::json!([
                prop(
                    "p1",
                    "Статус",
                    "select",
                    "Идея",
                    "Идея,В работе,Готово",
                    "📌"
                ),
                prop("p2", "Заказчик", "text", "Иван", "", ""),
                prop("p3", "Срок", "date", "2026-11-06", "", "📅"),
            ]),
        );
    }
    let text =
        serde_json::to_string_pretty(&serde_json::json!({"version": 1, "notes": map})).unwrap();
    fx.write(".amby/properties.json", &format!("{text}\n"));
    text.len()
}

fn measure_migration(notes: u32) {
    let fx = fx_old();
    let size = fill_old_vault(&fx, notes);
    let started = Instant::now();
    let report = migration::preview(&fx.conn, &fx.vault).unwrap();
    println!(
        "migration notes={notes} properties.json={size} preview={:?} report.notes={}",
        started.elapsed(),
        report.notes
    );
    let started = Instant::now();
    let outcome = migration::open_vault(&fx.conn, &fx.vault, &migration::Context::default());
    let took = started.elapsed();
    let groups: usize = fx
        .files_under(".amby/properties/")
        .iter()
        .filter(|p| p.ends_with(".jsonl"))
        .map(|p| fx.bytes(p).unwrap().len())
        .sum();
    println!(
        "migration notes={notes} open-vault={took:?} ok={} groups-bytes={groups}",
        outcome.is_ok()
    );
    assert!(matches!(outcome, Ok(migration::OpenOutcome::Migrated(_))));
    assert_eq!(
        storage_mode(&fx.vault).unwrap(),
        StorageMode::Groups,
        "the vault is in the new format after one opening"
    );
}

#[test]
#[ignore = "measurement, minutes of work: run by hand (З68)"]
fn migration_of_ten_thousand_notes() {
    // З68: the migration runs by itself at the first opening (З57); how long the person waits
    measure_migration(10_000);
}

#[test]
#[ignore = "measurement, minutes of work: run by hand (З68)"]
fn migration_of_fifty_thousand_notes() {
    // З68: a large vault
    measure_migration(50_000);
}
