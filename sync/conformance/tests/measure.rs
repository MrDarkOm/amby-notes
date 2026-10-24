//! Measurements that must not block the build (appendix Е, Е.10-7). Run them with
//! `npm run sync:plans:measure`; plain `cargo test` skips them.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};

use amby_sync_conformance::client::{enroll, new_body, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Target};

#[test]
#[ignore = "measurement: run with `npm run sync:plans:measure`"]
fn measure_the_quota_check_with_100_000_versions_takes_at_most_50_ms() {
    // Е.10-7: if this fails, the counters per space and the command `quota recount` are needed.
    let target = Target::in_process_with(|config| config.quota_bytes_per_user = Some(1 << 50));
    let control = in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    control.sql_write(|conn| {
        let space: i64 = conn.query_row("SELECT id FROM spaces LIMIT 1", [], |r| r.get(0)).unwrap();
        conn.execute_batch("BEGIN").unwrap();
        conn.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000) \
             INSERT INTO blobs (space, blob_id, size, complete, created_ms, activity_ms) \
             SELECT ?1, randomblob(16), 1000, 1, 1, 1 FROM n",
            [space],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO versions (space, item_id, version, seq, ord, header, blob_id, deleted, \
             device_id, committed_ms, superseded_ms) \
             SELECT space, randomblob(16), 1, ROW_NUMBER() OVER (ORDER BY blob_id), 0, x'00', blob_id, 0, x'00', 1, NULL \
             FROM blobs WHERE space = ?1",
            [space],
        )
        .unwrap();
        conn.execute_batch("COMMIT").unwrap();
    });
    let mut slowest = Duration::ZERO;
    for _ in 0..5 {
        let started = Instant::now();
        space.init_blob(&new_body(), 1000).expect(201);
        slowest = slowest.max(started.elapsed());
    }
    assert!(
        slowest <= Duration::from_millis(50),
        "the quota check took {slowest:?} with 100 000 versions"
    );
}
