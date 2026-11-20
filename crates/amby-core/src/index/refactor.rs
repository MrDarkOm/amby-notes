use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::links::{
    build_note_lookup, extract_links, normalize_wiki_target, protected_markdown_ranges,
};
use super::note_index::relative_path;
use crate::frontmatter;
use crate::history;
use crate::vault::scan::{is_markdown, is_reserved_directory};

#[derive(Clone, Debug)]
pub struct PlannedWikiRewrite {
    pub source_path: PathBuf,
    pub replacements: Vec<(String, String)>,
    pub literal_replacements: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RefactorPreview {
    pub notes: usize,
    pub replacements: usize,
}

/// Database-only part of an inbound link refactor. Keeping this value separate
/// lets mutation commands release the SQLite mutex before scanning and reading
/// Markdown/Canvas files from disk.
#[derive(Clone, Debug)]
pub struct InboundWikiRewriteInputs {
    moved_sources: HashMap<String, String>,
    inbound_links: Vec<(String, String, String)>,
    literal_changes: Vec<(String, String)>,
    moved_absolute: HashMap<PathBuf, PathBuf>,
    /// Wikilink targets (normalized, as the index reads them) that resolve to a moved note and
    /// to no other, with the new target text. Archived notes are not indexed, so their wikilinks
    /// are matched against this instead.
    archive_targets: HashMap<String, String>,
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

pub fn replace_wiki_target(raw: &str, target: &str) -> String {
    let suffix_at = raw
        .char_indices()
        .find_map(|(index, character)| matches!(character, '#' | '^' | '|').then_some(index))
        .unwrap_or(raw.len());
    format!("{target}{}", &raw[suffix_at..])
}

pub fn plan_inbound_wiki_rewrites(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<Vec<PlannedWikiRewrite>, String> {
    let inputs = collect_inbound_wiki_rewrite_inputs(conn, vault, changes)?;
    build_inbound_wiki_rewrites(vault, changes, inputs)
}

/// Collect only SQL and path-normalization inputs for a link refactor.
pub fn collect_inbound_wiki_rewrite_inputs(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<InboundWikiRewriteInputs, String> {
    let mut moved_sources = HashMap::<String, String>::new();
    let mut targets = HashMap::<String, MovedNote>::new();
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
            targets.insert(id, MovedNote::new(&old_rel, &new_rel));
        }
    }

    let notes = if targets.is_empty() {
        Vec::new()
    } else {
        all_notes(conn)?
    };
    let owners = owners_after(&notes, &moved_sources);
    for (id, _, title) in &notes {
        if let Some(target) = targets.get_mut(id) {
            target.old_title = title.to_lowercase();
        }
    }
    let archive_targets = archive_wiki_targets(conn, &notes, &targets, &owners)?;
    let mut inbound_links = Vec::new();
    for (target_id, target) in &targets {
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
            if let Some(replacement) =
                target.written_as(&normalize_wiki_target(&raw), target_id, &owners)
            {
                inbound_links.push((source_rel, raw, replacement));
            }
        }
    }

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
    Ok(InboundWikiRewriteInputs {
        moved_sources,
        inbound_links,
        literal_changes,
        moved_absolute,
        archive_targets,
    })
}

/// The names the index resolves a wikilink by (title, path, file name; lowercase, no `.md`).
fn note_link_keys(path: &str, title: &str) -> HashSet<String> {
    let path = path.trim_end_matches(".md").to_lowercase();
    let mut keys = HashSet::from([title.to_lowercase(), path.clone()]);
    if let Some(name) = path.rsplit('/').next() {
        keys.insert(name.to_string());
    }
    keys
}

/// A moved or renamed note, with what a rewritten link to it may say.
struct MovedNote {
    /// The new vault-relative path without `.md`, as written in a path link.
    full: String,
    /// The new file name without `.md`, as written in a link by name.
    stem: String,
    old_stem: String,
    /// Lowercase indexed title before the change (filled in after the paths are known).
    old_title: String,
}

impl MovedNote {
    fn new(old_rel: &str, new_rel: &str) -> Self {
        let full = new_rel.trim_end_matches(".md").to_string();
        let stem = full.rsplit('/').next().unwrap_or(&full).to_string();
        let old = old_rel.trim_end_matches(".md");
        Self {
            old_stem: old.rsplit('/').next().unwrap_or(old).to_lowercase(),
            full,
            stem,
            old_title: String::new(),
        }
    }

    /// The target text for a link that read `written` (normalized as the index reads it).
    /// A link by path gets the new path. A link by name keeps a name when, after the change,
    /// that name means this note alone: the same title after a move (a move never changes the
    /// title), otherwise the new file name. Anything else falls back to the full path.
    /// `None` leaves the link as written.
    fn written_as(
        &self,
        written: &str,
        id: &str,
        owners: &HashMap<String, Vec<String>>,
    ) -> Option<String> {
        let only_this = |key: &str| {
            owners
                .get(key)
                .is_some_and(|ids| ids.len() == 1 && ids[0] == id)
        };
        if written.contains('/') {
            return Some(self.full.clone());
        }
        let moved_only = self.stem.to_lowercase() == self.old_stem;
        if moved_only && written != self.old_stem && written == self.old_title && only_this(written)
        {
            return None;
        }
        if only_this(&self.stem.to_lowercase()) {
            return Some(self.stem.clone());
        }
        Some(self.full.clone())
    }
}

fn all_notes(conn: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut statement = conn
        .prepare("SELECT id, path, title FROM notes")
        .map_err(|error| error.to_string())?;
    let notes = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(notes)
}

/// Which notes each link name would mean after the change. A moved note may lose its title
/// (a rename can change an explicit title), so it is counted under both its old title and its
/// new names: an overcount only makes a name ambiguous, which falls back to the full path.
fn owners_after(
    notes: &[(String, String, String)],
    moved: &HashMap<String, String>,
) -> HashMap<String, Vec<String>> {
    let mut owners = HashMap::<String, Vec<String>>::new();
    for (id, path, title) in notes {
        let after = moved.get(path).unwrap_or(path);
        let mut keys = note_link_keys(after, title);
        if after != path {
            keys.extend(note_link_keys(after, &file_stem_of(after)));
        }
        for key in keys {
            let ids = owners.entry(key).or_default();
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }
    owners
}

fn file_stem_of(path: &str) -> String {
    let path = path.trim_end_matches(".md");
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// For each moved note, the link names that unambiguously mean it, with the target text a
/// rewritten link gets (see [`MovedNote::written_as`]). A name shared with another note is
/// dropped: the archived note's own location is gone, so it cannot be decided and the link
/// stays as written.
fn archive_wiki_targets(
    conn: &Connection,
    notes: &[(String, String, String)],
    targets: &HashMap<String, MovedNote>,
    owners_after: &HashMap<String, Vec<String>>,
) -> Result<HashMap<String, String>, String> {
    if targets.is_empty() {
        return Ok(HashMap::new());
    }
    let mut owners = HashMap::<String, usize>::new();
    for (_, path, title) in notes {
        for key in note_link_keys(path, title) {
            *owners.entry(key).or_default() += 1;
        }
    }
    let lookup = build_note_lookup(conn)?;
    let mut keys = HashMap::new();
    for (id, path, title) in notes {
        let Some(target) = targets.get(id) else {
            continue;
        };
        for key in note_link_keys(path, title) {
            if owners.get(&key) == Some(&1) && lookup.get(&key) == Some(id) {
                if let Some(replacement) = target.written_as(&key, id, owners_after) {
                    keys.insert(key, replacement);
                }
            }
        }
    }
    Ok(keys)
}

/// Markdown notes under `.amby/archive` (never its `.meta`, hidden folders or symlinks).
fn archived_notes(vault: &Path) -> Vec<PathBuf> {
    let root = crate::archive::archive_root(vault);
    let mut found = WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || !entry.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_markdown(entry.path()))
        .map(walkdir::DirEntry::into_path)
        .collect::<Vec<_>>();
    found.sort();
    found
}

/// Perform the disk-heavy part of an inbound link refactor without holding a
/// SQLite connection mutex.
pub fn build_inbound_wiki_rewrites(
    vault: &Path,
    _changes: &[crate::model::PathChange],
    inputs: InboundWikiRewriteInputs,
) -> Result<Vec<PlannedWikiRewrite>, String> {
    let mut by_source = HashMap::<PathBuf, Vec<(String, String)>>::new();
    for (source_rel, raw, replacement) in inputs.inbound_links {
        let original_path = vault.join(&source_rel);
        let readable_path = if original_path.is_file() {
            original_path
        } else {
            vault.join(inputs.moved_sources.get(&source_rel).unwrap_or(&source_rel))
        };
        if frontmatter::read_markdown(&readable_path)?.frontmatter_status
            == crate::model::FrontmatterStatus::Unterminated
        {
            continue;
        }
        let source_rel = inputs.moved_sources.get(&source_rel).unwrap_or(&source_rel);
        let source = vault.join(source_rel);
        let next = replace_wiki_target(&raw, &replacement);
        if raw != next {
            by_source.entry(source).or_default().push((raw, next));
        }
    }

    // Wikilinks of archived notes, read with the index's own parser (code, comments and
    // frontmatter are skipped), so they keep working after a restore.
    if !inputs.archive_targets.is_empty() {
        for source in archived_notes(vault) {
            let Ok(content) = fs::read_to_string(&source) else {
                continue;
            };
            let editable = if frontmatter::parse_markdown(&content)
                .frontmatter_status
                .is_malformed()
            {
                match frontmatter::split_frontmatter_envelope(&content) {
                    Some((_, body)) => body,
                    None => continue,
                }
            } else {
                content.as_str()
            };
            for (raw, target, _) in extract_links(editable) {
                if let Some(replacement) = inputs.archive_targets.get(&target) {
                    let next = replace_wiki_target(&raw, replacement);
                    if raw != next {
                        by_source
                            .entry(source.clone())
                            .or_default()
                            .push((raw, next));
                    }
                }
            }
        }
    }

    let mut literal_by_source = HashMap::<PathBuf, Vec<(String, String)>>::new();
    // Every literal form names the old path in full, so a file that does not contain it as text
    // cannot change. The files are read in parallel and only those that do are looked at.
    let candidates = files_mentioning_any(
        vault,
        inputs
            .literal_changes
            .iter()
            .map(|(old_rel, _)| old_rel.as_str())
            .collect(),
    );
    for (source, content) in candidates {
        let source = source.as_path();
        let editable = if is_markdown(source)
            && frontmatter::parse_markdown(&content)
                .frontmatter_status
                .is_malformed()
        {
            let Some((_, body)) = frontmatter::split_frontmatter_envelope(&content) else {
                continue;
            };
            body
        } else {
            content.as_str()
        };
        let rewritten_source = inputs
            .moved_absolute
            .get(source)
            .cloned()
            .unwrap_or_else(|| source.to_path_buf());
        for (old_rel, new_rel) in &inputs.literal_changes {
            // A quoted path is link syntax only in Canvas and sketch JSON; in Markdown it is
            // ordinary text (or a code sample) and stays as written.
            let quoted = matches!(
                source.extension().and_then(|ext| ext.to_str()),
                Some("canvas" | "excalidraw")
            )
            .then(|| (format!("\"{old_rel}\""), format!("\"{new_rel}\"")));
            for (old, new) in [
                (format!("]({old_rel})"), format!("]({new_rel})")),
                (format!("](/{old_rel})"), format!("](/{new_rel})")),
                (format!("]({old_rel}#"), format!("]({new_rel}#")),
                (format!("](/{old_rel}#"), format!("](/{new_rel}#")),
                (format!("]({old_rel}^"), format!("]({new_rel}^")),
                (format!("](/{old_rel}^"), format!("](/{new_rel}^")),
            ]
            .into_iter()
            .chain(quoted)
            {
                if editable.contains(&old) {
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

/// Whether a link refactor may enter the folder `relative` (path from the vault root). Only
/// normal folders and the archive (`<vault>/.amby/archive`, so links work after a restore)
/// qualify. Trash, backups, history, recovery, `.obsidian`, `.git`, every other hidden or
/// reserved folder and the archive's own `.meta` are never entered, so never rewritten.
fn refactor_may_enter(relative: &Path) -> bool {
    let Some(names) = relative
        .components()
        .map(|part| part.as_os_str().to_str())
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let normal = |names: &[&str]| {
        names
            .iter()
            .all(|name| !name.starts_with('.') && !is_reserved_directory(name))
    };
    match names.as_slice() {
        [] | [".amby"] => true,
        [".amby", "archive", rest @ ..] => normal(rest),
        [".amby", ..] => false,
        all => normal(all),
    }
}

/// The Markdown, canvas and sketch files of notes and the archive (see [`refactor_may_enter`])
/// whose text contains one of `needles`, with that text. Symlinks are never followed.
/// Unreadable files are skipped.
fn files_mentioning_any(vault: &Path, needles: Vec<&str>) -> Vec<(PathBuf, String)> {
    if needles.is_empty() {
        return Vec::new();
    }
    let files = WalkDir::new(vault)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir()
                || entry
                    .path()
                    .strip_prefix(vault)
                    .is_ok_and(refactor_may_enter)
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .filter(|source| {
            matches!(
                source.extension().and_then(|ext| ext.to_str()),
                Some("md" | "canvas" | "excalidraw")
            )
        })
        .collect::<Vec<_>>();
    let workers = std::thread::available_parallelism()
        .map_or(1, std::num::NonZeroUsize::get)
        .min(8);
    let chunk = files.len().div_ceil(workers).max(1);
    let mut found = std::thread::scope(|scope| {
        let handles = files
            .chunks(chunk)
            .map(|part| {
                let needles = &needles;
                scope.spawn(move || {
                    part.iter()
                        .filter_map(|source| {
                            let content = fs::read_to_string(source).ok()?;
                            needles
                                .iter()
                                .any(|needle| content.contains(needle))
                                .then(|| (source.clone(), content))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect::<Vec<_>>()
    });
    found.sort_by(|left, right| left.0.cmp(&right.0));
    found
}

/// `str::replace` that leaves code and comments alone (frontmatter links are still updated).
fn replace_outside_protected(text: &str, from: &str, to: &str) -> String {
    // Frontmatter is not protected here: relation properties are stored there as wikilinks and
    // a rename has always updated them. Only code and comments are left alone.
    let frontmatter_end = protected_markdown_ranges(text)
        .first()
        .filter(|(start, _)| *start == 0 && text.starts_with("---"))
        .map(|(_, end)| *end);
    let protected: Vec<_> = protected_markdown_ranges(text)
        .into_iter()
        .filter(|range| Some(range.1) != frontmatter_end || range.0 != 0)
        .collect();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, _) in text.match_indices(from) {
        if start < last || protected.iter().any(|(a, b)| start >= *a && start < *b) {
            continue;
        }
        out.push_str(&text[last..start]);
        out.push_str(to);
        last = start + from.len();
    }
    out.push_str(&text[last..]);
    out
}

pub(crate) fn render_rewrite(rewrite: &PlannedWikiRewrite, original: &str) -> Option<String> {
    let malformed = is_markdown(&rewrite.source_path)
        && frontmatter::parse_markdown(original)
            .frontmatter_status
            .is_malformed();
    let (envelope, editable) = if malformed {
        // With no closing fence, YAML/body boundaries are unknown. A link
        // refactor must not guess and modify possible YAML properties.
        let parts = frontmatter::split_frontmatter_envelope(original)?;
        parts
    } else {
        ("", original)
    };
    let mut next = editable.to_string();
    for (raw, replacement) in &rewrite.replacements {
        next =
            replace_outside_protected(&next, &format!("[[{raw}]]"), &format!("[[{replacement}]]"));
    }
    for (raw, replacement) in &rewrite.literal_replacements {
        next = next.replace(raw, replacement);
    }
    Some(format!("{envelope}{next}"))
}

pub fn apply_planned_wiki_rewrites(
    vault: &Path,
    plan: &[PlannedWikiRewrite],
) -> Result<Vec<PathBuf>, String> {
    let mut proposed = Vec::<(PathBuf, String, String)>::new();
    for rewrite in plan {
        let original =
            fs::read_to_string(&rewrite.source_path).map_err(|error| error.to_string())?;
        let Some(next) = render_rewrite(rewrite, &original) else {
            continue;
        };
        if next != original {
            proposed.push((rewrite.source_path.clone(), original, next));
        }
    }

    let mut applied = Vec::<(PathBuf, String)>::new();
    for (path, original, next) in proposed {
        let result = history::snapshot_before_write(vault, &path, next.as_bytes(), "link-refactor")
            .and_then(|_| frontmatter::atomic_write_bytes(&path, next.as_bytes()));
        if let Err(error) = result {
            for (applied_path, applied_original) in applied.into_iter().rev() {
                let _ = frontmatter::atomic_write_bytes(&applied_path, applied_original.as_bytes());
            }
            return Err(error);
        }
        applied.push((path, original));
    }
    Ok(applied.into_iter().map(|(path, _)| path).collect())
}

pub fn preview_refactor_links_for_rename(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<RefactorPreview, String> {
    let plan = plan_inbound_wiki_rewrites(conn, vault, changes)?;
    Ok(refactor_preview(&plan))
}

pub fn preview_refactor_links_for_move(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<RefactorPreview, String> {
    let plan = plan_inbound_wiki_rewrites(conn, vault, changes)?;
    Ok(refactor_preview(&plan))
}

pub fn refactor_links_for_rename(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<Vec<PathBuf>, String> {
    let plan = plan_inbound_wiki_rewrites(conn, vault, changes)?;
    apply_planned_wiki_rewrites(vault, &plan)
}

pub fn refactor_links_for_move(
    conn: &Connection,
    vault: &Path,
    changes: &[crate::model::PathChange],
) -> Result<Vec<PathBuf>, String> {
    let plan = plan_inbound_wiki_rewrites(conn, vault, changes)?;
    apply_planned_wiki_rewrites(vault, &plan)
}
