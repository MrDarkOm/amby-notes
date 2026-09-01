use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

use super::note_index::IndexedNote;
use crate::vault::scan::{abs_from_rel, path_string};

#[derive(Serialize, Clone, Debug, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub tag: String,
    pub notes: Vec<IndexedNote>,
}

pub fn is_tag_character(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '-' | '/')
}

pub fn is_valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && !tag.starts_with('/')
        && !tag.ends_with('/')
        && !tag.contains("//")
        && tag.chars().all(is_tag_character)
        && tag
            .chars()
            .any(|character| character.is_alphabetic() || matches!(character, '_' | '-'))
}

fn is_hex_color(tag: &str) -> bool {
    matches!(tag.len(), 3 | 4 | 6 | 8)
        && tag.chars().all(|character| character.is_ascii_hexdigit())
}

pub fn extract_tags(content: &str, frontmatter_tags: &[String]) -> Vec<String> {
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

        // Obsidian tags start at a whitespace (or the beginning of a line).
        // Treating every punctuation mark as a boundary also picked up URL
        // fragments (`](#section)`) and CSS colours (`color: #fff`).
        let prev_is_boundary = i == 0 || chars[i - 1].is_whitespace();
        if prev_is_boundary && chars[i] == '#' && i + 1 < chars.len() {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && is_tag_character(chars[end]) {
                end += 1;
            }
            let tag = chars[start..end].iter().collect::<String>();
            if is_valid_tag(&tag) && !is_hex_color(&tag) {
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

#[cfg(test)]
mod tests {
    use super::extract_tags;

    #[test]
    fn ignores_link_fragments_and_hex_colours() {
        let body = "See [section](#details) and color: #fff, but keep #project and #work/items";
        assert_eq!(
            extract_tags(body, &[]),
            vec!["project".to_string(), "work/items".to_string()]
        );
    }
}
