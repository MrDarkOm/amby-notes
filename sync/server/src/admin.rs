//! Administrator commands (П38, П39): `user add|list|remove` and `backup`.
//!
//! They work on the same data as a running server: the database lock of SQLite keeps the two
//! apart, and the one-time code is shown to the caller only, never written to a log.

use std::fs;
use std::io;
use std::path::Path;

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::db::DB_FILE;
use crate::state::AppState;
use crate::store::{BlobKey, BlobStore, StoreError, UserRecord};

/// Why an administrator command failed. [`AdminError::exit_code`] is the exit code of the
/// command line (П38).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdminError {
    /// The name breaks the rules of П11.
    #[error("invalid user name")]
    InvalidName,
    /// The user already has a password (П17).
    #[error("the user already has a password")]
    HasPassword,
    /// Anything else.
    #[error("{0}")]
    Other(String),
}

impl AdminError {
    /// The exit code of the command line: 2 for a bad name, 3 for a user who has a password,
    /// 1 for the rest (П38).
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::InvalidName => 2,
            Self::HasPassword => 3,
            Self::Other(_) => 1,
        }
    }
}

impl From<StoreError> for AdminError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::HasPassword => Self::HasPassword,
            StoreError::NotFound => Self::Other("no such user".into()),
            StoreError::Io(message) => Self::Other(message),
        }
    }
}

/// The result of `user add` (П38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAdded {
    /// The user name.
    pub username: String,
    /// The one-time code, shown once (П17). Never written to a log (П39).
    pub enroll_code: String,
    /// When the code expires.
    pub expires_ms: i64,
}

/// The valid names of П11: ASCII `a-z 0-9 . _ -`, 1 to 64 characters, a letter or a digit at
/// both ends.
pub(crate) fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    let edge = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    let inner = |byte: u8| edge(byte) || matches!(byte, b'.' | b'_' | b'-');
    (1..=64).contains(&bytes.len())
        && edge(bytes[0])
        && edge(bytes[bytes.len() - 1])
        && bytes.iter().copied().all(inner)
}

/// The code as a person types it: upper case, without dashes and spaces (П17).
pub(crate) fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| !matches!(c, '-' | ' ' | '\t'))
        .flat_map(char::to_uppercase)
        .collect()
}

/// The Crockford base32 alphabet of Ф27 (no `I`, `L`, `O`, `U`).
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A fresh code: 20 symbols of 5 random bits, 100 bits in all, shown in groups of four (П17).
fn new_code() -> Result<String, AdminError> {
    let mut random = [0u8; 20];
    getrandom::fill(&mut random).map_err(|error| AdminError::Other(error.to_string()))?;
    let symbols: Vec<char> = random
        .iter()
        // 256 is a multiple of 32, so taking five bits adds no bias.
        .map(|byte| char::from(ALPHABET[usize::from(byte & 31)]))
        .collect();
    Ok(symbols
        .chunks(4)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-"))
}

/// `user add <name>` (П38, П17): creates the user and a code valid for `enroll_code_hours`
/// hours (24 by default); for a name without a password it issues a new code and burns the old
/// one.
pub fn user_add(state: &AppState, username: &str) -> Result<UserAdded, AdminError> {
    if !valid_username(username) {
        return Err(AdminError::InvalidName);
    }
    let code = new_code()?;
    let hours = i64::try_from(state.config.enroll_code_hours).unwrap_or(i64::MAX / 3_600_000);
    let expires_ms = state
        .clock
        .now_ms()
        .saturating_add(hours.saturating_mul(3_600_000));
    let hash: [u8; 32] = Sha256::digest(normalize_code(&code).as_bytes()).into();
    state.users.add_user(username, hash, expires_ms)?;
    Ok(UserAdded {
        username: username.to_string(),
        enroll_code: code,
        expires_ms,
    })
}

/// `user list` (П38).
pub fn user_list(state: &AppState) -> Result<Vec<UserRecord>, AdminError> {
    Ok(state.users.list_users()?)
}

/// `user remove <name> --yes` (П38): removes the user, devices, spaces and bodies for good.
pub fn user_remove(state: &AppState, username: &str) -> Result<(), AdminError> {
    Ok(state.users.remove_user(username)?)
}

/// `backup <dir>` (П38, Р11): an online copy of the database and of the bodies.
///
/// The bodies are copied first and the database snapshot is taken after, then every body the
/// snapshot refers to is checked in the copy; if the cleanup removed one in between, the copy
/// is taken again. The copy is therefore never a database that points to a missing body.
pub fn backup(state: &AppState, target: &Path) -> Result<(), AdminError> {
    let other = |error: &dyn std::fmt::Display| AdminError::Other(error.to_string());
    fs::create_dir_all(target).map_err(|error| other(&error))?;
    let final_db = target.join(DB_FILE);
    if final_db.exists() {
        return Err(AdminError::Other(format!(
            "{} already holds a backup; use an empty directory",
            target.display()
        )));
    }
    let source_blobs = state.config.data_dir.join("blobs");
    let target_blobs = target.join("blobs");
    let partial = target.join(format!("{DB_FILE}.partial"));
    for _attempt in 0..3 {
        copy_tree(&source_blobs, &target_blobs).map_err(|error| other(&error))?;
        let _ = fs::remove_file(&partial);
        let partial_text = partial.to_string_lossy().into_owned();
        state
            .db
            .call(|conn| conn.execute("VACUUM INTO ?1", params![partial_text]))
            .map_err(|error| other(&error))?;
        if snapshot_is_complete(&partial, &target_blobs).map_err(|error| other(&error))? {
            fs::rename(&partial, &final_db).map_err(|error| other(&error))?;
            return Ok(());
        }
    }
    let _ = fs::remove_file(&partial);
    Err(AdminError::Other(
        "the data kept changing during the backup; try again when the server is quiet".into(),
    ))
}

/// Whether the body of every complete blob in the snapshot is in the copy.
fn snapshot_is_complete(snapshot: &Path, blobs: &Path) -> rusqlite::Result<bool> {
    let conn = rusqlite::Connection::open_with_flags(
        snapshot,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut statement = conn.prepare(
        "SELECT s.space_id, b.blob_id FROM blobs b JOIN spaces s ON s.id = b.space \
         WHERE b.complete = 1",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (space, blob) = row?;
        let (Ok(space_id), Ok(blob_id)) = (space.try_into(), blob.try_into()) else {
            return Ok(false);
        };
        let key = BlobKey { space_id, blob_id };
        if !blobs.join(crate::store::relative_body_path(&key)).exists() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Copies `from` into `to`; a file that is already there with the same size is left alone
/// (bodies never change once complete).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(from) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    fs::create_dir_all(to)?;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".tmp") {
            continue;
        }
        let destination = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            let length = entry.metadata()?.len();
            let same = fs::metadata(&destination).is_ok_and(|have| have.len() == length);
            if !same {
                // A file removed by the cleanup while we copy is not an error.
                match fs::copy(entry.path(), &destination) {
                    Ok(_) => fs::File::open(&destination)?.sync_all()?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(())
}

/// What an administrator command printed and the exit code it ended with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    /// The exit code of the command line (П38, П53): 0 success, 2 an unknown plan or a bad name,
    /// 1 anything else.
    pub code: i32,
    /// What the command prints on its standard output (`--json` gives one JSON document).
    pub stdout: String,
    /// The audit line and the errors (П53): names and plans, never a code, a token or a key.
    pub stderr: String,
}

impl CliOutput {
    fn ok(stdout: String) -> Self {
        Self {
            code: 0,
            stdout,
            stderr: String::new(),
        }
    }

    fn fail(code: i32, message: impl std::fmt::Display) -> Self {
        Self {
            code,
            stdout: String::new(),
            stderr: format!("{message}\n"),
        }
    }
}

impl From<AdminError> for CliOutput {
    fn from(error: AdminError) -> Self {
        Self::fail(error.exit_code(), error)
    }
}

impl From<rusqlite::Error> for CliOutput {
    fn from(error: rusqlite::Error) -> Self {
        Self::fail(1, error)
    }
}

/// The words and flags of one command line.
struct Words<'a> {
    words: Vec<&'a str>,
    json: bool,
    yes: bool,
    default: bool,
    plan: Option<&'a str>,
}

fn split_words<'a>(args: &[&'a str]) -> Result<Words<'a>, CliOutput> {
    let mut parsed = Words {
        words: Vec::new(),
        json: false,
        yes: false,
        default: false,
        plan: None,
    };
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        match arg {
            "--json" => parsed.json = true,
            "--yes" => parsed.yes = true,
            "--default" => parsed.default = true,
            "--plan" => {
                parsed.plan = Some(
                    args.next()
                        .ok_or_else(|| CliOutput::fail(2, "--plan needs a plan name"))?,
                );
            }
            flag if flag.starts_with("--") => {
                return Err(CliOutput::fail(2, format!("unknown option {flag}")));
            }
            word => parsed.words.push(word),
        }
    }
    Ok(parsed)
}

/// Whether `run_cli` handles this command line (the others are in `main.rs`).
pub fn is_cli_command(args: &[&str]) -> bool {
    let words: Vec<&str> = args
        .iter()
        .copied()
        .filter(|arg| !arg.starts_with("--"))
        .collect();
    matches!(
        words.as_slice(),
        ["plans", ..]
            | ["space", ..]
            | ["user", "plan", ..]
            | ["user", "add", _]
            | ["user", "list"]
    )
}

/// Runs the commands of appendix Е (П53) on a running state, as the command line does: `user add
/// <name> [--plan <plan>] [--json]`, `user list [--json]`, `user plan set <name> <plan>|--default`,
/// `user plan show <name> [--json]`, `plans list [--json]`, `plans check [<file>]`, `space list
/// <name> [--json]`, `space remove <name> <space_id> --yes`. `main.rs` hands these to it; the
/// suite calls it for a server in its own process.
pub fn run_cli(state: &AppState, args: &[&str]) -> CliOutput {
    let parsed = match split_words(args) {
        Ok(parsed) => parsed,
        Err(output) => return output,
    };
    let outcome = match parsed.words.as_slice() {
        ["user", "add", name] => cli_user_add(state, name, &parsed),
        ["user", "list"] => cli_user_list(state, &parsed),
        ["user", "plan", "set", name, plan] => cli_plan_set(state, name, Some(plan)),
        ["user", "plan", "set", name] if parsed.default => cli_plan_set(state, name, None),
        ["user", "plan", "show", name] => cli_plan_show(state, name, &parsed),
        ["plans", "list"] => cli_plans_list(state, &parsed),
        ["plans", "check"] => cli_plans_check(state, None),
        ["plans", "check", file] => cli_plans_check(state, Some(Path::new(file))),
        ["space", "list", name] => cli_space_list(state, name, &parsed),
        ["space", "remove", name, space] => cli_space_remove(state, name, space, &parsed),
        _ => Err(CliOutput::fail(
            2,
            "usage: user add <name> [--plan <plan>] | user list | user plan set <name> <plan>|--default | \
             user plan show <name> | plans list | plans check [<file>] | space list <name> | \
             space remove <name> <space_id> --yes",
        )),
    };
    outcome.unwrap_or_else(|output| output)
}

type CliResult = Result<CliOutput, CliOutput>;

fn user_row(state: &AppState, name: &str) -> Result<i64, CliOutput> {
    if !valid_username(name) {
        return Err(AdminError::InvalidName.into());
    }
    state
        .db
        .call(|conn| {
            conn.query_row("SELECT id FROM users WHERE username = ?1", [name], |row| {
                row.get(0)
            })
            .optional()
        })?
        .ok_or_else(|| CliOutput::fail(1, "no such user"))
}

/// A plan the file in force has, by its name; the name rule is checked first (exit 2).
fn known_plan(state: &AppState, plan: &str) -> Result<(), CliOutput> {
    if !crate::plans::valid_plan_name(plan) {
        return Err(CliOutput::fail(2, format!("`{plan}` is not a plan name")));
    }
    if !state.plans.plans.contains_key(plan) {
        return Err(CliOutput::fail(
            2,
            format!("there is no plan `{plan}` in the plans file"),
        ));
    }
    Ok(())
}

fn limits_json(limits: &crate::plans::EffectiveLimits) -> serde_json::Value {
    serde_json::json!({
        "max_spaces": limits.max_spaces,
        "max_total_bytes": limits.max_total_bytes,
        "max_file_bytes": limits.max_file_bytes,
        "history_days": limits.history_days,
        "max_history_bytes": limits.max_history_bytes,
    })
}

fn cli_user_add(state: &AppState, name: &str, parsed: &Words<'_>) -> CliResult {
    if !valid_username(name) {
        return Err(AdminError::InvalidName.into());
    }
    if let Some(plan) = parsed.plan {
        // Nobody is created for an unknown plan.
        known_plan(state, plan)?;
    }
    let added = user_add(state, name)?;
    if let Some(plan) = parsed.plan {
        set_plan(state, name, Some(plan))?;
    }
    let stdout = if parsed.json {
        format!(
            "{}\n",
            serde_json::json!({
                "username": added.username,
                "enroll_code": added.enroll_code,
                "expires_ms": added.expires_ms,
            })
        )
    } else {
        format!(
            "User {}: one-time enrolment code\n  {}\nValid for {} hours; it works once.\n",
            added.username, added.enroll_code, state.config.enroll_code_hours
        )
    };
    Ok(CliOutput::ok(stdout))
}

fn cli_user_list(state: &AppState, parsed: &Words<'_>) -> CliResult {
    let cutoff = crate::quota::pending_cutoff(state);
    let rows = state.db.call(|conn| -> rusqlite::Result<Vec<_>> {
        let mut statement = conn.prepare(
            "SELECT id, username, has_password, enroll_expires_ms, plan FROM users ORDER BY id",
        )?;
        let users = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for user in users {
            let (id, username, has_password, expires, plan) = user?;
            let used = crate::quota::user_usage(conn, id, cutoff)?.counted();
            out.push((username, has_password, expires, plan, used));
        }
        Ok(out)
    })?;
    let mut json = Vec::new();
    let mut text = String::new();
    for (username, has_password, expires, pinned, used) in rows {
        let resolved = crate::quota::resolve_plan(state, pinned.as_deref());
        json.push(serde_json::json!({
            "username": username,
            "has_password": has_password,
            "enroll_expires_ms": expires,
            "plan": resolved.name,
            "pinned": pinned.is_some(),
            "used_bytes": used,
        }));
        let status = if has_password {
            "has a password".to_string()
        } else {
            match expires {
                Some(expires) => format!("waiting for enrolment, code expires at {expires} ms"),
                None => "waiting for a new code".to_string(),
            }
        };
        let plan = resolved.name.as_deref().unwrap_or("-");
        let pin = if pinned.is_some() { " (pinned)" } else { "" };
        text.push_str(&format!(
            "{username}\t{status}\t{plan}{pin}\t{used} bytes\n"
        ));
    }
    Ok(CliOutput::ok(if parsed.json {
        format!("{}\n", serde_json::Value::Array(json))
    } else {
        text
    }))
}

/// Writes the pin of a user and returns the previous one.
fn set_plan(state: &AppState, name: &str, plan: Option<&str>) -> Result<Option<String>, CliOutput> {
    let id = user_row(state, name)?;
    Ok(state.db.write(|tx| -> rusqlite::Result<Option<String>> {
        let before = crate::quota::pinned_plan(tx, id)?;
        tx.execute(
            "UPDATE users SET plan = ?2 WHERE id = ?1",
            params![id, plan],
        )?;
        Ok(before)
    })?)
}

fn cli_plan_set(state: &AppState, name: &str, plan: Option<&str>) -> CliResult {
    if !valid_username(name) {
        return Err(AdminError::InvalidName.into());
    }
    if let Some(plan) = plan {
        known_plan(state, plan)?;
    }
    let before = set_plan(state, name, plan)?;
    let label = |plan: Option<&str>| plan.map_or_else(|| "default".to_string(), str::to_string);
    let line = format!(
        "plan changed: user {name}, from {} to {}\n",
        label(before.as_deref()),
        label(plan)
    );
    Ok(CliOutput {
        code: 0,
        stdout: line.clone(),
        stderr: line,
    })
}

fn cli_plan_show(state: &AppState, name: &str, parsed: &Words<'_>) -> CliResult {
    let cutoff = crate::quota::pending_cutoff(state);
    let id = user_row(state, name)?;
    let (resolved, usage, spaces) = state.db.call(|conn| -> rusqlite::Result<_> {
        let resolved = crate::quota::resolve_user(state, conn, id)?;
        let usage = crate::quota::user_usage(conn, id, cutoff)?;
        let spaces: u64 = conn.query_row(
            "SELECT COUNT(*) FROM spaces WHERE user_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        Ok((resolved, usage, spaces))
    })?;
    let plan = serde_json::json!({
        "name": resolved.name, "title": resolved.title, "pinned": resolved.pinned,
    });
    let usage = serde_json::json!({
        "live_bytes": usage.live, "pending_bytes": usage.pending,
        "history_bytes": usage.history, "spaces": spaces,
    });
    // `limits` are the numbers of the plan as the file has them (null: none), `effective` what
    // applies after the ceilings of the server (П54).
    let own = resolved
        .name
        .as_deref()
        .and_then(|plan| state.plans.plans.get(plan))
        .cloned()
        .unwrap_or_default();
    let limits = serde_json::json!({
        "max_spaces": own.max_spaces,
        "max_total_bytes": own.max_total_bytes,
        "max_file_bytes": own.max_file_bytes,
        "history_days": own.history_days,
        "max_history_bytes": own.max_history_bytes,
    });
    let effective = limits_json(&resolved.limits);
    if parsed.json {
        return Ok(CliOutput::ok(format!(
            "{}\n",
            serde_json::json!({
                "username": name, "plan": plan, "limits": limits,
                "effective": effective, "usage": usage,
            })
        )));
    }
    Ok(CliOutput::ok(format!(
        "user {name}\nplan: {plan}\nlimits: {limits}\neffective: {effective}\nusage: {usage}\n"
    )))
}

fn cli_plans_list(state: &AppState, parsed: &Words<'_>) -> CliResult {
    let pinned = state.pinned_plans()?;
    let total: u64 = state
        .db
        .call(|conn| conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0)))?;
    let unpinned = total.saturating_sub(pinned.len() as u64);
    let mut json = Vec::new();
    let mut text = String::new();
    for (name, plan) in &state.plans.plans {
        let pinned_users = pinned.iter().filter(|(_, have)| have == name).count() as u64;
        let by_default = if state.plans.default_plan.as_deref() == Some(name) {
            unpinned
        } else {
            0
        };
        let users = pinned_users + by_default;
        json.push(serde_json::json!({
            "name": name,
            "title": plan.title,
            "users": users,
            "pinned_users": pinned_users,
            "max_spaces": plan.max_spaces,
            "max_total_bytes": plan.max_total_bytes,
            "max_file_bytes": plan.max_file_bytes,
            "history_days": plan.history_days,
            "max_history_bytes": plan.max_history_bytes,
        }));
        let marker = if state.plans.default_plan.as_deref() == Some(name) {
            " (default)"
        } else {
            ""
        };
        text.push_str(&format!("{name}{marker}\t{users} users\n"));
    }
    Ok(CliOutput::ok(if parsed.json {
        format!(
            "{}\n",
            serde_json::json!({ "default_plan": state.plans.default_plan, "plans": json })
        )
    } else {
        text
    }))
}

fn cli_plans_check(state: &AppState, file: Option<&Path>) -> CliResult {
    let path = file.map_or_else(|| state.config.plans_path(), Path::to_path_buf);
    if file.is_some() && !path.exists() {
        return Err(CliOutput::fail(
            1,
            format!("{}: no such file", path.display()),
        ));
    }
    let plans = crate::plans::PlansFile::load(&path).map_err(|error| CliOutput::fail(1, error))?;
    plans
        .check_pinned(&state.pinned_plans()?)
        .map_err(|error| CliOutput::fail(1, error))?;
    Ok(CliOutput::ok(format!(
        "{}: ok, {} plans\n",
        path.display(),
        plans.plans.len()
    )))
}

fn cli_space_list(state: &AppState, name: &str, parsed: &Words<'_>) -> CliResult {
    let cutoff = crate::quota::pending_cutoff(state);
    let id = user_row(state, name)?;
    let rows = state.db.call(|conn| -> rusqlite::Result<Vec<_>> {
        let sizes = crate::quota::space_usage(conn, id, cutoff)?;
        let mut statement = conn.prepare(
            "SELECT id, space_id, created_ms FROM spaces WHERE user_id = ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (row_id, space_id, created) = row?;
            let usage = sizes.get(&row_id).copied().unwrap_or_default();
            Ok((space_id, created, usage))
        })
        .collect()
    })?;
    let mut json = Vec::new();
    let mut text = String::new();
    for (space_id, created, usage) in rows {
        let hex = hex_text(&space_id);
        json.push(serde_json::json!({
            "space_id": hex, "created_ms": created,
            "live_bytes": usage.live, "history_bytes": usage.history,
        }));
        text.push_str(&format!(
            "{hex}\tcreated {created} ms\tlive {} bytes\thistory {} bytes\n",
            usage.live, usage.history
        ));
    }
    Ok(CliOutput::ok(if parsed.json {
        format!("{}\n", serde_json::Value::Array(json))
    } else {
        text
    }))
}

fn hex_text(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn cli_space_remove(state: &AppState, name: &str, space: &str, parsed: &Words<'_>) -> CliResult {
    if !parsed.yes {
        return Err(CliOutput::fail(
            2,
            "`space remove` deletes the space with all its versions and bodies for good; make a \
             `backup` first and add --yes to confirm",
        ));
    }
    let user = user_row(state, name)?;
    let space_id: [u8; 16] = crate::http::util::unhex_array::<16>(space)
        .ok_or_else(|| CliOutput::fail(1, "no such space"))?;
    // The rows go first and the files after, under the lock (as `user remove`).
    let removed = state.db.write_then(
        |tx| -> Result<Vec<BlobKey>, CliOutput> {
            let row: i64 = tx
                .query_row(
                    "SELECT id FROM spaces WHERE space_id = ?1 AND user_id = ?2",
                    params![space_id.as_slice(), user],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| CliOutput::fail(1, "no such space"))?;
            let keys: Vec<BlobKey> = {
                let mut statement = tx.prepare("SELECT blob_id FROM blobs WHERE space = ?1")?;
                let rows = statement.query_map([row], |row| row.get::<_, Vec<u8>>(0))?;
                rows.filter_map(|blob| blob.ok().and_then(|blob| blob.try_into().ok()))
                    .map(|blob_id| BlobKey { space_id, blob_id })
                    .collect()
            };
            tx.execute("DELETE FROM spaces WHERE id = ?1", [row])?;
            Ok(keys)
        },
        |tx, keys| {
            for key in keys {
                if !crate::maintenance::row_exists(tx, key).map_err(CliOutput::from)? {
                    state
                        .files
                        .delete(key)
                        .map_err(|error| CliOutput::fail(1, error))?;
                }
            }
            Ok(())
        },
    )?;
    let line = format!(
        "space removed: user {name}, space {space}, {} bodies\n",
        removed.len()
    );
    Ok(CliOutput {
        code: 0,
        stdout: line.clone(),
        stderr: line,
    })
}
