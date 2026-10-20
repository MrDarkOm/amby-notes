//! Limiting the guesses at a password or a code (П16, Р11).
//!
//! Two counters over the same list of failures: a strict one for the pair "name + client
//! address" and a loose one for the name from all addresses together. Unknown names are counted
//! like real ones, so a `429` never tells whether a name exists.

use rusqlite::{params, Connection};

use crate::config::Config;

/// The name as it is stored in the list: a very long guess is cut, so the table stays small.
fn key(name: &str) -> String {
    name.chars().take(256).collect()
}

/// `Some(seconds)` when the next attempt must be refused: the number of seconds until the
/// oldest failure that keeps the count at the limit ages out of its window.
pub(crate) fn locked_for(
    conn: &Connection,
    config: &Config,
    now_ms: i64,
    name: &str,
    addr: &str,
) -> rusqlite::Result<Option<u64>> {
    let name = key(name);
    let strict = retry_after(
        conn,
        "SELECT at_ms FROM login_failures WHERE name = ?1 AND addr = ?2 AND strict_cleared = 0 \
         AND at_ms > ?3 ORDER BY at_ms DESC LIMIT 1 OFFSET ?4",
        params![
            name,
            addr,
            now_ms - window_ms(config.login_window_secs),
            i64::from(config.login_max_failures) - 1
        ],
        config.login_window_secs,
        now_ms,
    )?;
    let loose = retry_after(
        conn,
        "SELECT at_ms FROM login_failures WHERE name = ?1 AND at_ms > ?2 \
         ORDER BY at_ms DESC LIMIT 1 OFFSET ?3",
        params![
            name,
            now_ms - window_ms(config.login_window_per_user_secs),
            i64::from(config.login_max_failures_per_user) - 1
        ],
        config.login_window_per_user_secs,
        now_ms,
    )?;
    Ok(match (strict, loose) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (one, other) => one.or(other),
    })
}

fn window_ms(secs: u64) -> i64 {
    i64::try_from(secs.saturating_mul(1000)).unwrap_or(i64::MAX)
}

/// The failure at the limit position, if there is one: while it counts, the name is locked.
fn retry_after(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
    window_secs: u64,
    now_ms: i64,
) -> rusqlite::Result<Option<u64>> {
    let mut statement = conn.prepare_cached(sql)?;
    let mut rows = statement.query(args)?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let at_ms: i64 = row.get(0)?;
    let frees_at = at_ms.saturating_add(window_ms(window_secs));
    let left_ms = (frees_at - now_ms).max(1);
    Ok(Some(u64::try_from((left_ms + 999) / 1000).unwrap_or(1)))
}

/// Writes one failure down.
pub(crate) fn record_failure(
    conn: &Connection,
    now_ms: i64,
    name: &str,
    addr: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO login_failures (name, addr, at_ms) VALUES (?1, ?2, ?3)",
        params![key(name), addr, now_ms],
    )?;
    Ok(())
}

/// A success clears the strict count of the pair; the loose count only ages out (П16).
pub(crate) fn clear_pair(conn: &Connection, name: &str, addr: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE login_failures SET strict_cleared = 1 WHERE name = ?1 AND addr = ?2",
        params![key(name), addr],
    )?;
    Ok(())
}
