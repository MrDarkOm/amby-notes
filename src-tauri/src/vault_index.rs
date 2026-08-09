use crate::{frontmatter, history};
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
pub struct VaultPreflight {
    pub notes: usize,
    pub attachments: usize,
    pub malformed_frontmatter: Vec<String>,
    pub user_managed_ids: Vec<String>,
    pub duplicate_ids: Vec<String>,
    pub planned_id_writes: Vec<String>,
}

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct IdMigrationResult {
    pub backup_path: String,
    pub journal_path: String,
    pub modified_paths: Vec<String>,
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
    frontmatter_tags: Vec<String>,
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
    path.extension().is_some_and(|ext| ext == "md")
}

fn is_canvas(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "canvas")
}

/// The `id` frontmatter field belongs to Amby only when it is a canonical,
/// uppercase ULID. Any other value may be user-managed and must never be
/// replaced implicitly.
fn is_amby_id(id: &str) -> bool {
    Ulid::from_string(id)
        .map(|parsed| parsed.to_string() == id)
        .unwrap_or(false)
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
    !matches!(
        name.as_ref(),
        ".amby" | ".obsidian" | ".git" | ".trash" | "assets"
    )
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

fn is_tag_character(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '-' | '/')
}

fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && !tag.starts_with('/')
        && !tag.ends_with('/')
        && !tag.contains("//")
        && tag.chars().all(is_tag_character)
        && tag
            .chars()
            .any(|character| character.is_alphabetic() || matches!(character, '_' | '-'))
}

fn extract_tags(content: &str, frontmatter_tags: &[String]) -> Vec<String> {
    let mut tags = HashSet::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    let mut line_start = true;
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    while i < chars.len() {
        if chars[i] == '\n' {
            line_start = true;
            i += 1;
            continue;
        }

        if line_start {
            let mut marker_start = i;
            while marker_start < chars.len() && matches!(chars[marker_start], ' ' | '\t') {
                marker_start += 1;
            }
            if marker_start < chars.len() && matches!(chars[marker_start], '`' | '~') {
                let marker = chars[marker_start];
                let mut marker_end = marker_start;
                while marker_end < chars.len() && chars[marker_end] == marker {
                    marker_end += 1;
                }
                let marker_len = marker_end - marker_start;
                if marker_len >= 3 {
                    match fence {
                        Some((open_marker, open_len))
                            if marker == open_marker && marker_len >= open_len =>
                        {
                            fence = None;
                        }
                        None => fence = Some((marker, marker_len)),
                        _ => {}
                    }
                    i = marker_end;
                    line_start = false;
                    continue;
                }
            }
            line_start = false;
        }

        if fence.is_some() {
            i += 1;
            continue;
        }

        if i + 1 < chars.len() && chars[i] == '%' && chars[i + 1] == '%' {
            in_comment = !in_comment;
            i += 2;
            continue;
        }
        if in_comment {
            i += 1;
            continue;
        }

        if chars[i] == '`' {
            let mut delimiter_end = i;
            while delimiter_end < chars.len() && chars[delimiter_end] == '`' {
                delimiter_end += 1;
            }
            let delimiter_len = delimiter_end - i;
            let mut cursor = delimiter_end;
            while cursor < chars.len() && chars[cursor] != '\n' {
                if chars[cursor] == '`' {
                    let mut close_end = cursor;
                    while close_end < chars.len() && chars[close_end] == '`' {
                        close_end += 1;
                    }
                    if close_end - cursor == delimiter_len {
                        cursor = close_end;
                        break;
                    }
                    cursor = close_end;
                } else {
                    cursor += 1;
                }
            }
            i = cursor;
            continue;
        }

        let prev_is_boundary = i == 0
            || (!chars[i - 1].is_alphanumeric() && !matches!(chars[i - 1], '_' | '/' | '#' | '\\'));
        if prev_is_boundary && chars[i] == '#' && i + 1 < chars.len() {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_tag_character(chars[end]) {
                end += 1;
            }
            let tag = chars[start..end].iter().collect::<String>();
            if is_valid_tag(&tag) {
                tags.insert(tag.to_lowercase());
            }
            i = end;
        } else {
            i += 1;
        }
    }

    for raw in frontmatter_tags {
        let tag = raw.trim().trim_start_matches('#');
        if is_valid_tag(tag) {
            tags.insert(tag.to_lowercase());
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
        .split(['#', '^'])
        .next()
        .unwrap_or(without_alias);
    base.trim()
        .trim_end_matches(".md")
        .replace('\\', "/")
        .to_lowercase()
}

fn protected_markdown_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();

    if content.starts_with("---\n") || content.starts_with("---\r\n") {
        let mut offset = content
            .find('\n')
            .map(|index| index + 1)
            .unwrap_or(content.len());
        for line in content[offset..].split_inclusive('\n') {
            offset += line.len();
            if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
                ranges.push((0, offset));
                break;
            }
        }
    }

    let mut fenced: Option<(char, usize, usize)> = None;
    let mut offset = 0;

    for line in content.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next();
        let marker_len = marker
            .filter(|character| matches!(character, '`' | '~'))
            .map(|character| {
                trimmed
                    .chars()
                    .take_while(|current| *current == character)
                    .count()
            })
            .unwrap_or_default();

        if let Some((fence_character, fence_len, start)) = fenced {
            if marker == Some(fence_character) && marker_len >= fence_len {
                ranges.push((start, offset + line.len()));
                fenced = None;
            }
        } else if let Some(fence_character) = marker.filter(|_| marker_len >= 3) {
            fenced = Some((fence_character, marker_len, offset));
        }
        offset += line.len();
    }
    if let Some((_, _, start)) = fenced {
        ranges.push((start, content.len()));
    }

    let mut cursor = 0;
    while cursor < content.len() {
        if let Some((_, to)) = ranges
            .iter()
            .find(|(from, to)| cursor >= *from && cursor < *to)
        {
            cursor = *to;
            continue;
        }

        if content[cursor..].starts_with("%%") {
            let end = content[cursor + 2..]
                .find("%%")
                .map(|relative| cursor + 2 + relative + 2)
                .unwrap_or(content.len());
            ranges.push((cursor, end));
            cursor = end;
            continue;
        }

        if content[cursor..].starts_with('`') {
            let delimiter_len = content[cursor..]
                .chars()
                .take_while(|character| *character == '`')
                .count();
            let delimiter = "`".repeat(delimiter_len);
            let line_end = content[cursor..]
                .find('\n')
                .map(|relative| cursor + relative)
                .unwrap_or(content.len());
            let search_start = cursor + delimiter_len;
            if let Some(relative) = content[search_start..line_end].find(&delimiter) {
                let end = search_start + relative + delimiter_len;
                ranges.push((cursor, end));
                cursor = end;
                continue;
            }
        }

        cursor += content[cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    }

    ranges.sort_unstable_by_key(|range| range.0);
    ranges
}

fn extract_links(content: &str) -> Vec<(String, String, String)> {
    let mut links = Vec::new();
    let protected_ranges = protected_markdown_ranges(content);
    let mut cursor = 0;
    while let Some(relative_start) = content[cursor..].find("[[") {
        let start = cursor + relative_start;
        cursor = start + 2;
        if protected_ranges
            .iter()
            .any(|(from, to)| start >= *from && start < *to)
        {
            continue;
        }
        let Some(relative_end) = content[cursor..].find("]]") else {
            break;
        };
        let end = cursor + relative_end;
        let raw = &content[cursor..end];
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
        cursor = end + 2;
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

type DbSnapshot = (HashMap<String, String>, HashMap<String, String>);

fn db_snapshot(conn: &Connection) -> Result<DbSnapshot, String> {
    let mut by_id = HashMap::new();
    let mut by_path = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id, path FROM notes")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
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
                    frontmatter_tags: Vec::new(),
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
            frontmatter_tags: parsed.frontmatter_tags,
            mtime,
            size,
            unchanged: false,
        });
    }
    notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(notes)
}

/// Read-only vault inspection used before the first ID migration. It never
/// opens SQLite, creates `.amby`, or changes a user file.
pub fn preflight_vault(vault: &Path) -> Result<VaultPreflight, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let mut report = VaultPreflight {
        notes: 0,
        attachments: 0,
        malformed_frontmatter: Vec::new(),
        user_managed_ids: Vec::new(),
        duplicate_ids: Vec::new(),
        planned_id_writes: Vec::new(),
    };
    let mut ids = HashMap::<String, String>::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(should_descend)
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !is_markdown(path) || file_name(path) == "Metadata.md" {
            report.attachments += 1;
            continue;
        }
        let rel_path = path
            .strip_prefix(vault)
            .map(normalize_rel_path)
            .map_err(|e| e.to_string())?;
        report.notes += 1;
        let parsed = frontmatter::read_markdown(path)?;
        if parsed.has_frontmatter && !parsed.yaml_is_map {
            report.malformed_frontmatter.push(rel_path);
            continue;
        }
        match parsed.id.filter(|id| !id.is_empty()) {
            None => report.planned_id_writes.push(rel_path),
            Some(id) if !is_amby_id(&id) => report.user_managed_ids.push(rel_path),
            Some(id) => {
                if let Some(first_path) = ids.insert(id.clone(), rel_path.clone()) {
                    report
                        .duplicate_ids
                        .push(format!("{id}: {first_path}, {rel_path}"));
                }
            }
        }
    }
    report.planned_id_writes.sort();
    Ok(report)
}

/// Add IDs only to files the preflight identified as missing them. Every
/// changed note is copied into a timestamped `.amby/backups/` restore point
/// before the atomic write, and a journal records the operation.
pub fn apply_id_migration(vault: &Path) -> Result<IdMigrationResult, String> {
    let preflight = preflight_vault(vault)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let backup_root = vault
        .join(".amby")
        .join("backups")
        .join(format!("id-migration-{stamp}"));
    fs::create_dir_all(&backup_root).map_err(|e| e.to_string())?;

    let mut modified_paths = Vec::new();
    for rel_path in preflight.planned_id_writes {
        let path = abs_from_rel(vault, &rel_path);
        let backup = backup_root.join(&rel_path);
        if let Some(parent) = backup.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&path, &backup).map_err(|e| e.to_string())?;
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let with_id = frontmatter::body_with_id(&content, &Ulid::generate().to_string())?;
        frontmatter::atomic_write(&path, &with_id)?;
        modified_paths.push(rel_path);
    }

    let journal_path = vault
        .join(".amby")
        .join("migrations")
        .join(format!("id-migration-{stamp}.json"));
    if let Some(parent) = journal_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let journal = serde_json::json!({
        "version": 1,
        "kind": "add-amby-ids",
        "createdAtMs": stamp,
        "backupPath": normalize_rel_path(backup_root.strip_prefix(vault).unwrap_or(&backup_root)),
        "modifiedPaths": modified_paths,
    });
    frontmatter::atomic_write_bytes(
        &journal_path,
        &serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?,
    )?;

    Ok(IdMigrationResult {
        backup_path: path_string(&backup_root),
        journal_path: path_string(&journal_path),
        modified_paths,
    })
}

pub fn sync_vault(conn: &Connection, vault: &Path) -> Result<SyncReport, String> {
    if !vault.is_dir() {
        return Err(format!("Not a directory: {}", path_string(vault)));
    }
    let (db_by_id, _db_by_path) = db_snapshot(conn)?;
    let prev = db_path_stamps(conn)?;
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

        let existing_id = note.parsed_id.clone().filter(|id| !id.is_empty());
        if let Some(id) = existing_id.as_deref() {
            if !is_amby_id(id) {
                warnings.push(format!(
                    "Skipped {}: existing frontmatter id is not an Amby ULID",
                    note.rel_path
                ));
                continue;
            }
            if seen_ids.contains(id) {
                warnings.push(format!(
                    "Skipped {}: duplicate Amby id {id} was left unchanged",
                    note.rel_path
                ));
                continue;
            }
        }

        let mut id = existing_id.unwrap_or_default();
        if id.is_empty() {
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
            .query_row("SELECT id FROM notes WHERE id = ?1", [&id], |row| {
                row.get(0)
            })
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
        for tag in extract_tags(&note.body, &note.frontmatter_tags) {
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
        tx.execute("DELETE FROM notes", [])
            .map_err(|e| e.to_string())?;
    } else {
        let placeholders = (0..seen_vec.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
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
        if let Some(name) = path.split('/').next_back() {
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
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
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
    if let Some(name) = path.split('/').next_back() {
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
        children: if children.is_empty() {
            None
        } else {
            Some(children)
        },
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

pub fn note_properties(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<crate::model::NoteProperties, String> {
    let note = note_by_id(conn, vault, note_id)?;
    let content = fs::read_to_string(&note.path).map_err(|error| error.to_string())?;
    Ok(frontmatter::note_properties(&content))
}

/// Update only the index entry for a single note after saving it.
/// Avoids the O(N) full-vault scan done by `sync_vault`.
pub fn upsert_note_index(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    body: &str,
    note_path: &Path,
) -> Result<(), String> {
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
    let frontmatter_tags = frontmatter::read_markdown(note_path)
        .map(|parsed| parsed.frontmatter_tags)
        .unwrap_or_default();
    for tag in extract_tags(body, &frontmatter_tags) {
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
    resolve_links_for_note(conn, note_id)?;

    Ok(())
}

/// Write content to the note and update the index.
/// Returns the absolute path of the written file so callers can suppress
/// the resulting fs-watcher event (self-write guard).
pub fn write_note(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
    content: &str,
) -> Result<PathBuf, String> {
    let note = note_by_id(conn, vault, note_id)?;
    let path = PathBuf::from(&note.path);
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let next = frontmatter::replace_body_preserving_id(&current, content, note_id)?;
    history::snapshot_before_write(vault, &path, next.as_bytes(), "note-save")?;
    frontmatter::atomic_write(&path, &next)?;
    // Parse the body that was actually written (without frontmatter) to update the index.
    let written = frontmatter::parse_markdown(&next);
    upsert_note_index(conn, vault, note_id, &written.body, &path)?;
    Ok(path)
}

pub fn note_metadata(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<IndexedNote, String> {
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
pub fn search_notes(
    conn: &Connection,
    vault: &Path,
    query: &str,
) -> Result<Vec<SearchResult>, String> {
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

    let existing_id = parsed.id.filter(|id| !id.is_empty());
    if let Some(id) = existing_id.as_deref() {
        if !is_amby_id(id) {
            return Err("Refusing to replace an existing non-Amby frontmatter id".to_string());
        }
    }
    let id = existing_id;
    if let Some(existing_id) = &id {
        let indexed_path: Option<String> = conn
            .query_row(
                "SELECT path FROM notes WHERE id = ?1",
                [existing_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if indexed_path
            .as_deref()
            .is_some_and(|indexed| indexed != rel_path)
        {
            return Err(format!(
                "Duplicate Amby id {existing_id}; the source file was left unchanged"
            ));
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
            .query_row("SELECT id FROM notes WHERE path = ?1", [&old_rel], |row| {
                row.get(0)
            })
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

#[derive(Clone, Debug)]
pub struct PlannedWikiRewrite {
    source_path: PathBuf,
    replacements: Vec<(String, String)>,
    literal_replacements: Vec<(String, String)>,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefactorPreview {
    pub notes: usize,
    pub replacements: usize,
}

pub fn refactor_preview(plan: &[PlannedWikiRewrite]) -> RefactorPreview {
    RefactorPreview {
        notes: plan.len(),
        replacements: plan
            .iter()
            .map(|rewrite| rewrite.replacements.len() + rewrite.literal_replacements.len())
            .sum(),
    }
}

fn replace_wiki_target(raw: &str, target: &str) -> String {
    let suffix_at = raw
        .char_indices()
        .find_map(|(index, character)| matches!(character, '#' | '^' | '|').then_some(index))
        .unwrap_or(raw.len());
    format!("{target}{}", &raw[suffix_at..])
}

/// Plan exact inbound wikilink rewrites before a rename or move. The index has
/// already resolved each `target_note_id`, which lets this avoid changing an
/// ambiguous `[[Title]]` that points at a different note with the same name.
pub fn plan_inbound_wiki_rewrites(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<Vec<PlannedWikiRewrite>, String> {
    let mut moved_sources = HashMap::<String, String>::new();
    let mut targets = HashMap::<String, String>::new();
    for change in changes {
        let old = Path::new(&change.old_path);
        let new = Path::new(&change.new_path);
        if change.old_path.is_empty()
            || change.new_path.is_empty()
            || !is_markdown(old)
            || !is_markdown(new)
        {
            continue;
        }
        let old_rel = relative_path(vault, old)?;
        let new_rel = relative_path(vault, new)?;
        moved_sources.insert(old_rel.clone(), new_rel.clone());
        let id: Option<String> = conn
            .query_row("SELECT id FROM notes WHERE path = ?1", [&old_rel], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(id) = id {
            targets.insert(id, new_rel.trim_end_matches(".md").to_string());
        }
    }

    let mut by_source = HashMap::<PathBuf, Vec<(String, String)>>::new();
    for (target_id, replacement) in targets {
        let mut statement = conn
            .prepare(
                "SELECT notes.path, links.raw FROM links JOIN notes ON notes.id = links.note_id WHERE links.target_note_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([target_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        for (source_rel, raw) in rows {
            let source_rel = moved_sources.get(&source_rel).unwrap_or(&source_rel);
            let source = vault.join(source_rel);
            let next = replace_wiki_target(&raw, &replacement);
            if raw != next {
                by_source.entry(source).or_default().push((raw, next));
            }
        }
    }

    // Exact vault-relative Markdown destinations and JSON string values are
    // also safe to update. This covers normal Markdown links/embeds plus
    // Canvas and Excalidraw references without guessing about filenames.
    let mut literal_by_source = HashMap::<PathBuf, Vec<(String, String)>>::new();
    let literal_changes = changes
        .iter()
        .filter(|change| !change.old_path.is_empty() && !change.new_path.is_empty())
        .map(|change| {
            Ok((
                relative_path(vault, Path::new(&change.old_path))?,
                relative_path(vault, Path::new(&change.new_path))?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let moved_absolute = changes
        .iter()
        .map(|change| {
            (
                PathBuf::from(&change.old_path),
                PathBuf::from(&change.new_path),
            )
        })
        .collect::<HashMap<_, _>>();
    for entry in WalkDir::new(vault).into_iter().filter_map(Result::ok) {
        let source = entry.path();
        if !source.is_file()
            || !matches!(
                source.extension().and_then(|ext| ext.to_str()),
                Some("md" | "canvas" | "excalidraw")
            )
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(source) else {
            continue;
        };
        let rewritten_source = moved_absolute
            .get(source)
            .cloned()
            .unwrap_or_else(|| source.to_path_buf());
        for (old_rel, new_rel) in &literal_changes {
            for (old, new) in [
                (format!("]({old_rel})"), format!("]({new_rel})")),
                (format!("](/{old_rel})"), format!("](/{new_rel})")),
                (format!("]({old_rel}#"), format!("]({new_rel}#")),
                (format!("](/{old_rel}#"), format!("](/{new_rel}#")),
                (format!("]({old_rel}^"), format!("]({new_rel}^")),
                (format!("](/{old_rel}^"), format!("](/{new_rel}^")),
                (format!("\"{old_rel}\""), format!("\"{new_rel}\"")),
            ] {
                if content.contains(&old) {
                    literal_by_source
                        .entry(rewritten_source.clone())
                        .or_default()
                        .push((old, new));
                }
            }
        }
    }

    let mut sources = HashSet::new();
    sources.extend(by_source.keys().cloned());
    sources.extend(literal_by_source.keys().cloned());
    Ok(sources
        .into_iter()
        .map(|source_path| {
            let mut replacements = by_source.remove(&source_path).unwrap_or_default();
            replacements.sort();
            replacements.dedup();
            let mut literal_replacements =
                literal_by_source.remove(&source_path).unwrap_or_default();
            literal_replacements.sort();
            literal_replacements.dedup();
            PlannedWikiRewrite {
                source_path,
                replacements,
                literal_replacements,
            }
        })
        .collect())
}

/// Apply a precomputed refactor plan atomically per source note. If any write
/// fails, every completed source-note rewrite is restored from memory; the
/// caller can then report the failed filesystem operation without half-updated
/// links.
pub fn apply_planned_wiki_rewrites(
    vault: &Path,
    plan: &[PlannedWikiRewrite],
) -> Result<Vec<PathBuf>, String> {
    let mut proposed = Vec::<(PathBuf, String, String)>::new();
    for rewrite in plan {
        let original =
            fs::read_to_string(&rewrite.source_path).map_err(|error| error.to_string())?;
        let mut next = original.clone();
        for (raw, replacement) in &rewrite.replacements {
            next = next.replace(&format!("[[{raw}]]"), &format!("[[{replacement}]]"));
        }
        for (raw, replacement) in &rewrite.literal_replacements {
            next = next.replace(raw, replacement);
        }
        if next != original {
            proposed.push((rewrite.source_path.clone(), original, next));
        }
    }

    let mut applied = Vec::<(PathBuf, String)>::new();
    for (path, original, next) in proposed {
        let result = history::snapshot_before_write(vault, &path, next.as_bytes(), "link-refactor")
            .and_then(|_| frontmatter::atomic_write(&path, &next));
        if let Err(error) = result {
            for (applied_path, applied_original) in applied.into_iter().rev() {
                let _ = frontmatter::atomic_write(&applied_path, &applied_original);
            }
            return Err(error);
        }
        applied.push((path, original));
    }
    Ok(applied.into_iter().map(|(path, _)| path).collect())
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
            .query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| {
                row.get(0)
            })
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
    conn.query_row("SELECT id FROM notes WHERE path = ?1", [&rel_path], |row| {
        row.get(0)
    })
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
    fn refactor_rewrites_resolved_wikilinks_without_losing_anchor_or_alias() {
        let vault = temp_vault("refactor");
        let source = vault.join("A.md");
        let target = vault.join("B.md");
        fs::write(&source, "Link [[B#Heading|Readable]]").unwrap();
        fs::write(&target, "# B").unwrap();
        let conn = open_conn(&vault);
        sync_vault(&conn, &vault).unwrap();

        let renamed = vault.join("C.md");
        let changes = vec![crate::model::PathChange {
            old_path: path_string(&target),
            new_path: path_string(&renamed),
        }];
        let plan = plan_inbound_wiki_rewrites(&conn, &vault, &changes).unwrap();
        fs::rename(&target, &renamed).unwrap();
        apply_planned_wiki_rewrites(&vault, &plan).unwrap();

        assert!(fs::read_to_string(&source)
            .unwrap()
            .contains("[[C#Heading|Readable]]"));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn refactor_updates_exact_markdown_embed_and_canvas_references() {
        let vault = temp_vault("refactor-assets");
        let source = vault.join("A.md");
        let target = vault.join("Folder/B.md");
        let canvas = vault.join("Board.canvas");
        fs::create_dir(vault.join("Folder")).unwrap();
        fs::write(
            &source,
            "[note](Folder/B.md#Heading)\n![embed](/Folder/B.md^block)",
        )
        .unwrap();
        fs::write(&target, "target").unwrap();
        fs::write(&canvas, r#"{"file":"Folder/B.md"}"#).unwrap();
        let conn = open_conn(&vault);
        sync_vault(&conn, &vault).unwrap();

        let renamed = vault.join("Folder/C.md");
        let changes = vec![crate::model::PathChange {
            old_path: path_string(&target),
            new_path: path_string(&renamed),
        }];
        let plan = plan_inbound_wiki_rewrites(&conn, &vault, &changes).unwrap();
        fs::rename(&target, &renamed).unwrap();
        apply_planned_wiki_rewrites(&vault, &plan).unwrap();

        let markdown = fs::read_to_string(source).unwrap();
        assert!(markdown.contains("](Folder/C.md#Heading)"));
        assert!(markdown.contains("](/Folder/C.md^block)"));
        assert!(fs::read_to_string(canvas).unwrap().contains("Folder/C.md"));
        fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn sync_leaves_user_managed_and_duplicate_ids_unchanged() {
        let vault = temp_vault("id-conflicts");
        let user_managed = vault.join("UserManaged.md");
        let first = vault.join("First.md");
        let duplicate = vault.join("Duplicate.md");
        let id = Ulid::generate().to_string();
        fs::write(&user_managed, "---\nid: external-system\n---\nUser-managed").unwrap();
        fs::write(&first, format!("---\nid: {id}\n---\nFirst")).unwrap();
        fs::write(&duplicate, format!("---\nid: {id}\n---\nDuplicate")).unwrap();

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 1);
        assert_eq!(
            fs::read_to_string(&user_managed).unwrap(),
            "---\nid: external-system\n---\nUser-managed"
        );
        assert_eq!(
            fs::read_to_string(&duplicate).unwrap(),
            format!("---\nid: {id}\n---\nDuplicate")
        );
        assert!(loaded
            .sync
            .warnings
            .iter()
            .any(|warning| warning.contains("not an Amby ULID")));
        assert!(loaded
            .sync
            .warnings
            .iter()
            .any(|warning| warning.contains("duplicate Amby id")));
    }

    #[test]
    fn sync_excludes_obsidian_git_trash_and_amby_directories() {
        let vault = temp_vault("excluded-directories");
        fs::write(vault.join("Visible.md"), "Visible").unwrap();
        for directory in [".obsidian", ".git", ".trash", ".amby", "assets"] {
            let dir = vault.join(directory);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("Hidden.md"), "Hidden").unwrap();
        }

        let conn = open_conn(&vault);
        let loaded = load_vault(&conn, &vault).unwrap();

        assert_eq!(loaded.notes.len(), 1);
        for directory in [".obsidian", ".git", ".trash", ".amby", "assets"] {
            assert_eq!(
                fs::read_to_string(vault.join(directory).join("Hidden.md")).unwrap(),
                "Hidden"
            );
        }
    }

    #[test]
    fn preflight_is_read_only_and_id_migration_creates_a_restore_point() {
        let vault = temp_vault("id-migration");
        let note = vault.join("Untitled.md");
        let original = "# Untitled\n";
        fs::write(&note, original).unwrap();

        let preflight = preflight_vault(&vault).unwrap();
        assert_eq!(preflight.planned_id_writes, vec!["Untitled.md"]);
        assert_eq!(fs::read_to_string(&note).unwrap(), original);
        assert!(!vault.join(".amby").exists());

        let migration = apply_id_migration(&vault).unwrap();
        assert_eq!(migration.modified_paths, vec!["Untitled.md"]);
        assert!(fs::read_to_string(&note).unwrap().starts_with("---\nid: "));
        assert_eq!(
            fs::read_to_string(format!("{}/Untitled.md", migration.backup_path)).unwrap(),
            original
        );
        assert!(Path::new(&migration.journal_path).is_file());
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

    #[test]
    fn extracts_obsidian_tags_and_ignores_code_comments_and_numeric_tags() {
        let body = "#visible #inbox/to-read #1984\n`#inline`\n```md\n#fenced\n```\n%% #hidden %%";
        assert_eq!(
            extract_tags(body, &["YamlTag".to_string(), "1984".to_string()]),
            vec![
                "inbox/to-read".to_string(),
                "visible".to_string(),
                "yamltag".to_string()
            ]
        );
    }

    #[test]
    fn extracts_links_only_from_markdown_content() {
        let body = "---\nalias: [[Yaml]]\n---\n[[Visible]] `[[Inline]]`\n```md\n[[Fence]]\n```\n%% [[Comment]] %%";
        let targets: Vec<_> = extract_links(body)
            .into_iter()
            .map(|(_, target, _)| target)
            .collect();
        assert_eq!(targets, vec!["visible".to_string()]);
    }
}
