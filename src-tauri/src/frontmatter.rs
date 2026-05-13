use serde_yaml::{Mapping, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub id: Option<String>,
    pub body: String,
    pub has_frontmatter: bool,
    pub yaml_is_map: bool,
    pub parse_error: Option<String>,
}

fn split_frontmatter(content: &str) -> Option<(&str, &str)> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let yaml = &rest[..end];
    let after = &rest[end + "\n---".len()..];
    let body = after.strip_prefix('\n').unwrap_or(after);
    Some((yaml, body))
}

pub fn parse_markdown(content: &str) -> ParsedMarkdown {
    let Some((yaml, body)) = split_frontmatter(content) else {
        return ParsedMarkdown {
            id: None,
            body: content.to_string(),
            has_frontmatter: false,
            yaml_is_map: true,
            parse_error: None,
        };
    };

    match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Mapping(map)) => ParsedMarkdown {
            id: map
                .get(Value::String("id".to_string()))
                .and_then(Value::as_str)
                .map(str::to_string),
            body: body.to_string(),
            has_frontmatter: true,
            yaml_is_map: true,
            parse_error: None,
        },
        Ok(_) => ParsedMarkdown {
            id: None,
            body: body.to_string(),
            has_frontmatter: true,
            yaml_is_map: false,
            parse_error: None,
        },
        Err(err) => ParsedMarkdown {
            id: None,
            body: body.to_string(),
            has_frontmatter: true,
            yaml_is_map: false,
            parse_error: Some(err.to_string()),
        },
    }
}

pub fn read_markdown(path: &Path) -> Result<ParsedMarkdown, String> {
    fs::read_to_string(path)
        .map(|content| parse_markdown(&content))
        .map_err(|e| e.to_string())
}

pub fn body_with_id(content: &str, id: &str) -> Result<String, String> {
    let parsed = parse_markdown(content);
    if parsed.has_frontmatter && !parsed.yaml_is_map {
        return Err("Cannot update malformed or non-map frontmatter".to_string());
    }

    if let Some((yaml, body)) = split_frontmatter(content) {
        let mut map = serde_yaml::from_str::<Mapping>(yaml).map_err(|e| e.to_string())?;
        map.insert(Value::String("id".to_string()), Value::String(id.to_string()));
        let yaml = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
        Ok(format!("---\n{}---\n{}", yaml, body))
    } else {
        Ok(format!("---\nid: {}\n---\n{}", id, content))
    }
}

pub fn replace_body_preserving_id(content: &str, body: &str, id: &str) -> Result<String, String> {
    let parsed = parse_markdown(content);
    if parsed.has_frontmatter && !parsed.yaml_is_map {
        return Err("Cannot update malformed or non-map frontmatter".to_string());
    }

    if let Some((yaml, _)) = split_frontmatter(content) {
        let mut map = serde_yaml::from_str::<Mapping>(yaml).map_err(|e| e.to_string())?;
        map.insert(Value::String("id".to_string()), Value::String(id.to_string()));
        let yaml = serde_yaml::to_string(&map).map_err(|e| e.to_string())?;
        Ok(format!("---\n{}---\n{}", yaml, body))
    } else {
        Ok(format!("---\nid: {}\n---\n{}", id, body))
    }
}

pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.to_string_lossy()))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut tmp: PathBuf = path.to_path_buf();
    let ext = path
        .extension()
        .map(|e| format!("{}.amby-tmp", e.to_string_lossy()))
        .unwrap_or_else(|| "amby-tmp".to_string());
    tmp.set_extension(ext);
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_existing_id_and_body() {
        let parsed = parse_markdown("---\nid: 01ABC\n---\nHello");
        assert_eq!(parsed.id.as_deref(), Some("01ABC"));
        assert_eq!(parsed.body, "Hello");
    }

    #[test]
    fn inserts_id_without_frontmatter() {
        let content = body_with_id("Hello", "01ABC").unwrap();
        assert!(content.starts_with("---\nid: 01ABC\n---\n"));
        assert!(content.ends_with("Hello"));
    }
}
