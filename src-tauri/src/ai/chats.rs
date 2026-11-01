//! Durable, vault-local AI conversations. Unknown formats are never rewritten.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_CHAT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatContext {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatStep {
    pub tool: String,
    pub query: String,
    pub note_ids: Vec<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatSource {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub steps: Vec<ChatStep>,
    pub sources: Vec<ChatSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chat {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub model_id: String,
    pub search_enabled: bool,
    pub auto_current: bool,
    pub context: Vec<ChatContext>,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadedChat {
    pub chat: Option<Chat>,
    pub raw: Option<serde_json::Value>,
    pub status: String,
    pub revision: String,
}

fn valid_id(id: &str) -> bool {
    id.parse::<ulid::Ulid>()
        .is_ok_and(|value| value.to_string() == id)
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn relative(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("Invalid chat identifier".into());
    }
    Ok(format!(".amby/ai/chats/{id}.json"))
}

fn path(root: &Path, id: &str) -> Result<PathBuf, String> {
    crate::paths::confine_rel_no_symlinks(root, &relative(id)?)
}

pub(super) fn ensure_dir(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let std::path::Component::Normal(name) = component else {
            return Err("Invalid directory".into());
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("Unsafe AI storage directory".into());
        }
    }
    Ok(current)
}

fn read_bytes(root: &Path, id: &str) -> Result<Vec<u8>, String> {
    let file = path(root, id)?;
    let metadata = fs::symlink_metadata(&file).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_CHAT_BYTES as u64 {
        return Err("Chat file unavailable".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(file)
        .map_err(|error| error.to_string())?
        .take((MAX_CHAT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_CHAT_BYTES {
        return Err("Chat file unavailable".into());
    }
    Ok(bytes)
}

fn classify(id: &str, bytes: &[u8]) -> LoadedChat {
    let revision = revision(bytes);
    let value = match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => value,
        Err(_) => {
            return LoadedChat {
                chat: None,
                raw: None,
                status: "corrupt".into(),
                revision,
            }
        }
    };
    let Some(version) = value.get("version").and_then(|v| v.as_u64()) else {
        return LoadedChat {
            chat: None,
            raw: None,
            status: "corrupt".into(),
            revision,
        };
    };
    if version != 1 {
        return LoadedChat {
            chat: None,
            raw: Some(value),
            status: "readOnly".into(),
            revision,
        };
    }
    match serde_json::from_value::<Chat>(value.clone()) {
        Ok(chat) if chat.id == id && chat.version == 1 => LoadedChat {
            chat: Some(chat),
            raw: None,
            status: "ready".into(),
            revision,
        },
        Err(error) if error.to_string().starts_with("unknown field") => LoadedChat {
            chat: None,
            raw: Some(value),
            status: "readOnly".into(),
            revision,
        },
        _ => LoadedChat {
            chat: None,
            raw: None,
            status: "corrupt".into(),
            revision,
        },
    }
}

pub fn load(root: &Path, id: &str) -> Result<LoadedChat, String> {
    Ok(classify(id, &read_bytes(root, id)?))
}

pub fn list(root: &Path) -> Result<Vec<ChatEntry>, String> {
    let directory = crate::paths::confine_rel_no_symlinks(root, ".amby/ai/chats")?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json").filter(|id| valid_id(id)) else {
            continue;
        };
        let loaded = match load(root, id) {
            Ok(value) => value,
            Err(_) => LoadedChat {
                chat: None,
                raw: None,
                status: "corrupt".into(),
                revision: String::new(),
            },
        };
        result.push(ChatEntry {
            id: id.into(),
            title: loaded
                .chat
                .as_ref()
                .map(|chat| chat.title.clone())
                .or_else(|| {
                    loaded
                        .raw
                        .as_ref()?
                        .get("title")?
                        .as_str()
                        .map(|title| title.chars().take(200).collect())
                }),
            updated_at: loaded
                .chat
                .as_ref()
                .map(|chat| chat.updated_at.clone())
                .or_else(|| {
                    loaded
                        .raw
                        .as_ref()?
                        .get("updatedAt")?
                        .as_str()
                        .map(|date| date.chars().take(64).collect())
                }),
            status: loaded.status,
        });
    }
    result.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(result)
}

pub fn save(root: &Path, chat: &Chat, expected: Option<&str>) -> Result<String, String> {
    if chat.version != 1 {
        return Err("Unsupported chat version".into());
    }
    let file = path(root, &chat.id)?;
    let bytes = serde_json::to_vec(chat).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_CHAT_BYTES {
        return Err("Chat exceeds size limit".into());
    }
    ensure_dir(root, ".amby/ai/chats")?;
    match expected {
        None => crate::frontmatter::atomic_write_bytes_new(&file, &bytes)
            .map_err(|error| format!("{error:?}"))?,
        Some(expected) => {
            let old = read_bytes(root, &chat.id)?;
            if revision(&old) != expected {
                return Err("Chat changed externally".into());
            }
            if classify(&chat.id, &old).chat.is_none() {
                return Err("Chat is read-only".into());
            }
            crate::frontmatter::atomic_write_bytes(&file, &bytes)?;
        }
    }
    Ok(revision(&bytes))
}

pub fn trash(root: &Path, id: &str, expected: &str) -> Result<(), String> {
    let bytes = read_bytes(root, id)?;
    if revision(&bytes) != expected {
        return Err("Chat changed externally".into());
    }
    ensure_dir(root, ".amby/trash")?;
    crate::recycle_bin::move_exact_to_trash(root, &path(root, id)?)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, Chat) {
        let root = std::env::temp_dir().join(format!("amby-ai-chats-{}", ulid::Ulid::generate()));
        fs::create_dir(&root).unwrap();
        let chat = Chat {
            version: 1,
            id: ulid::Ulid::generate().to_string(),
            title: "Hello".into(),
            created_at: "2026-10-30T00:00:00Z".into(),
            updated_at: "2026-10-30T00:00:00Z".into(),
            model_id: "model".into(),
            search_enabled: false,
            auto_current: true,
            context: vec![],
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hello".into(),
                steps: vec![],
                sources: vec![],
            }],
        };
        (root, chat)
    }

    #[test]
    fn ai1_h1_h2_h4_save_conflict_and_restore() {
        let (root, mut chat) = fixture();
        assert!(list(&root).unwrap().is_empty());
        let first = save(&root, &chat, None).unwrap();
        assert_eq!(load(&root, &chat.id).unwrap().chat.unwrap().title, "Hello");
        assert!(save(&root, &chat, None).is_err());
        chat.title = "Changed".into();
        assert!(save(&root, &chat, Some("stale")).is_err());
        let second = save(&root, &chat, Some(&first)).unwrap();
        assert!(trash(&root, &chat.id, &first).is_err());
        trash(&root, &chat.id, &second).unwrap();
        assert!(list(&root).unwrap().is_empty());
        let entries = crate::recycle_bin::list(&root);
        assert_eq!(entries.len(), 1);
        crate::recycle_bin::restore(&root, &entries[0].id).unwrap();
        assert_eq!(
            load(&root, &chat.id).unwrap().chat.unwrap().title,
            "Changed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai1_h2_h3_unknown_and_corrupt_files_are_never_rewritten() {
        let (root, chat) = fixture();
        save(&root, &chat, None).unwrap();
        let file = path(&root, &chat.id).unwrap();
        for bytes in [
            br#"{broken"#.as_slice(),
            br#"{"version":2,"title":"future"}"#.as_slice(),
            br#"{"version":1,"extra":true}"#.as_slice(),
        ] {
            fs::write(&file, bytes).unwrap();
            let loaded = load(&root, &chat.id).unwrap();
            assert_ne!(loaded.status, "ready");
            assert!(save(&root, &chat, Some(&loaded.revision)).is_err());
            assert_eq!(fs::read(&file).unwrap(), bytes);
            assert_eq!(list(&root).unwrap().len(), 1);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai1_h3_nested_unknown_fields_are_read_only() {
        let (root, chat) = fixture();
        save(&root, &chat, None).unwrap();
        let file = path(&root, &chat.id).unwrap();
        let mut value = serde_json::to_value(&chat).unwrap();
        value["messages"][0]["futureField"] = serde_json::json!("preserve me");
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(&file, &bytes).unwrap();
        let loaded = load(&root, &chat.id).unwrap();
        assert_eq!(loaded.status, "readOnly");
        assert_eq!(loaded.raw, Some(value));
        assert!(save(&root, &chat, Some(&loaded.revision)).is_err());
        assert_eq!(fs::read(file).unwrap(), bytes);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ai1_h2_refuses_symlinked_storage() {
        let (root, chat) = fixture();
        let outside =
            std::env::temp_dir().join(format!("amby-ai-outside-{}", ulid::Ulid::generate()));
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".amby")).unwrap();
        assert!(save(&root, &chat, None).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
