//! Which key of the header a property is (appendix З: З1, З24–З27), and the look of a property
//! (З45–З47): the template laid under the differences of the note.

use std::path::{Path, PathBuf};

use amby_sync_core::engine::props_groups::name_key;
use rusqlite::{Connection, OptionalExtension};
use unicode_normalization::UnicodeNormalization;

use super::{Diff, KeyMatch};
use crate::frontmatter::{self, HeaderKey, HeaderKeys};
use crate::property_template;

fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// A key of Amby, never a property (З24).
pub(super) fn is_reserved(key: &str) -> bool {
    key.trim().to_ascii_lowercase().starts_with("amby-")
}

fn find(keys: &[HeaderKey], name: &str) -> KeyMatch {
    let wanted = nfc(name);
    let usable: Vec<&HeaderKey> = keys.iter().filter(|k| !is_reserved(&k.key)).collect();
    let found = |key: &HeaderKey| KeyMatch::Found {
        key: key.key.clone(),
        value: key.value.clone(),
        complex: key.complex,
    };
    let exact: Vec<&&HeaderKey> = usable.iter().filter(|k| nfc(&k.key) == wanted).collect();
    match exact.as_slice() {
        [one] => return found(one),
        [] => {}
        many => {
            return KeyMatch::Ambiguous {
                keys: many.iter().map(|k| k.key.clone()).collect(),
            }
        }
    }
    let folded: Vec<&&HeaderKey> = usable
        .iter()
        .filter(|k| nfc(&k.key).eq_ignore_ascii_case(&wanted))
        .collect();
    match folded.as_slice() {
        [] => KeyMatch::Missing,
        [one] => found(one),
        many => KeyMatch::Ambiguous {
            keys: many.iter().map(|k| k.key.clone()).collect(),
        },
    }
}

/// Matches a name against the keys of a header: exact (after NFC), then the only match ignoring
/// ASCII case; `previous_name` only when `name` is absent (З1, З24, З29).
pub(super) fn resolve(keys: &[HeaderKey], name: &str, previous_name: Option<&str>) -> KeyMatch {
    if is_reserved(name) || name.trim().is_empty() {
        return KeyMatch::Missing;
    }
    match find(keys, name) {
        KeyMatch::Missing => match previous_name {
            Some(previous) if !is_reserved(previous) && !previous.trim().is_empty() => {
                find(keys, previous)
            }
            _ => KeyMatch::Missing,
        },
        other => other,
    }
}

/// Looks for the key of the property `name` in the header of `note_text` (З1): exact (after NFC),
/// then the only match ignoring ASCII case. Only keys that YAML reads as strings; `amby-*` keys
/// never (З24). `previous_name` is tried only when `name` is absent (З29).
pub fn match_key(note_text: &str, name: &str, previous_name: Option<&str>) -> KeyMatch {
    match frontmatter::header_keys(note_text) {
        HeaderKeys::Absent => KeyMatch::Missing,
        HeaderKeys::Unreadable => KeyMatch::HeaderUnreadable,
        HeaderKeys::Keys(keys) => resolve(&keys, name, previous_name),
    }
}

/// A note whose header can be trusted: it exists, has one `amby-id` that is its own, and a header
/// that reads (З12, З25).
pub(super) struct NoteAccess {
    pub path: PathBuf,
    pub text: String,
    pub keys: Vec<HeaderKey>,
}

/// Opens a note for the properties, or says why it cannot be trusted (З25): the header is
/// damaged, there is no id or the id is duplicated, the file is missing.
pub(super) fn open_note(
    conn: &Connection,
    vault: &Path,
    note_id: &str,
) -> Result<NoteAccess, String> {
    crate::index::identity::ensure_unique_identity(conn, note_id)?;
    let rel: Option<String> = conn
        .query_row("SELECT path FROM notes WHERE id = ?1", [note_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    let rel = rel.ok_or_else(|| format!("Note not found: {note_id}"))?;
    let path = vault.join(rel);
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed = frontmatter::parse_markdown(&text);
    if parsed.frontmatter_status.is_malformed() {
        return Err("Properties are unavailable while the header is malformed".to_string());
    }
    if parsed.identity_error.is_some() || parsed.id.as_deref() != Some(note_id) {
        return Err("The note has no usable amby-id".to_string());
    }
    match frontmatter::header_keys(&text) {
        HeaderKeys::Keys(keys) => Ok(NoteAccess { path, text, keys }),
        _ => Err("Properties are unavailable while the header is malformed".to_string()),
    }
}

// ----- the look of a property (З45–З47) -----

/// Type, icon and options of a property.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Look {
    pub property_type: String,
    pub icon: String,
    pub settings: String,
    pub from_template: bool,
}

/// What a name looks like with no record: the template or plain text without an icon (З45).
pub(super) fn base_look(name: &str) -> Look {
    match property_template::lookup(name) {
        Some(found) => Look {
            property_type: found.property_type,
            icon: found.icon,
            settings: found.settings,
            from_template: true,
        },
        None => Look {
            property_type: "text".to_string(),
            icon: String::new(),
            settings: String::new(),
            from_template: false,
        },
    }
}

/// The template laid under the differences of the note (З46).
pub(super) fn look_of(name: &str, diff: Option<&Diff>) -> Look {
    let mut look = base_look(name);
    if let Some(diff) = diff {
        if let Some(icon) = &diff.icon {
            look.icon = icon.clone();
        }
        if let Some(property_type) = &diff.property_type {
            look.property_type = property_type.clone();
        }
        if let Some(settings) = &diff.settings {
            look.settings = settings.clone();
        }
    }
    look
}

/// Puts `look` into `diff` as the differences from the template (or plain text) for `name`
/// (З47): a field equal to the base is not written.
pub(super) fn set_look(diff: &mut Diff, name: &str, look: &Look) {
    let base = base_look(name);
    diff.icon = (look.icon != base.icon).then(|| look.icon.clone());
    diff.property_type =
        (look.property_type != base.property_type).then(|| look.property_type.clone());
    diff.settings = (look.settings != base.settings).then(|| look.settings.clone());
}

/// Does the value fit the type (З26)? An empty value fits every type.
pub(super) fn fits_type(value: &str, property_type: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return true;
    }
    match property_type {
        "checkbox" => matches!(value.to_ascii_lowercase().as_str(), "true" | "false"),
        "number" => value.parse::<f64>().is_ok(),
        _ => true,
    }
}

/// Is a value of a select outside its options (З45)?
pub(super) fn outside_options(value: &str, property_type: &str, settings: &str) -> bool {
    property_type == "select"
        && !value.trim().is_empty()
        && !settings.trim().is_empty()
        && !settings
            .split(',')
            .any(|option| option.trim() == value.trim())
}

/// Is `name` usable as the name of a property (З24, З47)?
pub(super) fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Property name cannot be empty".to_string());
    }
    if is_reserved(name) {
        return Err("A property name cannot start with amby-".to_string());
    }
    if !frontmatter::is_safe_binding_key(name) {
        return Err("Property name has characters a header key cannot have".to_string());
    }
    Ok(())
}

/// The same name after NFC and without ASCII case (З47).
pub(super) fn same_name(a: &str, b: &str) -> bool {
    name_key(a) == name_key(b)
}

/// Icon, type and options of a record shown without a key, for the interface (З3).
pub fn look_for_view(name: &str, diff: &Diff) -> (String, String, String) {
    let look = look_of(name, Some(diff));
    (look.icon, look.property_type, look.settings)
}
