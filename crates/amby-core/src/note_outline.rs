//! The headings of a note and the text under one of them, so that an agent reads a long note by parts.
//!
//! ATX headings (`#` to `######`) count; lines inside fenced code blocks and the YAML header do not.
//! Line numbers are 1-based and count the whole file, header included.

use std::path::Path;

use serde_json::{json, Value};

use crate::frontmatter;
use crate::index::read_only::visible_note;

pub const MAX_HEADINGS: usize = 500;
pub const MAX_SECTION_BYTES: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq)]
struct Heading {
    level: usize,
    text: String,
    /// 0-based index of the heading line.
    line: usize,
}

fn heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let indent = trimmed.len() - trimmed.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &trimmed[indent..];
    let level = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !after.is_empty() && !after.starts_with([' ', '\t']) {
        return None;
    }
    // A closing run of `#` after a space is not part of the text.
    let text = after.trim();
    let text = match text.trim_end_matches('#') {
        stripped
            if stripped.len() < text.len()
                && (stripped.is_empty() || stripped.ends_with([' ', '\t'])) =>
        {
            stripped.trim_end()
        }
        _ => text,
    };
    Some((level, text.to_owned()))
}

fn fence(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let mark = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = trimmed.len() - trimmed.trim_start_matches(mark).len();
    (run >= 3).then_some((mark, run))
}

/// The lines of the source (each with its line break) and the index of the first body line.
fn lines(source: &str) -> (Vec<&str>, usize) {
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let body_start = frontmatter::split_frontmatter_envelope(source)
        .map_or(0, |(envelope, _)| envelope.matches('\n').count());
    (lines, body_start)
}

fn headings(lines: &[&str], body_start: usize) -> Vec<Heading> {
    let mut found = Vec::new();
    let mut open: Option<(char, usize)> = None;
    for (index, line) in lines.iter().enumerate().skip(body_start) {
        if let Some((mark, run)) = fence(line) {
            match open {
                None => open = Some((mark, run)),
                Some((open_mark, open_run))
                    if open_mark == mark
                        && run >= open_run
                        && line.trim().trim_start_matches(mark).is_empty() =>
                {
                    open = None
                }
                Some(_) => {}
            }
            continue;
        }
        if open.is_none() {
            if let Some((level, text)) = heading(line) {
                found.push(Heading {
                    level,
                    text,
                    line: index,
                });
            }
        }
    }
    found
}

fn source(root: &Path, relative: &str) -> Result<(String, String), &'static str> {
    let relative = relative.replace('\\', "/");
    let path = visible_note(root, &relative)?;
    let text = std::fs::read_to_string(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::InvalidData => "invalidEncoding",
        _ => "unavailable",
    })?;
    Ok((relative, text))
}

pub fn outline(root: &Path, relative: &str) -> Result<Value, &'static str> {
    let (relative, text) = source(root, relative)?;
    let (lines, body_start) = lines(&text);
    let found = headings(&lines, body_start);
    let total = found.len();
    let items: Vec<Value> = found
        .into_iter()
        .take(MAX_HEADINGS)
        .map(|h| json!({ "level": h.level, "text": h.text, "line": h.line + 1 }))
        .collect();
    Ok(json!({ "path": relative, "headings": items, "total": total, "lines": lines.len() }))
}

/// The heading line and everything under it up to the next heading of the same or a higher level.
/// The heading text is compared without case; `occurrence` (1-based) picks one of several equal
/// headings, which are otherwise refused as ambiguous.
pub fn section(
    root: &Path,
    relative: &str,
    wanted: &str,
    occurrence: Option<usize>,
) -> Result<Value, &'static str> {
    let (relative, text) = source(root, relative)?;
    let (lines, body_start) = lines(&text);
    let found = headings(&lines, body_start);
    let wanted = wanted.trim().trim_start_matches('#').trim().to_lowercase();
    let matches: Vec<usize> = found
        .iter()
        .enumerate()
        .filter(|(_, h)| h.text.to_lowercase() == wanted)
        .map(|(index, _)| index)
        .collect();
    let index = match (matches.len(), occurrence) {
        (0, _) => return Err("headingNotFound"),
        (_, Some(n)) => *matches
            .get(n.checked_sub(1).ok_or("invalidArguments")?)
            .ok_or("headingNotFound")?,
        (1, None) => matches[0],
        (_, None) => return Err("headingNotUnique"),
    };
    let start = &found[index];
    let end = found[index + 1..]
        .iter()
        .find(|h| h.level <= start.level)
        .map_or(lines.len(), |h| h.line);
    let content: String = lines[start.line..end].concat();
    if content.len() > MAX_SECTION_BYTES {
        return Err("resultTooLarge");
    }
    Ok(json!({
        "path": relative,
        "heading": start.text,
        "level": start.level,
        "startLine": start.line + 1,
        "endLine": end,
        "content": content,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOTE: &str = "---\ntitle: x\n---\n# Plan\nintro\n## Steps #\none\n```\n# not a heading\n```\n## Risks\nthree\n# Next\nlast\n";

    fn vault(text: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("amby-outline-{}", ulid::Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Note.md"), text).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn the_outline_skips_the_header_and_code_blocks() {
        let root = vault(NOTE);
        let result = outline(&root, "Note.md").unwrap();
        let texts: Vec<_> = result["headings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| {
                (
                    h["level"].as_u64().unwrap(),
                    h["text"].as_str().unwrap().to_owned(),
                    h["line"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                (1, "Plan".to_owned(), 4),
                (2, "Steps".to_owned(), 6),
                (2, "Risks".to_owned(), 11),
                (1, "Next".to_owned(), 13)
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_section_runs_to_the_next_heading_of_its_level() {
        let root = vault(NOTE);
        let steps = section(&root, "Note.md", "steps", None).unwrap();
        assert_eq!(
            steps["content"],
            "## Steps #\none\n```\n# not a heading\n```\n"
        );
        let plan = section(&root, "Note.md", "# Plan", None).unwrap();
        assert_eq!(plan["endLine"], 12);
        assert!(plan["content"].as_str().unwrap().ends_with("three\n"));
        assert_eq!(
            section(&root, "Note.md", "Missing", None),
            Err("headingNotFound")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn equal_headings_need_an_occurrence() {
        let root = vault("## A\n1\n## A\n2\n");
        assert_eq!(
            section(&root, "Note.md", "A", None),
            Err("headingNotUnique")
        );
        assert_eq!(
            section(&root, "Note.md", "A", Some(2)).unwrap()["content"],
            "## A\n2\n"
        );
        assert_eq!(
            section(&root, "Note.md", "A", Some(3)),
            Err("headingNotFound")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn heading_lines_follow_commonmark_basics() {
        assert_eq!(heading("#Tag"), None);
        assert_eq!(heading("    # code"), None);
        assert_eq!(heading("####### seven"), None);
        assert_eq!(heading("### C# notes"), Some((3, "C# notes".to_owned())));
        assert_eq!(heading("## Title ##\r\n"), Some((2, "Title".to_owned())));
        assert_eq!(heading("#"), Some((1, String::new())));
    }
}
