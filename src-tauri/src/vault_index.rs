use crate::frontmatter;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use ulid::Ulid;
use walkdir::{DirEntry, WalkDir};

#[derive(Serialize, Clone, Debug, PartialEq, Eq, specta::Type)]
pub struct TreeItem {
    pub id: String,
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub icon: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeItem>>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    pub id: String,
    pub path: String,
    pub title: String,
    pub modified: Option<u64>,
    pub word_count: usize,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub warnings: Vec<String>,
    pub path_to_id: HashMap<String, String>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadVaultResult {
    pub tree: Vec<TreeItem>,
    pub notes: Vec<IndexedNote>,
    pub sync: SyncReport,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub tag: String,
    pub notes: Vec<IndexedNote>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note: IndexedNote,
    pub match_type: String,
    pub snippet: Option<String>,
    pub score: i64,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraphNode {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<bool>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkGraphEdge {
    pub source: String,
    pub target: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<bool>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
pub struct LinkGraph {
    pub nodes: Vec<LinkGraphNode>,
    pub edges: Vec<LinkGraphEdge>,
}

struct ScannedNote {
    path: PathBuf,
    rel_path: String,
    parsed_id: Option<String>,
    body: String,
    mtime: i64,
    size: i64,
    /// Set when the file's mtime+size match the index, so its body was not read
    /// and the existing row can be kept as-is.
    unchanged: bool,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn abs_from_rel(vault: &Path, rel_path: &str) -> PathBuf {
    rel_path
        .split('/')
        .filter(|p| !p.is_empty())
        .fold(vault.to_path_buf(), |acc, part| acc.join(part))
}

fn is_markdown(path: &Path) -> bool {
    path.extension().map_or(false, |ext| ext == "md")
}

fn is_canvas(path: &Path) -> bool {
    path.extension().map_or(false, |ext| ext == "canvas")
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn is_hidden(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|name| name.starts_with('.') && name != ".")
        .unwrap_or(false)
}

fn is_bundle_dir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let name = file_name(dir);
    dir.join(format!("{name}.md")).is_file()
}

fn should_descend(entry: &DirEntry) -> bool {
    if is_hidden(entry) {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    name != ".amby" && name != "assets"
}

fn metadata_stamp(path: &Path) -> Result<(i64, i64), String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok((mtime, meta.len() as i64))
}

fn word_count(content: &str) -> usize {
    content.split_whitespace().count()
}

fn title_for(path: &Path, body: &str) -> String {
    body.lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| file_stem(path))
}

fn extract_tags(content: &str) -> Vec<String> {
    let mut tags = HashSet::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let prev_is_boundary = i == 0 || chars[i - 1].is_whitespace();
        if prev_is_boundary
            && chars[i] == '#'
            && i + 1 < chars.len()
            && chars[i + 1].is_alphabetic()
        {
            let start = i + 1;
            let mut end = start;
            while end < chars.len()
                && (chars[end].is_alphanumeric() || chars[end] == '_' || chars[end] == '-')
            {
                end += 1;
            }
            if end > start {
                tags.insert(chars[start..end].iter().collect::<String>().to_lowercase());
            }
            i = end;
        } else {
            i += 1;
        }
    }
    let mut tags: Vec<_> = tags.into_iter().collect();
    tags.sort();
    tags
}

fn normalize_wiki_target(raw: &str) -> String {
    let without_alias = raw.split('|').next().unwrap_or(raw);
    // A `#heading` or `^block` anchor points within a note, not at a different
    // note, so it must be dropped before matching against note keys.
    let base = without_alias
        .split(|c| c == '#' || c == '^')
        .next()
        .unwrap_or(without_alias);
    base.trim()
        .trim_end_matches(".md")
        .replace('\\', "/")
        .to_lowercase()
}

fn extract_links(content: &str) -> Vec<(String, String, String)> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let raw = &rest[..end];
        let target = normalize_wiki_target(raw);
        if !target.is_empty() {
            let label = raw
                .split('|')
                .nth(1)
                .unwrap_or_else(|| raw.split('|').next().unwrap_or(raw))
                .trim()
                .to_string();
            links.push((raw.to_string(), target, label));
        }
        rest = &rest[end + 2..];
    }
    links
}

fn db_path(vault: &Path) -> PathBuf {
    vault.join(".amby").join("notes.db")
}

pub fn open_connection(vault: &Path) -> Result<Connection, String> {
    let amby_dir = vault.join(".amby");
    fs::create_dir_all(&amby_dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(db_path(vault)).map_err(|e| e.to_string())?;
    // WAL + a busy timeout keep reads and writes from colliding now that heavy
    // commands run concurrently on the blocking thread pool.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
        .map_err(|e| e.to_string())?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            content TEXT NOT NULL,
            word_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tags (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (note_id, tag)
        );
        CREATE TABLE IF NOT EXISTS links (
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            raw TEXT NOT NULL,
            target TEXT NOT NULL,
            label TEXT NOT NULL,
            target_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
        CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);
        CREATE INDEX IF NOT EXISTS idx_links_note ON links(note_id);
        "#,
    )
    .map_err(|e| e.to_string())
}

fn db_snapshot(conn: &Connection) -> Result<(HashMap<String, String>, HashMap<String, String>), String> {
    let mut by_id = HashMap::new();
    let mut by_path = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id, path FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, path) = row.map_err(|e| e.to_string())?;
        by_path.insert(path.clone(), id.clone());
        by_id.insert(id, path);
    }
    Ok((by_id, by_path))
}

/// rel_path -> (note id, mtime, size) for incremental scanning.
fn db_path_stamps(conn: &Connection) -> Result<HashMap<String, (String, i64, i64)>, String> {
    let mut map = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT path, id, mtime, size FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (path, id, mtime, size) = row.map_err(|e| e.to_string())?;
        map.insert(path, (id, mtime, size));
    }
    Ok(map)
}

fn scan_disk(
    vault: &Path,
    prev: &HashMap<String, (String, i64, i64)>,
    warnings: &mut Vec<String>,
) -> Result<Vec<ScannedNote>, String> {
    let mut notes = Vec::new();
    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(should_descend)
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() || !is_markdown(path) || file_name(path) == "Metadata.md" {
            continue;
        }
        let rel_path = path
            .strip_prefix(vault)
            .map(normalize_rel_path)
            .map_err(|e| e.to_string())?;
        let (mtime, size) = metadata_stamp(path)?;

        // Unchanged since last index: skip the expensive read + YAML parse.
        if let Some((id, prev_mtime, prev_size)) = prev.get(&rel_path) {
            if *prev_mtime == mtime && *prev_size == size {
                notes.push(ScannedNote {
                    path: path.to_path_buf(),
                    rel_path,
                    parsed_id: Some(id.clone()),
                    body: String::new(),
                    mtime,
                    size,
                    unchanged: true,
                });
                continue;
            }
        }

        let parsed = match frontmatter::read_markdown(path) {
            Ok(parsed) => parsed,
            Err(err) => {
                warnings.push(format!("Failed to read {}: {err}", path_string(path)));
                continue;
            }
        };
        if parsed.has_frontmatter && !parsed.yaml_is_map {
            warnings.push(format!(
                "Skipped malformed frontmatter in {}",
                path_string(path)
            ));
            continue;
        }
        notes.push(ScannedNote {
            path: path.to_path_buf(),
            rel_path,
            parsed_id: parsed.id,
            body: parsed.body,
            mtime,
            size,
            unchanged: false,
        });
    }
    notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(notes)
}

pub fn sync_vault(conn: &Connection, vault: &Path) -> Result<SyncReport, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let (db_by_id, _db_by_path) = db_snapshot(&conn)?;
    let prev = db_path_stamps(&conn)?;
    let mut warnings = Vec::new();
    let mut notes = scan_disk(vault, &prev, &mut warnings)?;
    notes.sort_by_key(|note| {
        let priority = note
            .parsed_id
            .as_ref()
            .and_then(|id| db_by_id.get(id).map(|path| (path != &note.rel_path) as u8))
            .unwrap_or(1);
        (priority, note.rel_path.clone())
    });

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut seen_ids = HashSet::new();
    let mut seen_paths = HashSet::new();
    let mut inserted = 0;
    let mut updated = 0;
    let mut path_to_id = HashMap::new();

    for mut note in notes {
        // Unchanged files keep their existing row untouched; just mark them seen.
        if note.unchanged {
            if let Some(id) = note.parsed_id.clone() {
                seen_paths.insert(note.rel_path.clone());
                seen_ids.insert(id.clone());
                path_to_id.insert(path_string(&note.path), id);
                continue;
            }
        }

        let mut id = note.parsed_id.clone().unwrap_or_default();
        if id.is_empty() || seen_ids.contains(&id) {
            id = Ulid::generate().to_string();
            let content = fs::read_to_string(&note.path).map_err(|e| e.to_string())?;
            let next = frontmatter::body_with_id(&content, &id)?;
            frontmatter::atomic_write(&note.path, &next)?;
            let parsed = frontmatter::parse_markdown(&next);
            let (mtime, size) = metadata_stamp(&note.path)?;
            note.body = parsed.body;
            note.mtime = mtime;
            note.size = size;
        }

        let existed: Option<String> = tx
            .query_row("SELECT id FROM notes WHERE id = ?1", [&id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if existed.is_some() {
            updated += 1;
        } else {
            inserted += 1;
        }

        let title = title_for(&note.path, &note.body);
        tx.execute(
            r#"
            INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'), strftime('%s','now'))
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                title = excluded.title,
                mtime = excluded.mtime,
                size = excluded.size,
                content = excluded.content,
                word_count = excluded.word_count,
                updated_at = strftime('%s','now')
            "#,
            params![
                id,
                note.rel_path,
                title,
                note.mtime,
                note.size,
                note.body,
                word_count(&note.body) as i64
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute("DELETE FROM tags WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        for tag in extract_tags(&note.body) {
            tx.execute(
                "INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.execute("DELETE FROM links WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        for (raw, target, label) in extract_links(&note.body) {
            tx.execute(
                "INSERT INTO links (note_id, raw, target, label, target_note_id) VALUES (?1, ?2, ?3, ?4, NULL)",
                params![id, raw, target, label],
            )
            .map_err(|e| e.to_string())?;
        }

        seen_paths.insert(note.rel_path.clone());
        seen_ids.insert(id.clone());
        path_to_id.insert(path_string(&note.path), id);
    }

    let before_delete: i64 = tx
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let seen_vec: Vec<String> = seen_ids.into_iter().collect();
    if seen_vec.is_empty() {
        tx.execute("DELETE FROM notes", []).map_err(|e| e.to_string())?;
    } else {
        let placeholders = (0..seen_vec.len()).map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM notes WHERE id NOT IN ({placeholders})");
        tx.execute(&sql, rusqlite::params_from_iter(seen_vec.iter()))
            .map_err(|e| e.to_string())?;
    }
    let after_delete: i64 = tx
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let deleted = before_delete.saturating_sub(after_delete) as usize;

    // Re-resolving every link is only needed when the note set actually changed.
    if inserted > 0 || updated > 0 || deleted > 0 {
        resolve_links(&tx)?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(SyncReport {
        inserted,
        updated,
        deleted,
        warnings,
        path_to_id,
    })
}

/// Map of every resolvable key (lowercased title, path-without-`.md`, basename) to note id.
fn build_note_lookup(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path, title FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut lookup = HashMap::new();
    for row in rows {
        let (id, path, title) = row.map_err(|e| e.to_string())?;
        lookup.insert(title.to_lowercase(), id.clone());
        lookup.insert(path.trim_end_matches(".md").to_lowercase(), id.clone());
        if let Some(name) = path.split('/').last() {
            lookup.insert(name.trim_end_matches(".md").to_lowercase(), id);
        }
    }
    Ok(lookup)
}

/// Resolve `target_note_id` for every link. Clears first so that targets which no
/// longer match (renamed/retitled notes) are dropped — important now that
/// `sync_vault` no longer rewrites the link rows of unchanged notes.
fn resolve_links(conn: &Connection) -> Result<(), String> {
    let lookup = build_note_lookup(conn)?;

    conn.execute("UPDATE links SET target_note_id = NULL", [])
        .map_err(|e| e.to_string())?;

    let mut link_stmt = conn
        .prepare("SELECT rowid, target FROM links")
        .map_err(|e| e.to_string())?;
    let links = link_stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(link_stmt);

    for (rowid, target) in links {
        if let Some(target_id) = lookup.get(&target) {
            conn.execute(
                "UPDATE links SET target_note_id = ?1 WHERE rowid = ?2",
                params![target_id, rowid],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Scoped resolution for a single note after it is saved. Avoids the whole-vault
/// link rewrite on every autosave: only this note's outgoing links and the links
/// that point *at* this note are touched.
fn resolve_links_for_note(conn: &Connection, note_id: &str) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT path, title FROM notes WHERE id = ?1",
            [note_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((path, title)) = row else {
        return Ok(());
    };

    let mut keys = vec![
        title.to_lowercase(),
        path.trim_end_matches(".md").to_lowercase(),
    ];
    if let Some(name) = path.split('/').last() {
        keys.push(name.trim_end_matches(".md").to_lowercase());
    }
    keys.sort();
    keys.dedup();

    // Outgoing: resolve this note's own (freshly re-inserted) links.
    let lookup = build_note_lookup(conn)?;
    let mut stmt = conn
        .prepare("SELECT rowid, target FROM links WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    let outgoing = stmt
        .query_map([note_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (rowid, target) in outgoing {
        let target_id = lookup.get(&target);
        conn.execute(
            "UPDATE links SET target_note_id = ?1 WHERE rowid = ?2",
            params![target_id, rowid],
        )
        .map_err(|e| e.to_string())?;
    }

    // Incoming: drop stale links that pointed here (e.g. after a retitle), then
    // (re)point any link whose target matches this note's current keys.
    let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut bind: Vec<String> = Vec::with_capacity(keys.len() + 1);
    bind.push(note_id.to_string());
    bind.extend(keys.iter().cloned());
    conn.execute(
        &format!(
            "UPDATE links SET target_note_id = NULL WHERE target_note_id = ?1 AND target NOT IN ({placeholders})"
        ),
        rusqlite::params_from_iter(bind.iter()),
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        &format!("UPDATE links SET target_note_id = ?1 WHERE target IN ({placeholders})"),
        rusqlite::params_from_iter(bind.iter()),
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn load_vault(conn: &Connection, vault: &Path) -> Result<LoadVaultResult, String> {
    let sync = sync_vault(conn, vault)?;
    let notes = list_notes(conn, vault)?;
    let tree = build_tree(vault, &notes)?;
    Ok(LoadVaultResult { tree, notes, sync })
}

pub fn list_notes(conn: &Connection, vault: &Path) -> Result<Vec<IndexedNote>, String> {
    let mut stmt = conn
        .prepare("SELECT id, path, title, mtime, word_count FROM notes ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let rel_path: String = row.get(1)?;
            Ok(IndexedNote {
                id: row.get(0)?,
                path: path_string(&abs_from_rel(vault, &rel_path)),
                title: row.get(2)?,
                modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                word_count: row.get::<_, i64>(4)? as usize,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn note_map(notes: &[IndexedNote], vault: &Path) -> HashMap<String, IndexedNote> {
    notes
        .iter()
        .filter_map(|note| {
            let rel = Path::new(&note.path).strip_prefix(vault).ok()?;
            Some((normalize_rel_path(rel), note.clone()))
        })
        .collect()
}

fn read_visible_entries(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            !name.starts_with('.') && name != "assets"
        })
        .collect();
    entries.sort_by_key(|e| {
        let path = e.path();
        let is_file = path.is_file() as u8;
        let name = e.file_name().to_string_lossy().to_lowercase();
        (is_file, name)
    });
    Ok(entries)
}

fn tree_item_for_note(path: &Path, note: &IndexedNote, children: Vec<TreeItem>) -> TreeItem {
    TreeItem {
        id: note.id.clone(),
        path: path_string(path),
        name: file_stem(path),
        item_type: "file".to_string(),
        icon: "file".to_string(),
        children: if children.is_empty() { None } else { Some(children) },
    }
}

fn scan_tree_dir(
    vault: &Path,
    dir: &Path,
    notes: &HashMap<String, IndexedNote>,
    in_bundle: bool,
) -> Result<Vec<TreeItem>, String> {
    let mut items = Vec::new();
    let bundle_main = if in_bundle {
        Some(dir.join(format!("{}.md", file_name(dir))))
    } else {
        None
    };

    for entry in read_visible_entries(dir)? {
        let path = entry.path();
        let raw_name = entry.file_name().to_string_lossy().to_string();
        if Some(path.as_path()) == bundle_main.as_deref() || raw_name == "Metadata.md" {
            continue;
        }
        if path.is_dir() {
            if is_bundle_dir(&path) {
                let main = path.join(format!("{}.md", file_name(&path)));
                let rel = main
                    .strip_prefix(vault)
                    .map(normalize_rel_path)
                    .map_err(|e| e.to_string())?;
                if let Some(note) = notes.get(&rel) {
                    let children = scan_tree_dir(vault, &path, notes, true)?;
                    items.push(tree_item_for_note(&main, note, children));
                }
            } else {
                let children = scan_tree_dir(vault, &path, notes, false)?;
                items.push(TreeItem {
                    id: format!("folder:{}", path_string(&path)),
                    path: path_string(&path),
                    name: raw_name,
                    item_type: "folder".to_string(),
                    icon: "folder".to_string(),
                    children: Some(children),
                });
            }
        } else if is_markdown(&path) {
            let rel = path
                .strip_prefix(vault)
                .map(normalize_rel_path)
                .map_err(|e| e.to_string())?;
            if let Some(note) = notes.get(&rel) {
                items.push(tree_item_for_note(&path, note, Vec::new()));
            }
        } else if is_canvas(&path) {
            // Hide a note's canvas layer sidecar (<bundle>/<bundle>.canvas);
            // surface every other .canvas as a standalone canvas item.
            let is_layer_sidecar = in_bundle && file_stem(&path) == file_name(dir);
            if !is_layer_sidecar {
                items.push(TreeItem {
                    id: format!("canvas:{}", path_string(&path)),
                    path: path_string(&path),
                    name: file_stem(&path),
                    item_type: "canvas".to_string(),
                    icon: "canvas".to_string(),
                    children: None,
                });
            }
        }
    }
    Ok(items)
}

fn build_tree(vault: &Path, notes: &[IndexedNote]) -> Result<Vec<TreeItem>, String> {
    scan_tree_dir(vault, vault, &note_map(notes, vault), false)
}

pub fn note_by_id(conn: &Connection, vault: &Path, note_id: &str) -> Result<IndexedNote, String> {
    conn.query_row(
        "SELECT id, path, title, mtime, word_count FROM notes WHERE id = ?1",
        [note_id],
        |row| {
            let rel_path: String = row.get(1)?;
            Ok(IndexedNote {
                id: row.get(0)?,
                path: path_string(&abs_from_rel(vault, &rel_path)),
                title: row.get(2)?,
                modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                word_count: row.get::<_, i64>(4)? as usize,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Note not found: {note_id}"))
}

pub fn read_note(conn: &Connection, vault: &Path, note_id: &str) -> Result<String, String> {
    let note = note_by_id(conn, vault, note_id)?;
    frontmatter::read_markdown(Path::new(&note.path)).map(|parsed| parsed.body)
}

/// Update only the index entry for a single note after saving it.
/// Avoids the O(N) full-vault scan done by `sync_vault`.
pub fn upsert_note_index(conn: &Connection, vault: &Path, note_id: &str, body: &str, note_path: &Path) -> Result<(), String> {
    let (mtime, size) = metadata_stamp(note_path)?;
    let rel_path = note_path
        .strip_prefix(vault)
        .map(normalize_rel_path)
        .map_err(|e| e.to_string())?;
    let title = title_for(note_path, body);

    conn.execute(
        r#"
        INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'), strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET
            path       = excluded.path,
            title      = excluded.title,
            mtime      = excluded.mtime,
            size       = excluded.size,
            content    = excluded.content,
            word_count = excluded.word_count,
            updated_at = strftime('%s','now')
        "#,
        rusqlite::params![
            note_id,
            rel_path,
            title,
            mtime,
            size,
            body,
            word_count(body) as i64
        ],
    )
    .map_err(|e| e.to_string())?;

    // Re-index tags for this note.
    conn.execute("DELETE FROM tags WHERE note_id = ?1", [note_id])
        .map_err(|e| e.to_string())?;
    for tag in extract_tags(body) {
        conn.execute(
            "INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?1, ?2)",
            rusqlite::params![note_id, tag],
        )
        .map_err(|e| e.to_string())?;
    }

    // Re-index outgoing links for this note.
    conn.execute("DELETE FROM links WHERE note_id = ?1", [note_id])
        .map_err(|e| e.to_string())?;
    for (raw, target, label) in extract_links(body) {
        conn.execute(
            "INSERT INTO links (note_id, raw, target, label, target_note_id) VALUES (?1, ?2, ?3, ?4, NULL)",
            rusqlite::params![note_id, raw, target, label],
        )
        .map_err(|e| e.to_string())?;
    }

    // Resolve only this note's links and the links pointing at it.
    resolve_links_for_note(&conn, note_id)?;

    Ok(())
}

/// Write content to the note and update the index.
/// Returns the absolute path of the written file so callers can suppress
/// the resulting fs-watcher event (self-write guard).
pub fn write_note(conn: &Connection, vault: &Path, note_id: &str, content: &str) -> Result<PathBuf, String> {
    let note = note_by_id(conn, vault, note_id)?;
    let path = PathBuf::from(&note.path);
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let next = frontmatter::replace_body_preserving_id(&current, content, note_id)?;
    frontmatter::atomic_write(&path, &next)?;
    // Parse the body that was actually written (without frontmatter) to update the index.
    let written = frontmatter::parse_markdown(&next);
    upsert_note_index(conn, vault, note_id, &written.body, &path)?;
    Ok(path)
}

pub fn note_metadata(conn: &Connection, vault: &Path, note_id: &str) -> Result<IndexedNote, String> {
    note_by_id(conn, vault, note_id)
}

/// List all tags. Does NOT call sync_vault — the caller is responsible for
/// keeping the index fresh (via the Rust-side notify watcher + load_vault).
pub fn list_tags(conn: &Connection, vault: &Path) -> Result<Vec<TagEntry>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT t.tag, n.id, n.path, n.title, n.mtime, n.word_count
            FROM tags t
            JOIN notes n ON n.id = t.note_id
            ORDER BY t.tag, n.path
            "#,
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let rel_path: String = row.get(2)?;
            Ok((
                row.get::<_, String>(0)?,
                IndexedNote {
                    id: row.get(1)?,
                    path: path_string(&abs_from_rel(vault, &rel_path)),
                    title: row.get(3)?,
                    modified: row.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    word_count: row.get::<_, i64>(5)? as usize,
                },
            ))
        })
        .map_err(|e| e.to_string())?;

    // Rows arrive grouped by tag, so append into the trailing entry.
    let mut result: Vec<TagEntry> = Vec::new();
    for row in rows {
        let (tag, note) = row.map_err(|e| e.to_string())?;
        match result.last_mut() {
            Some(entry) if entry.tag == tag => entry.notes.push(note),
            _ => result.push(TagEntry {
                tag,
                notes: vec![note],
            }),
        }
    }
    Ok(result)
}

fn snippet(content: &str, query: &str) -> Option<String> {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let idx = lower.find(&q)?;
    let start = idx.saturating_sub(60);
    let end = (idx + query.len() + 60).min(content.len());
    Some(format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        &content[start..end],
        if end < content.len() { "..." } else { "" }
    ))
}

/// Search notes by title and content. Does NOT call sync_vault — the index
/// is expected to be fresh (maintained by the notify watcher + load_vault).
pub fn search_notes(conn: &Connection, vault: &Path, query: &str) -> Result<Vec<SearchResult>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT id, path, title, mtime, word_count, content FROM notes ORDER BY path")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                IndexedNote {
                    id: row.get(0)?,
                    path: {
                        let rel: String = row.get(1)?;
                        path_string(&abs_from_rel(vault, &rel))
                    },
                    title: row.get(2)?,
                    modified: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    word_count: row.get::<_, i64>(4)? as usize,
                },
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        let (note, content) = row.map_err(|e| e.to_string())?;
        let title = note.title.to_lowercase();
        if title.contains(&q) {
            results.push(SearchResult {
                note,
                match_type: "name".to_string(),
                snippet: None,
                score: if title.starts_with(&q) { 3 } else { 2 },
            });
        } else if content.to_lowercase().contains(&q) {
            results.push(SearchResult {
                note,
                match_type: "content".to_string(),
                snippet: snippet(&content, query),
                score: 1,
            });
        }
    }
    results.sort_by(|a, b| b.score.cmp(&a.score).then(a.note.title.cmp(&b.note.title)));
    Ok(results)
}

/// Build the note link graph from the current index.  Does NOT call
/// sync_vault — the index is expected to be fresh.
pub fn link_graph(conn: &Connection, vault: &Path) -> Result<LinkGraph, String> {
    let notes = list_notes(conn, vault)?;
    let mut nodes: HashMap<String, LinkGraphNode> = notes
        .iter()
        .map(|note| {
            (
                note.id.clone(),
                LinkGraphNode {
                    id: note.id.clone(),
                    label: note.title.clone(),
                    unresolved: None,
                },
            )
        })
        .collect();
    let mut edges = Vec::new();
    let mut stmt = conn
        .prepare("SELECT note_id, target, label, target_note_id FROM links ORDER BY note_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (source, target, label, target_note_id) = row.map_err(|e| e.to_string())?;
        let (target_id, unresolved) = if let Some(id) = target_note_id {
            (id, false)
        } else {
            let id = format!("missing:{target}");
            nodes.entry(id.clone()).or_insert(LinkGraphNode {
                id: id.clone(),
                label: target,
                unresolved: Some(true),
            });
            (id, true)
        };
        edges.push(LinkGraphEdge {
            source,
            target: target_id,
            label,
            unresolved: if unresolved { Some(true) } else { None },
        });
    }
    Ok(LinkGraph {
        nodes: nodes.into_values().collect(),
        edges,
    })
}

fn relative_path(vault: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(vault)
        .map(normalize_rel_path)
        .map_err(|e| e.to_string())
}

/// Read a note at `path`, assign it a unique ID if needed, and upsert it into
/// the index. This is used for newly-created notes, so it never walks the vault.
fn index_note_at_path(conn: &Connection, vault: &Path, path: &Path) -> Result<String, String> {
    let rel_path = relative_path(vault, path)?;
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let parsed = frontmatter::parse_markdown(&content);

    let mut id = parsed.id.filter(|id| !id.is_empty());
    if let Some(existing_id) = &id {
        let indexed_path: Option<String> = conn
            .query_row(
                "SELECT path FROM notes WHERE id = ?1",
                [existing_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if indexed_path.as_deref().is_some_and(|indexed| indexed != rel_path) {
            id = None;
        }
    }

    let (id, body) = if let Some(id) = id {
        (id, parsed.body)
    } else {
        let id = Ulid::generate().to_string();
        let next = frontmatter::body_with_id(&content, &id)?;
        frontmatter::atomic_write(path, &next)?;
        let reparsed = frontmatter::parse_markdown(&next);
        (id, reparsed.body)
    };

    upsert_note_index(conn, vault, &id, &body, path)?;
    Ok(id)
}

/// Apply the markdown path changes produced by a filesystem mutation without a
/// full vault scan. Renamed notes retain their IDs; newly-created notes receive
/// an ID and are indexed in place. Canvas and other sidecar files are ignored.
pub fn index_apply_path_changes(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<(), String> {
    for change in changes {
        if change.new_path.is_empty() {
            continue;
        }
        let new_path = Path::new(&change.new_path);
        if !is_markdown(new_path) {
            continue;
        }

        if change.old_path.is_empty() {
            index_note_at_path(conn, vault, new_path)?;
            continue;
        }

        let old_path = Path::new(&change.old_path);
        if !is_markdown(old_path) {
            index_note_at_path(conn, vault, new_path)?;
            continue;
        }
        let old_rel = relative_path(vault, old_path)?;
        let id: Option<String> = conn
            .query_row("SELECT id FROM notes WHERE path = ?1", [&old_rel], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;

        if let Some(id) = id {
            let content = fs::read_to_string(new_path).map_err(|e| e.to_string())?;
            let body = frontmatter::parse_markdown(&content).body;
            upsert_note_index(conn, vault, &id, &body, new_path)?;
        } else {
            index_note_at_path(conn, vault, new_path)?;
        }
    }
    Ok(())
}

/// Remove deleted markdown notes from the index and return their IDs. Inbound
/// links are cleared so callers immediately see unresolved links instead of a
/// stale reference to a deleted note.
pub fn index_delete_paths(
    conn: &Connection,
    vault: &Path,
    deleted_paths: &[String],
) -> Result<Vec<String>, String> {
    let mut deleted_ids = Vec::new();
    for path in deleted_paths {
        let path = Path::new(path);
        if !is_markdown(path) {
            continue;
        }
        let rel_path = relative_path(vault, path)?;
        let id: Option<String> = conn
            .query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(id) = id else {
            continue;
        };

        conn.execute(
            "UPDATE links SET target_note_id = NULL WHERE target_note_id = ?1",
            [&id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM tags WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM links WHERE note_id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM notes WHERE id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        deleted_ids.push(id);
    }
    Ok(deleted_ids)
}

/// Look up a note ID from its absolute vault path without building the tree.
pub fn note_id_for_path(
    conn: &Connection,
    vault: &Path,
    path: &Path,
) -> Result<Option<String>, String> {
    let rel_path = relative_path(vault, path)?;
    conn.query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("amby-index-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Open a persistent connection for the test vault, matching the app's
    /// one-connection-per-vault lifecycle.
    fn open_conn(vault: &Path) -> Connection {
        open_connection(vault).unwrap()
    }

    #[test]
    fn sync_adds_ulid_to_new_file() {
        let vault = temp_vault("new");
        let note = vault.join("A.md");
        fs::write(&note, "Hello #tag").unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 1);
        assert!(fs::read_to_string(note).unwrap().starts_with("---\nid: "));
        assert_eq!(loaded.tree[0].id, loaded.notes[0].id);
    }

    #[test]
    fn sync_hard_deletes_missing_files() {
        let vault = temp_vault("delete");
        let note = vault.join("A.md");
        fs::write(&note, "Hello").unwrap();
        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        fs::remove_file(&note).unwrap();

        let loaded = load_vault(&conn, &vault).unwrap();

        assert!(loaded.notes.is_empty());
        assert_eq!(loaded.sync.deleted, 1);
    }

    #[test]
    fn sync_updates_moved_file_by_frontmatter_id() {
        let vault = temp_vault("move");
        let note = vault.join("A.md");
        fs::write(&note, "Hello").unwrap();
        let conn = open_conn(&vault);
        let first = load_vault(&conn, &vault).unwrap();
        let id = first.notes[0].id.clone();
        fs::rename(&note, vault.join("B.md")).unwrap();

        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes[0].id, id);
        assert!(loaded.notes[0].path.ends_with("B.md"));
    }

    #[test]
    fn incremental_create_indexes_new_note_without_full_sync() {
        let vault = temp_vault("incremental-create");
        let note = vault.join("Created.md");
        fs::write(&note, "Created #tag").unwrap();
        let conn = open_conn(&vault);

        index_apply_path_changes(
            &conn,
            &vault,
            &[crate::model::PathChange {
                old_path: String::new(),
                new_path: path_string(&note),
            }],
        )
        .unwrap();

        let id = note_id_for_path(&conn, &vault, &note).unwrap().unwrap();
        assert!(!id.is_empty());
        assert!(fs::read_to_string(&note).unwrap().starts_with("---\nid: "));
        assert_eq!(list_notes(&conn, &vault).unwrap().len(), 1);
    }

    #[test]
    fn incremental_move_preserves_note_id_and_link_targets() {
        let vault = temp_vault("incremental-move");
        let source = vault.join("A.md");
        let target = vault.join("Renamed.md");
        let incoming = vault.join("Incoming.md");
        fs::write(&source, "A note without a heading").unwrap();
        fs::write(&incoming, "Link to [[A]]").unwrap();
        let conn = open_conn(&vault);
        let initial = load_vault(&conn, &vault).unwrap();
        let id = initial
            .notes
            .iter()
            .find(|note| note.path.ends_with("A.md"))
            .unwrap()
            .id
            .clone();

        fs::rename(&source, &target).unwrap();
        index_apply_path_changes(
            &conn,
            &vault,
            &[crate::model::PathChange {
                old_path: path_string(&source),
                new_path: path_string(&target),
            }],
        )
        .unwrap();

        assert_eq!(note_id_for_path(&conn, &vault, &target).unwrap(), Some(id));
        let graph = link_graph(&conn, &vault).unwrap();
        assert!(graph.edges.iter().any(|edge| edge.unresolved == Some(true)));
    }

    #[test]
    fn incremental_delete_returns_id_and_unresolves_inbound_links() {
        let vault = temp_vault("incremental-delete");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "Link to [[B]]").unwrap();
        fs::write(&target, "# B").unwrap();
        let conn = open_conn(&vault);
        let initial = load_vault(&conn, &vault).unwrap();
        let target_id = initial
            .notes
            .iter()
            .find(|note| note.path.ends_with("B.md"))
            .unwrap()
            .id
            .clone();

        fs::remove_file(&target).unwrap();
        let deleted = index_delete_paths(&conn, &vault, &[path_string(&target)]).unwrap();

        assert_eq!(deleted, vec![target_id]);
        assert!(note_id_for_path(&conn, &vault, &target).unwrap().is_none());
        assert!(link_graph(&conn, &vault)
            .unwrap()
            .edges
            .iter()
            .any(|edge| edge.unresolved == Some(true)));
    }

    #[test]
    fn bundle_main_is_file_node_with_children() {
        let vault = temp_vault("bundle");
        fs::create_dir(vault.join("Parent")).unwrap();
        fs::write(vault.join("Parent/Parent.md"), "Parent").unwrap();
        fs::write(vault.join("Parent/Child.md"), "Child").unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.tree.len(), 1);
        assert_eq!(loaded.tree[0].name, "Parent");
        assert_eq!(loaded.tree[0].item_type, "file");
        assert_eq!(loaded.tree[0].children.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn incremental_reload_keeps_links_resolved() {
        let vault = temp_vault("incr-links");
        fs::write(vault.join("A.md"), "Link to [[B]]").unwrap();
        fs::write(vault.join("B.md"), "# B").unwrap();

        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert!(graph.edges.iter().all(|e| e.unresolved.is_none()));

        // Nothing changed: the unchanged-file fast path must not drop the
        // already-resolved target.
        let graph2 = link_graph(&conn, &vault).unwrap();
        assert!(graph2.edges.iter().all(|e| e.unresolved.is_none()));
    }

    #[test]
    fn normalizes_heading_and_block_anchors() {
        assert_eq!(normalize_wiki_target("Note#Heading"), "note");
        assert_eq!(normalize_wiki_target("Note^block-id"), "note");
        assert_eq!(normalize_wiki_target("Note#Heading|Alias"), "note");
        assert_eq!(normalize_wiki_target("Folder/Note^abc"), "folder/note");
    }

    #[test]
    fn resolves_anchored_and_bundle_links() {
        let vault = temp_vault("anchors");
        // A links to a heading, a block, and a bundle note by its name.
        fs::write(
            vault.join("A.md"),
            "[[Target#Intro]] [[Target^para1]] [[Bundle]]",
        )
        .unwrap();
        fs::write(vault.join("Target.md"), "# Target").unwrap();
        fs::create_dir(vault.join("Bundle")).unwrap();
        fs::write(vault.join("Bundle/Bundle.md"), "# Bundle").unwrap();

        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();

        assert_eq!(graph.edges.len(), 3);
        assert!(
            graph.edges.iter().all(|e| e.unresolved.is_none()),
            "all anchored/bundle links should resolve: {:?}",
            graph.edges
        );
    }

    #[test]
    fn deleting_target_unresolves_links_on_reload() {
        let vault = temp_vault("unresolve");
        fs::write(vault.join("A.md"), "Link to [[B]]").unwrap();
        fs::write(vault.join("B.md"), "# B").unwrap();
        let conn = open_conn(&vault);
        load_vault(&conn, &vault).unwrap();
        assert!(link_graph(&conn, &vault)
            .unwrap()
            .edges
            .iter()
            .all(|e| e.unresolved.is_none()));

        // A is untouched; only the target is removed. Re-syncing must drop B and
        // re-resolve A's link to unresolved, even though A's own row is skipped by
        // the incremental scan.
        fs::remove_file(vault.join("B.md")).unwrap();
        load_vault(&conn, &vault).unwrap();
        let graph = link_graph(&conn, &vault).unwrap();
        assert!(graph.edges.iter().any(|e| e.unresolved == Some(true)));
    }
}
