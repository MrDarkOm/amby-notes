//! Cleanup (П37): bodies without a commit after 24 hours (П25), old versions and deleted items
//! after 30 days (П35, П36), expired enrolment codes and old attempt counters.
//!
//! Everything is decided from the clock of the state and from what is already past its time, so a
//! run is idempotent and a second run right after the first removes nothing. The database changes
//! are one transaction; the files of removed bodies go after it, so a crash in between leaves a
//! file nobody refers to (the next run sweeps it), never a version that refers to a missing file.

use std::collections::HashSet;

use rusqlite::{params, Transaction};

use crate::state::AppState;
use crate::store::{BlobKey, BlobStore};

/// What one cleanup removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MaintenanceReport {
    /// Bodies deleted because no commit refers to them (П25).
    pub orphan_blobs: u64,
    /// Versions deleted by age (П35).
    pub versions: u64,
    /// Whole items deleted after their deletion aged out (П36).
    pub items: u64,
}

/// Why a cleanup failed.
#[derive(Debug, thiserror::Error)]
pub enum MaintenanceError {
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl From<rusqlite::Error> for MaintenanceError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Other(error.to_string())
    }
}

impl From<crate::store::StoreError> for MaintenanceError {
    fn from(error: crate::store::StoreError) -> Self {
        Self::Other(error.to_string())
    }
}

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// An expired enrolment code is kept this long, so that "right code, too late" stays a
/// different answer from "wrong code" for a while (П17).
const EXPIRED_CODE_GRACE_MS: i64 = 7 * DAY_MS;

fn scaled(count: u64, unit: i64) -> i64 {
    i64::try_from(count)
        .unwrap_or(i64::MAX)
        .saturating_mul(unit)
}

/// One cleanup (П37): idempotent, touches only what is already past its time, reads the time
/// from the clock of `state` only.
pub fn run(state: &AppState) -> Result<MaintenanceReport, MaintenanceError> {
    let now = state.clock.now_ms();
    let config = &state.config;
    let version_ms = scaled(config.retain_version_days, DAY_MS);
    let orphan_ms = scaled(config.orphan_blob_hours, HOUR_MS);
    let attempts_ms = scaled(
        config
            .login_window_secs
            .max(config.login_window_per_user_secs),
        1000,
    );

    let mut report = MaintenanceReport::default();
    let mut doomed: Vec<BlobKey> = Vec::new();
    state.db.write(|tx| -> Result<(), MaintenanceError> {
        let mut freed: Vec<(i64, Vec<u8>)> = Vec::new();

        // П36: an item whose last version is a deletion older than the retention goes whole.
        let mut statement = tx.prepare(
            "SELECT space, item_id, seq FROM versions \
             WHERE superseded_ms IS NULL AND deleted = 1 AND committed_ms <= ?1",
        )?;
        let gone: Vec<(i64, Vec<u8>, i64)> = statement
            .query_map([now.saturating_sub(version_ms)], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        drop(statement);
        for (space, item, seq) in gone {
            collect_blobs(
                tx,
                "space = ?1 AND item_id = ?2",
                params![space, item],
                &mut freed,
            )?;
            tx.execute(
                "DELETE FROM versions WHERE space = ?1 AND item_id = ?2",
                params![space, item],
            )?;
            tx.execute(
                "UPDATE spaces SET purged_seq = MAX(purged_seq, ?2) WHERE id = ?1",
                params![space, seq],
            )?;
            report.items += 1;
        }

        // П35: an old version lives `retain_version_days` after it was replaced. The feed never
        // showed it, so nothing in the feed and no `purged_seq` changes.
        collect_blobs(
            tx,
            "superseded_ms IS NOT NULL AND superseded_ms <= ?1",
            [now.saturating_sub(version_ms)],
            &mut freed,
        )?;
        report.versions += tx.execute(
            "DELETE FROM versions WHERE superseded_ms IS NOT NULL AND superseded_ms <= ?1",
            [now.saturating_sub(version_ms)],
        )? as u64;

        // A body that lost its last live version goes with it (П35, П36) …
        freed.sort_unstable();
        freed.dedup();
        for (space, blob) in freed {
            if unreferenced(tx, space, &blob)? {
                if let Some(key) = remove_blob_row(tx, space, &blob)? {
                    doomed.push(key);
                }
            }
        }
        // … and a body nobody committed goes `orphan_blob_hours` after its last action (П25).
        let mut statement = tx.prepare(
            "SELECT b.space, b.blob_id FROM blobs b WHERE b.activity_ms <= ?1 AND NOT EXISTS \
             (SELECT 1 FROM versions v WHERE v.space = b.space AND v.blob_id = b.blob_id)",
        )?;
        let orphans: Vec<(i64, Vec<u8>)> = statement
            .query_map([now.saturating_sub(orphan_ms)], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?
            .collect::<Result<_, _>>()?;
        drop(statement);
        for (space, blob) in orphans {
            if let Some(key) = remove_blob_row(tx, space, &blob)? {
                doomed.push(key);
                report.orphan_blobs += 1;
            }
        }

        // П17, П16: spent codes and old counters.
        tx.execute(
            "UPDATE users SET enroll_hash = NULL, enroll_expires_ms = NULL \
             WHERE enroll_expires_ms IS NOT NULL AND enroll_expires_ms <= ?1",
            [now.saturating_sub(EXPIRED_CODE_GRACE_MS)],
        )?;
        tx.execute(
            "DELETE FROM login_failures WHERE at_ms <= ?1",
            [now.saturating_sub(attempts_ms)],
        )?;
        // П28: the memory of old commits is as long as the history it belongs to.
        tx.execute(
            "DELETE FROM commits WHERE committed_ms <= ?1",
            [now.saturating_sub(version_ms)],
        )?;
        Ok(())
    })?;

    for key in &doomed {
        state.files.delete(key)?;
    }
    sweep_leftovers(state)?;
    Ok(report)
}

/// Remembers the bodies that the versions chosen by `filter` refer to.
fn collect_blobs(
    tx: &Transaction<'_>,
    filter: &str,
    args: impl rusqlite::Params,
    out: &mut Vec<(i64, Vec<u8>)>,
) -> rusqlite::Result<()> {
    let mut statement = tx.prepare(&format!(
        "SELECT DISTINCT space, blob_id FROM versions WHERE blob_id IS NOT NULL AND {filter}"
    ))?;
    let rows = statement.query_map(args, |row| Ok((row.get(0)?, row.get(1)?)))?;
    for row in rows {
        out.push(row?);
    }
    Ok(())
}

fn unreferenced(tx: &Transaction<'_>, space: i64, blob: &[u8]) -> rusqlite::Result<bool> {
    let used: bool = tx.query_row(
        "SELECT EXISTS (SELECT 1 FROM versions WHERE space = ?1 AND blob_id = ?2)",
        params![space, blob],
        |row| row.get(0),
    )?;
    Ok(!used)
}

/// Deletes the row of a body and returns where its files are.
fn remove_blob_row(
    tx: &Transaction<'_>,
    space: i64,
    blob: &[u8],
) -> rusqlite::Result<Option<BlobKey>> {
    let space_id: Vec<u8> = tx.query_row(
        "SELECT space_id FROM spaces WHERE id = ?1",
        [space],
        |row| row.get(0),
    )?;
    let removed = tx.execute(
        "DELETE FROM blobs WHERE space = ?1 AND blob_id = ?2",
        params![space, blob],
    )?;
    if removed == 0 {
        return Ok(None);
    }
    Ok(match (space_id.try_into(), blob.to_vec().try_into()) {
        (Ok(space_id), Ok(blob_id)) => Some(BlobKey { space_id, blob_id }),
        _ => None,
    })
}

/// Removes body directories that no row refers to: what a crash between "row deleted" and
/// "files deleted" leaves behind. The directories are listed first and the rows read after, so a
/// body started in between is never taken for a leftover (its row is written before its files).
fn sweep_leftovers(state: &AppState) -> Result<(), MaintenanceError> {
    let on_disk = state.files.all_keys()?;
    if on_disk.is_empty() {
        return Ok(());
    }
    let known: HashSet<BlobKey> = state.db.call(|conn| -> rusqlite::Result<_> {
        let mut statement = conn
            .prepare("SELECT s.space_id, b.blob_id FROM blobs b JOIN spaces s ON s.id = b.space")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        let mut keys = HashSet::new();
        for row in rows {
            let (space, blob) = row?;
            if let (Ok(space_id), Ok(blob_id)) = (space.try_into(), blob.try_into()) {
                keys.insert(BlobKey { space_id, blob_id });
            }
        }
        Ok(keys)
    })?;
    for key in on_disk {
        if !known.contains(&key) {
            state.files.delete(&key)?;
        }
    }
    Ok(())
}
