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
