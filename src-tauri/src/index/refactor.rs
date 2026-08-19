use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::note_index::relative_path;
use crate::frontmatter;
use crate::history;
use crate::vault::scan::is_markdown;

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
