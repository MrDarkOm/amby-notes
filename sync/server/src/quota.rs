//! What a user keeps on the server and what they may keep (appendix Е: П54, П55, П61).
//!
//! Sizes are the sealed (encrypted) sizes the server stores. Three kinds, counted per body, a
//! body being the pair `(space, blob_id)` so equal ids of different spaces or users never merge:
//! *live* (the latest, not deleted version of some item refers to it), *pending* (no version
//! refers to it: started or complete but not committed, by the declared size) and *history*
//! (only replaced versions or deleted items refer to it). Live and pending count against the
//! quota; history is shown apart (П55).

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::plans::{EffectiveLimits, Plan};
use crate::state::AppState;

/// The bytes of a user (or of one space).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Usage {
    pub(crate) live: u64,
    pub(crate) pending: u64,
    pub(crate) history: u64,
}

impl Usage {
    /// What counts against the quota (П55).
    pub(crate) fn counted(&self) -> u64 {
        self.live.saturating_add(self.pending)
    }

    fn add(&mut self, other: &Usage) {
        self.live += other.live;
        self.pending += other.pending;
        self.history += other.history;
    }
}

/// The cutoff for "pending": a body nobody committed lives `orphan_blob_hours` after its last
/// action (П25), so only a body that was touched after the cutoff can be waiting for its commit.
/// A body older than that which no version refers to is a leftover the next cleanup removes; it is
/// counted as live until then (the safe side for the quota), and the check stays one scan of the
/// bodies plus a probe for the few recent ones.
pub(crate) fn pending_cutoff(state: &AppState) -> i64 {
    let hours = i64::try_from(state.config.orphan_blob_hours).unwrap_or(i64::MAX / 3_600_000);
    state
        .clock
        .now_ms()
        .saturating_sub(hours.saturating_mul(3_600_000))
}

/// The usage per space (by space row) of a user, from queries over the indexes, no counters
/// (Е.10-7): the sum of all bodies, minus the history (bodies only replaced versions refer to,
/// found from the replaced versions), minus the pending ones (recent bodies no version refers
/// to) leaves the live bytes.
pub(crate) fn space_usage(
    conn: &Connection,
    user_id: i64,
    pending_after_ms: i64,
) -> rusqlite::Result<HashMap<i64, Usage>> {
    let mut spaces: HashMap<i64, Usage> = HashMap::new();
    let mut totals = conn.prepare(
        "SELECT b.space, COALESCE(SUM(b.size), 0), \
                COALESCE(SUM(CASE WHEN b.activity_ms > ?2 AND NOT EXISTS ( \
                    SELECT 1 FROM versions v INDEXED BY versions_blob \
                    WHERE v.space = b.space AND v.blob_id = b.blob_id) THEN b.size END), 0) \
         FROM blobs b WHERE b.space IN (SELECT id FROM spaces WHERE user_id = ?1) \
         GROUP BY b.space",
    )?;
    let rows = totals.query_map(params![user_id, pending_after_ms], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, u64>(1)?,
            row.get::<_, u64>(2)?,
        ))
    })?;
    for row in rows {
        let (space, total, pending) = row?;
        spaces.insert(
            space,
            Usage {
                live: total.saturating_sub(pending),
                pending,
                history: 0,
            },
        );
    }
    let mut history = conn.prepare(
        "SELECT b.space, COALESCE(SUM(b.size), 0) FROM ( \
             SELECT DISTINCT v.space AS space, v.blob_id AS blob_id \
             FROM versions v INDEXED BY versions_superseded \
             JOIN spaces s ON s.id = v.space \
             WHERE v.superseded_ms IS NOT NULL AND v.blob_id IS NOT NULL AND s.user_id = ?1) c \
         JOIN blobs b ON b.space = c.space AND b.blob_id = c.blob_id \
         WHERE NOT EXISTS (SELECT 1 FROM versions l INDEXED BY versions_blob \
             WHERE l.space = c.space AND l.blob_id = c.blob_id \
               AND l.superseded_ms IS NULL AND l.deleted = 0) \
         GROUP BY b.space",
    )?;
    let rows = history.query_map([user_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, u64>(1)?))
    })?;
    for row in rows {
        let (space, bytes) = row?;
        if let Some(usage) = spaces.get_mut(&space) {
            usage.history = bytes;
            usage.live = usage.live.saturating_sub(bytes);
        }
    }
    Ok(spaces)
}

/// The usage of all spaces of a user together.
pub(crate) fn user_usage(
    conn: &Connection,
    user_id: i64,
    pending_after_ms: i64,
) -> rusqlite::Result<Usage> {
    let mut sum = Usage::default();
    for usage in space_usage(conn, user_id, pending_after_ms)?.values() {
        sum.add(usage);
    }
    Ok(sum)
}

/// The plan of a user and the limits that follow from it (П52, П54).
#[derive(Debug, Clone)]
pub(crate) struct Resolved {
    pub(crate) name: Option<String>,
    pub(crate) title: Option<String>,
    /// A pin that acts: `false` for no pin and for one that has expired (Н2).
    pub(crate) pinned: bool,
    /// The end of the pin that acts (Н6); `None` for no end, no pin or an expired pin.
    pub(crate) until_ms: Option<i64>,
    pub(crate) limits: EffectiveLimits,
    /// Whether the effective `max_file_bytes` is the server ceiling and not the plan's number.
    pub(crate) file_limit_from_server: bool,
}

impl Resolved {
    /// The source named in the `413` answer (П59).
    pub(crate) fn file_source(&self) -> &'static str {
        if self.file_limit_from_server {
            "server"
        } else {
            "plan"
        }
    }
}

/// The plan stored for a user (`users.plan`, empty is "by default"). Read on every request, so a
/// change by the administrator applies at once (П53).
pub(crate) fn pinned_plan(conn: &Connection, user_id: i64) -> rusqlite::Result<Option<String>> {
    Ok(conn
        .query_row("SELECT plan FROM users WHERE id = ?1", [user_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .optional()?
        .flatten())
}

/// The stored pin of a user: the plan name and the end of the pin (`users.plan_until_ms`, Н2).
pub(crate) fn pin_of(
    conn: &Connection,
    user_id: i64,
) -> rusqlite::Result<(Option<String>, Option<i64>)> {
    Ok(conn
        .query_row(
            "SELECT plan, plan_until_ms FROM users WHERE id = ?1",
            [user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or((None, None)))
}

/// Works out the plan and the effective limits of `user_id`. A pin whose end has come
/// (`now_ms >= plan_until_ms`) does not act: the default plan does (Н2).
pub(crate) fn resolve_user(
    state: &AppState,
    conn: &Connection,
    user_id: i64,
) -> rusqlite::Result<Resolved> {
    let (pinned, until) = pin_of(conn, user_id)?;
    Ok(resolve_plan(state, pinned.as_deref(), until))
}

/// Whether a pin ended at `until_ms` has expired now (Н2). A pin without a plan has no end.
pub(crate) fn pin_expired(state: &AppState, pinned: Option<&str>, until_ms: Option<i64>) -> bool {
    pinned.is_some() && until_ms.is_some_and(|end| state.clock.now_ms() >= end)
}

/// The same for a stored plan name and end.
pub(crate) fn resolve_plan(
    state: &AppState,
    pinned: Option<&str>,
    until_ms: Option<i64>,
) -> Resolved {
    let (pinned, until_ms) = if pin_expired(state, pinned, until_ms) {
        (None, None)
    } else {
        (pinned, if pinned.is_some() { until_ms } else { None })
    };
    let found = state.plans.resolve(pinned);
    let plan: Option<&Plan> = found.map(|(_, plan)| plan);
    let limits = EffectiveLimits::for_plan(plan, &state.config);
    let from_server = plan
        .and_then(|plan| plan.max_file_bytes)
        .is_none_or(|number| number > state.config.max_blob_bytes);
    Resolved {
        name: found.map(|(name, _)| name.to_string()),
        title: plan.and_then(|plan| plan.title.clone()),
        pinned: pinned.is_some(),
        until_ms,
        limits,
        file_limit_from_server: from_server,
    }
}

/// Н4, Н5: the `403 subscription_required` of a user whose effective plan does not allow
/// sending; `Ok` otherwise. Call it inside the transaction of the write it guards.
pub(crate) fn require_subscription(
    state: &AppState,
    conn: &Connection,
    user_id: i64,
) -> Result<(), crate::http::util::ApiError> {
    if resolve_user(state, conn, user_id)?.limits.sync {
        Ok(())
    } else {
        Err(subscription_required())
    }
}

/// Х1: `507 server_storage_full` when the volume of the data directory has less than
/// `min_free_bytes` free; `Ok` when the check is off, the space is enough or it cannot be read.
/// Call it inside the transaction of an adding request, after the checks of Н4. The answer is the
/// plain error of П4 and says nothing about the disk.
pub(crate) fn require_free_space(state: &AppState) -> Result<(), crate::http::util::ApiError> {
    let minimum = state.config.min_free_bytes;
    if minimum == 0 {
        return Ok(());
    }
    match free_bytes(&state.config.data_dir) {
        Some(free) if free < minimum => Err(crate::http::util::ApiError::new(
            axum::http::StatusCode::INSUFFICIENT_STORAGE,
            amby_sync_proto::error_code::SERVER_STORAGE_FULL,
            "the server has no room for new data",
        )),
        _ => Ok(()),
    }
}

/// Bytes available to unprivileged writers on the volume of `dir`; `None` when unknown.
#[cfg(unix)]
fn free_bytes(dir: &std::path::Path) -> Option<u64> {
    let stat = rustix::fs::statvfs(dir).ok()?;
    Some(stat.f_bavail.saturating_mul(stat.f_frsize))
}

/// Other systems are not measured: "enough".
#[cfg(not(unix))]
fn free_bytes(_dir: &std::path::Path) -> Option<u64> {
    None
}

/// The error of Н4: an ordinary one, with no details about the plan.
pub(crate) fn subscription_required() -> crate::http::util::ApiError {
    crate::http::util::ApiError::new(
        axum::http::StatusCode::FORBIDDEN,
        amby_sync_proto::error_code::SUBSCRIPTION_REQUIRED,
        "the plan does not allow sending changes",
    )
}

/// The size of the live body of `item` in `space` (the latest, not deleted version), which a
/// replacement would free; `0` when there is none (П56-б). Never trusted beyond the space the
/// caller owns.
pub(crate) fn live_body_of(conn: &Connection, space: i64, item: &[u8]) -> rusqlite::Result<u64> {
    Ok(conn
        .query_row(
            "SELECT b.size FROM versions v JOIN blobs b ON b.space = v.space AND b.blob_id = v.blob_id \
             WHERE v.space = ?1 AND v.item_id = ?2 AND v.superseded_ms IS NULL AND v.deleted = 0",
            params![space, item],
            |row| row.get::<_, u64>(0),
        )
        .optional()?
        .unwrap_or(0))
}
