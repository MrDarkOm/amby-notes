//! Merge of the note-properties groups `.amby/properties/prop_<x>.jsonl` and the marks of old
//! versions `legacy_<x>.jsonl` (docs/sync-plan.md, appendix З: З14–З17, З30–З33, З45–З53).
//! A file is JSON Lines: a first line `{"version":1}`, then one line per note, sorted by `id`. The
//! unit of the merge is the line of a note, by the meaning of the JSON and not by its bytes; a line
//! that one side did not change is carried over with its own bytes (З52).

use std::collections::{BTreeMap, BTreeSet};

use serde::de::{Deserializer, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use super::rules::mass_change_reached;

/// The largest version of a group the merge accepts, in bytes (decimal) (З30).
pub const PROPS_MERGE_MAX_BYTES: usize = 16_000_000;

/// The deepest nesting of an unknown value the merge accepts (З30).
pub const PROPS_MAX_DEPTH: usize = 32;

/// Number of groups of the layout version 1 (З48).
pub const GROUP_COUNT: usize = 16;

/// Fewest vanishing properties of a pass that stop it (З32, пороги Д54), with 10% of all.
pub const PROPS_LOSS_MIN: usize = 20;

/// Percentage of all properties of the device that stops a pass with [`PROPS_LOSS_MIN`] (З32).
pub const PROPS_LOSS_PERCENT: usize = 10;

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The group of a note: the first hexadecimal digit (lowercase) of BLAKE3 of the `amby-id` as
/// UTF-8 (З48). `"a"`, not the start of the ULID.
pub fn group_of(amby_id: &str) -> String {
    format!("{:x}", blake3::hash(amby_id.as_bytes()).as_bytes()[0] >> 4)
}

/// The vault-relative path of the file of a note: `.amby/properties/prop_<x>.jsonl` (З48).
pub fn group_path_of(amby_id: &str) -> String {
    format!(".amby/properties/prop_{}.jsonl", group_of(amby_id))
}

/// The vault-relative path of the marks of a note: `.amby/properties/legacy_<x>.jsonl` (З53).
pub fn legacy_path_of(amby_id: &str) -> String {
    format!(".amby/properties/legacy_{}.jsonl", group_of(amby_id))
}

/// The two kinds of mergeable files (З52, З53).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind {
    /// `prop_<x>.jsonl`: lines `{"id","hint","props","order","dismissedRenames"}` (З47).
    Props,
    /// `legacy_<x>.jsonl`: lines `{"id","entry","record"}` (З53).
    Legacy,
}

/// The kind of a path the merge applies to: exactly `.amby/properties/prop_<0–f>.jsonl` or
/// `legacy_<0–f>.jsonl` (З52, З53); `None` for `layout.json` and everything else, which are
/// synchronised but not merged.
pub fn kind_of_path(path: &str) -> Option<GroupKind> {
    let name = path.strip_prefix(".amby/properties/")?;
    let (kind, rest) = match name.strip_prefix("prop_") {
        Some(rest) => (GroupKind::Props, rest),
        None => (GroupKind::Legacy, name.strip_prefix("legacy_")?),
    };
    let digit = rest.strip_suffix(".jsonl")?;
    let mut chars = digit.chars();
    match (chars.next(), chars.next()) {
        (Some('0'..='9' | 'a'..='f'), None) => Some(kind),
        _ => None,
    }
}

/// Why a version of a group is not merged but goes to a conflict set (З30).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotMergeable {
    /// A version is not valid UTF-8.
    NotUtf8,
    /// A version contains a `0x00` byte.
    HasNul,
    /// A version is larger than [`PROPS_MERGE_MAX_BYTES`].
    TooLarge,
    /// The first line is missing, is not a JSON object, or has `version` other than 1.
    BadHeaderLine,
    /// A line does not parse, is not an object, has no `id`, or breaks the shape of З47 / З53
    /// (names not unique after NFC without ASCII case, a known field of the wrong type).
    BadLine,
    /// A key repeats in some object, at any level.
    DuplicateKey,
    /// An `id` repeats in the file.
    DuplicateId,
    /// The lines are not sorted by `id`, byte by byte.
    Unsorted,
    /// An unknown value is nested deeper than [`PROPS_MAX_DEPTH`].
    TooDeep,
}

/// A conflict of a group (З16, З17): the notes whose records the sides changed differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupConflict {
    /// `amby-id` of every conflicting note, ascending. Empty when only an unknown top-level field
    /// conflicts.
    pub notes: Vec<String>,
    /// How many records the merge settled by itself (taken from the only side that changed them).
    pub auto_merged: usize,
}

/// The answer of [`merge_group`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupMergeOutcome {
    /// Every change of both sides, in the canonical form of З8, with the BOM and line ending by
    /// the rules of Ж14. Short paths return the bytes of a side unchanged (З30, Ж11).
    Clean(Vec<u8>),
    /// All or nothing (З17): nothing is written, a conflict set is made.
    Conflict(GroupConflict),
    /// The versions cannot be merged at all (З30).
    NotMergeable(NotMergeable),
}

// ----- strict parsing (З30, З51) -----

/// A JSON value that refuses a repeated key at any level.
struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Strict, E> {
                Ok(Strict(Value::from(v)))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Strict, E> {
                Ok(Strict(Value::from(v)))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Strict, E> {
                Ok(Strict(Value::from(v)))
            }
            fn visit_str<E>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(Value::String(v.to_string())))
            }
            fn visit_string<E>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(Value::String(v)))
            }
            fn visit_unit<E>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_none<E>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Strict, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Strict>()? {
                    items.push(item.0);
                }
                Ok(Strict(Value::Array(items)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Strict, A::Error> {
                let mut out = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if out.contains_key(&key) {
                        return Err(A::Error::custom("duplicate key"));
                    }
                    let value = map.next_value::<Strict>()?;
                    out.insert(key, value.0);
                }
                Ok(Strict(Value::Object(out)))
            }
        }
        deserializer.deserialize_any(V)
    }
}

fn parse_value(text: &str, otherwise: NotMergeable) -> Result<Value, NotMergeable> {
    match serde_json::from_str::<Strict>(text) {
        Ok(Strict(value)) => Ok(value),
        Err(error) => {
            let message = error.to_string();
            Err(if message.contains("duplicate key") {
                NotMergeable::DuplicateKey
            } else if message.contains("recursion limit") {
                NotMergeable::TooDeep
            } else {
                otherwise
            })
        }
    }
}

fn depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(depth).max().unwrap_or(0),
        Value::Object(map) => 1 + map.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// Unknown fields of an object may not nest deeper than [`PROPS_MAX_DEPTH`].
fn unknown_depth_ok(map: &Map<String, Value>, known: &[&str]) -> Result<(), NotMergeable> {
    for (key, value) in map {
        if !known.contains(&key.as_str()) && depth(value) > PROPS_MAX_DEPTH {
            return Err(NotMergeable::TooDeep);
        }
    }
    Ok(())
}

fn string_field(map: &Map<String, Value>, key: &str) -> Result<(), NotMergeable> {
    match map.get(key) {
        None | Some(Value::String(_)) => Ok(()),
        Some(_) => Err(NotMergeable::BadLine),
    }
}

/// The name of a property for the uniqueness check: NFC, ASCII case folded (З24, З47).
pub fn name_key(name: &str) -> String {
    name.nfc().collect::<String>().to_ascii_lowercase()
}

fn validate_line(kind: GroupKind, line: &Map<String, Value>) -> Result<(), NotMergeable> {
    match line.get("id") {
        Some(Value::String(id)) if !id.is_empty() => {}
        _ => return Err(NotMergeable::BadLine),
    }
    match kind {
        GroupKind::Legacy => {
            for key in ["entry", "record"] {
                if !matches!(line.get(key), Some(Value::String(_))) {
                    return Err(NotMergeable::BadLine);
                }
            }
            if line.contains_key("props") || line.contains_key("hint") {
                return Err(NotMergeable::BadLine);
            }
            unknown_depth_ok(line, &["id", "entry", "record"])
        }
        GroupKind::Props => {
            if line.contains_key("entry") || line.contains_key("record") {
                return Err(NotMergeable::BadLine);
            }
            match line.get("hint") {
                None => {}
                Some(Value::Object(hint)) => {
                    string_field(hint, "path")?;
                    unknown_depth_ok(hint, &["path"])?;
                }
                Some(_) => return Err(NotMergeable::BadLine),
            }
            match line.get("props") {
                None => {}
                Some(Value::Object(props)) => {
                    let mut seen = BTreeSet::new();
                    for (name, diff) in props {
                        let Value::Object(diff) = diff else {
                            return Err(NotMergeable::BadLine);
                        };
                        if !seen.insert(name_key(name)) {
                            return Err(NotMergeable::BadLine);
                        }
                        for key in ["icon", "propertyType", "settings", "previousName"] {
                            string_field(diff, key)?;
                        }
                        unknown_depth_ok(
                            diff,
                            &["icon", "propertyType", "settings", "previousName"],
                        )?;
                    }
                }
                Some(_) => return Err(NotMergeable::BadLine),
            }
            match line.get("order") {
                None => {}
                Some(Value::Array(items)) if items.iter().all(Value::is_string) => {}
                Some(_) => return Err(NotMergeable::BadLine),
            }
            match line.get("dismissedRenames") {
                None => {}
                Some(Value::Array(pairs)) => {
                    for pair in pairs {
                        match pair {
                            Value::Array(two)
                                if two.len() == 2 && two.iter().all(Value::is_string) => {}
                            _ => return Err(NotMergeable::BadLine),
                        }
                    }
                }
                Some(_) => return Err(NotMergeable::BadLine),
            }
            unknown_depth_ok(line, &["id", "hint", "props", "order", "dismissedRenames"])
        }
    }
}

/// One line of a note: its own text and its value.
#[derive(Debug, Clone)]
struct Line {
    text: String,
    value: Map<String, Value>,
}

/// A parsed file.
#[derive(Debug, Clone)]
struct Parsed {
    bom: bool,
    crlf: bool,
    /// The first line without `version`.
    header: Map<String, Value>,
    /// The first line as written (without the line ending).
    first: String,
    lines: BTreeMap<String, Line>,
}

fn parse(kind: GroupKind, bytes: &[u8]) -> Result<Parsed, NotMergeable> {
    if bytes.len() > PROPS_MERGE_MAX_BYTES {
        return Err(NotMergeable::TooLarge);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| NotMergeable::NotUtf8)?;
    if bytes.contains(&0) {
        return Err(NotMergeable::HasNul);
    }
    let (bom, text) = match text.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let crlf = text
        .find('\n')
        .is_some_and(|at| at > 0 && text.as_bytes()[at - 1] == b'\r');
    let mut segments: Vec<&str> = text.split('\n').collect();
    if segments.last() == Some(&"") {
        segments.pop();
    }
    let mut segments = segments
        .into_iter()
        .map(|s| s.strip_suffix('\r').unwrap_or(s));
    let first = segments.next().ok_or(NotMergeable::BadHeaderLine)?;
    let Value::Object(mut header) = parse_value(first, NotMergeable::BadHeaderLine)? else {
        return Err(NotMergeable::BadHeaderLine);
    };
    if header.remove("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err(NotMergeable::BadHeaderLine);
    }
    if header.values().any(|v| depth(v) > PROPS_MAX_DEPTH) {
        return Err(NotMergeable::TooDeep);
    }
    let mut lines = BTreeMap::new();
    let mut previous: Option<String> = None;
    for segment in segments {
        let Value::Object(value) = parse_value(segment, NotMergeable::BadLine)? else {
            return Err(NotMergeable::BadLine);
        };
        validate_line(kind, &value)?;
        let id = value["id"].as_str().unwrap_or_default().to_string();
        if lines.contains_key(&id) {
            return Err(NotMergeable::DuplicateId);
        }
        if previous.as_deref().is_some_and(|p| p > id.as_str()) {
            return Err(NotMergeable::Unsorted);
        }
        previous = Some(id.clone());
        lines.insert(
            id,
            Line {
                text: segment.to_string(),
                value,
            },
        );
    }
    Ok(Parsed {
        bom,
        crlf,
        header,
        first: first.to_string(),
        lines,
    })
}

/// Parses and checks one line of a group file on its own (З51): the strict parse, the shape of
/// З47 / З53. The order of the lines and the uniqueness of the `id` are the business of the file.
pub fn parse_line(kind: GroupKind, text: &str) -> Result<Map<String, Value>, NotMergeable> {
    let Value::Object(value) = parse_value(text, NotMergeable::BadLine)? else {
        return Err(NotMergeable::BadLine);
    };
    validate_line(kind, &value)?;
    Ok(value)
}

/// The admission check of З30 and З51 for one version of a file, as a whole: any damaged line is
/// a reason.
pub fn check_group(kind: GroupKind, bytes: &[u8]) -> Result<(), NotMergeable> {
    parse(kind, bytes).map(|_| ())
}

// ----- canonical form (З49) -----

fn write_canon(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (n, key) in keys.into_iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_canon(&map[key.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                write_canon(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

/// The canonical text of a JSON value (З49): compact, keys ascending byte by byte.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canon(value, &mut out);
    out
}

fn header_text(header: &Map<String, Value>) -> String {
    let mut map = header.clone();
    map.insert("version".to_string(), Value::from(1));
    canonical_json(&Value::Object(map))
}

fn assemble(bom: bool, crlf: bool, header: &str, lines: &[String]) -> Vec<u8> {
    let eol = if crlf { "\r\n" } else { "\n" };
    let mut out = Vec::new();
    if bom {
        out.extend_from_slice(BOM);
    }
    out.extend_from_slice(header.as_bytes());
    out.extend_from_slice(eol.as_bytes());
    for line in lines {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(eol.as_bytes());
    }
    out
}

/// The canonical form of a file (З49): every line compact JSON, keys ascending byte by byte, a line
/// feed at the end of each line; lines sorted by `id`; BOM and line endings of `bytes` stay.
/// Idempotent. Fails like [`check_group`].
pub fn canonicalize_group(kind: GroupKind, bytes: &[u8]) -> Result<Vec<u8>, NotMergeable> {
    let parsed = parse(kind, bytes)?;
    let lines: Vec<String> = parsed
        .lines
        .values()
        .map(|l| canonical_json(&Value::Object(l.value.clone())))
        .collect();
    Ok(assemble(
        parsed.bom,
        parsed.crlf,
        &header_text(&parsed.header),
        &lines,
    ))
}

// ----- the merge (З16, З31, З52) -----

/// The value of a line without what takes no part in a decision (З31).
fn core_of(kind: GroupKind, line: &Map<String, Value>) -> Map<String, Value> {
    let mut core = line.clone();
    if kind == GroupKind::Props {
        core.remove("hint");
        core.remove("dismissedRenames");
    }
    core
}

fn same_meaning(a: &Parsed, b: &Parsed) -> bool {
    a.header == b.header
        && a.lines.len() == b.lines.len()
        && a.lines
            .iter()
            .zip(b.lines.iter())
            .all(|((ka, la), (kb, lb))| ka == kb && la.value == lb.value)
}

fn merge_hint(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> Option<Value> {
    if local == remote {
        return local.cloned();
    }
    if local == base {
        return remote.cloned();
    }
    if remote == base {
        return local.cloned();
    }
    match (local, remote) {
        (Some(l), Some(r)) => Some(if canonical_json(l) <= canonical_json(r) {
            l.clone()
        } else {
            r.clone()
        }),
        (Some(l), None) => Some(l.clone()),
        (None, Some(r)) => Some(r.clone()),
        (None, None) => None,
    }
}

fn pairs_of(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(canonical_json).collect())
        .unwrap_or_default()
}

fn merge_pairs(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> Option<Value> {
    let (b, l, r) = (pairs_of(base), pairs_of(local), pairs_of(remote));
    let mut out: BTreeSet<String> = l.intersection(&r).cloned().collect();
    out.extend(l.difference(&b).cloned());
    out.extend(r.difference(&b).cloned());
    if out.is_empty() {
        return None;
    }
    Some(Value::Array(
        out.iter()
            .filter_map(|text| serde_json::from_str(text).ok())
            .collect(),
    ))
}

/// Takes the line `chosen` (the side that holds the decision) and gives it the merged `hint` and
/// `dismissedRenames`; the text of the side is kept when nothing changes.
fn with_aux(
    kind: GroupKind,
    chosen: &Line,
    base: Option<&Line>,
    local: Option<&Line>,
    remote: Option<&Line>,
) -> String {
    if kind == GroupKind::Legacy {
        return text_of(&chosen.value, base, local, remote);
    }
    let field = |line: Option<&Line>, key: &str| line.and_then(|l| l.value.get(key).cloned());
    let (bh, lh, rh) = (
        field(base, "hint"),
        field(local, "hint"),
        field(remote, "hint"),
    );
    let (bd, ld, rd) = (
        field(base, "dismissedRenames"),
        field(local, "dismissedRenames"),
        field(remote, "dismissedRenames"),
    );
    let hint = merge_hint(bh.as_ref(), lh.as_ref(), rh.as_ref());
    let dismissed = merge_pairs(bd.as_ref(), ld.as_ref(), rd.as_ref());
    let mut value = chosen.value.clone();
    value.remove("hint");
    value.remove("dismissedRenames");
    if let Some(hint) = hint {
        value.insert("hint".to_string(), hint);
    }
    if let Some(dismissed) = dismissed {
        value.insert("dismissedRenames".to_string(), dismissed);
    }
    text_of(&value, base, local, remote)
}

/// The text of a line whose value is `value`: a canonical text when one of the versions has it
/// (so an untouched line costs the next writer nothing), else the bytes of the base, else those
/// of a side (the smaller text when both have the value, so swapping the sides changes nothing);
/// a value nobody has is written in the canonical form.
fn text_of(
    value: &Map<String, Value>,
    base: Option<&Line>,
    local: Option<&Line>,
    remote: Option<&Line>,
) -> String {
    if let (Some(l), Some(r)) = (local, remote) {
        if &l.value == value && &r.value == value {
            let base_text = base.filter(|b| &b.value == value).map(|b| b.text.as_str());
            if let Some(text) = pick_text(base_text, &l.text, &r.text) {
                return text;
            }
        }
    }
    let canonical = canonical_json(&Value::Object(value.clone()));
    let mut found: Vec<&Line> = [base, local, remote]
        .into_iter()
        .flatten()
        .filter(|line| &line.value == value)
        .collect();
    if found.iter().any(|line| line.text == canonical) {
        return canonical;
    }
    if base.is_some_and(|line| &line.value == value) {
        return base.map(|line| line.text.clone()).unwrap_or_default();
    }
    found.sort_by(|x, y| x.text.cmp(&y.text));
    found
        .first()
        .map(|line| line.text.clone())
        .unwrap_or(canonical)
}

/// Of two texts equal by meaning: the bytes that equal the base's stay (nothing changed in the
/// form); the sides' bytes equal — them; otherwise `None` (the canonical form is written). The
/// answer does not depend on which side is which (З52, Ж10).
fn pick_text(base: Option<&str>, local: &str, remote: &str) -> Option<String> {
    if base == Some(local) || base == Some(remote) || local == remote {
        return Some(if base == Some(remote) { remote } else { local }.to_string());
    }
    None
}

enum Merged {
    Clean(Vec<u8>),
    Conflict(GroupConflict),
}

fn merge_parsed(
    kind: GroupKind,
    base: &Parsed,
    local: &Parsed,
    remote: &Parsed,
    picks: Option<&BTreeMap<String, Side>>,
) -> Merged {
    let mut ids: BTreeSet<&String> = BTreeSet::new();
    for parsed in [base, local, remote] {
        ids.extend(parsed.lines.keys());
    }
    let mut lines: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut auto_merged = 0;
    for id in ids {
        let (b, l, r) = (
            base.lines.get(id),
            local.lines.get(id),
            remote.lines.get(id),
        );
        let core = |line: Option<&Line>| line.map(|line| core_of(kind, &line.value));
        let (bc, lc, rc) = (core(b), core(l), core(r));
        let changed = l.map(|x| &x.value) != b.map(|x| &x.value)
            || r.map(|x| &x.value) != b.map(|x| &x.value);
        let text = if lc == rc {
            l.map(|chosen| with_aux(kind, chosen, b, l, r))
        } else if lc == bc {
            r.map(|chosen| with_aux(kind, chosen, b, l, r))
        } else if rc == bc {
            l.map(|chosen| with_aux(kind, chosen, b, l, r))
        } else {
            match picks.and_then(|p| p.get(id.as_str())) {
                Some(Side::Local) => l.map(|x| x.text.clone()),
                Some(Side::Other) => r.map(|x| x.text.clone()),
                None => {
                    conflicts.push(id.clone());
                    continue;
                }
            }
        };
        if changed {
            auto_merged += 1;
        }
        lines.extend(text);
    }
    let header = if local.header == remote.header || remote.header == base.header {
        Some(local.header.clone())
    } else if local.header == base.header {
        Some(remote.header.clone())
    } else if picks.is_some() {
        Some(local.header.clone())
    } else {
        None
    };
    let Some(header) = header else {
        return Merged::Conflict(GroupConflict {
            notes: conflicts,
            auto_merged,
        });
    };
    if !conflicts.is_empty() {
        return Merged::Conflict(GroupConflict {
            notes: conflicts,
            auto_merged,
        });
    }
    let bom = if local.bom == remote.bom {
        local.bom
    } else {
        !base.bom
    };
    let crlf = if local.crlf == remote.crlf {
        local.crlf
    } else {
        !base.crlf
    };
    let header_line = if local.header == remote.header && header == local.header {
        let base_first = (base.header == header).then_some(base.first.as_str());
        pick_text(base_first, &local.first, &remote.first)
    } else {
        None
    }
    .unwrap_or_else(|| header_text(&header));
    Merged::Clean(assemble(bom, crlf, &header_line, &lines))
}

/// Three-way merge of a file by the lines of the notes (З16, З30, З31, З52). `hint` and
/// `dismissedRenames` take no part in the decision of a conflict (З31). A line that one side did
/// not change keeps the bytes of that side; a line made anew is canonical (З49). Symmetric,
/// deterministic.
pub fn merge_group(kind: GroupKind, base: &[u8], local: &[u8], remote: &[u8]) -> GroupMergeOutcome {
    let parsed: Vec<Parsed> = match [base, local, remote]
        .into_iter()
        .map(|bytes| parse(kind, bytes))
        .collect::<Result<_, _>>()
    {
        Ok(parsed) => parsed,
        Err(reason) => return GroupMergeOutcome::NotMergeable(reason),
    };
    let (b, l, r) = (&parsed[0], &parsed[1], &parsed[2]);
    if same_meaning(l, r) {
        // The form of the base is kept when a side has it (З52).
        if remote == base {
            return GroupMergeOutcome::Clean(remote.to_vec());
        }
        if local == base || local == remote {
            return GroupMergeOutcome::Clean(local.to_vec());
        }
        return match canonicalize_group(kind, local) {
            Ok(bytes) => GroupMergeOutcome::Clean(bytes),
            Err(reason) => GroupMergeOutcome::NotMergeable(reason),
        };
    }
    if same_meaning(l, b) {
        return GroupMergeOutcome::Clean(remote.to_vec());
    }
    if same_meaning(r, b) {
        return GroupMergeOutcome::Clean(local.to_vec());
    }
    match merge_parsed(kind, b, l, r, None) {
        Merged::Clean(bytes) => GroupMergeOutcome::Clean(bytes),
        Merged::Conflict(conflict) => GroupMergeOutcome::Conflict(conflict),
    }
}

/// Which version of a conflicting note the user keeps (З17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    /// «С этого компьютера»: the record as it is in the file on the path.
    Local,
    /// «С другого»: the record of the second version of the conflict set.
    Other,
}

/// Why a resolution of a conflicting group is refused and nothing is written (З17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// Some conflicting note has no pick.
    IncompletePicks,
    /// The file on the path or the second version changed since the conflict was shown.
    Stale,
    /// A version does not pass [`check_group`].
    NotMergeable(NotMergeable),
}

/// Resolves a conflicting group: for every conflicting note a pick; everything else from the clean
/// merge; the result in the canonical form. `now_local` and `now_other` are the bytes on disk and
/// in the set at this moment; if either differs from `local`/`other` that were compared, the
/// answer is [`ResolveError::Stale`] (К4). З17.
pub fn resolve_group(
    kind: GroupKind,
    base: &[u8],
    local: &[u8],
    other: &[u8],
    picks: &BTreeMap<String, Side>,
    now_local: &[u8],
    now_other: &[u8],
) -> Result<Vec<u8>, ResolveError> {
    let mut parsed = Vec::new();
    for bytes in [base, local, other] {
        parsed.push(parse(kind, bytes).map_err(ResolveError::NotMergeable)?);
    }
    if now_local != local || now_other != other {
        return Err(ResolveError::Stale);
    }
    let (b, l, o) = (&parsed[0], &parsed[1], &parsed[2]);
    // The conflicting notes must all have a pick (the header, if it conflicts, goes with local).
    if let Merged::Conflict(conflict) = merge_parsed(kind, b, l, o, None) {
        if conflict.notes.iter().any(|id| !picks.contains_key(id)) {
            return Err(ResolveError::IncompletePicks);
        }
    }
    match merge_parsed(kind, b, l, o, Some(picks)) {
        Merged::Clean(bytes) => {
            canonicalize_group(kind, &bytes).map_err(ResolveError::NotMergeable)
        }
        Merged::Conflict(_) => Err(ResolveError::IncompletePicks),
    }
}

// ----- the protection of a pass (З32) -----

/// One group file of a pass as the pass is about to write or send it (З32): what it holds now
/// (empty when it does not exist) and what it will hold.
#[derive(Debug, Clone, Copy)]
pub struct GroupWrite<'a> {
    /// Vault-relative path of the group.
    pub path: &'a str,
    /// The bytes now (incoming: on disk; outgoing: the server version). Empty: no file.
    pub before: &'a [u8],
    /// The bytes after (incoming: the version to write; outgoing: the file to send). Empty: the
    /// file is gone.
    pub after: &'a [u8],
}

/// What a pass would make vanish (З32).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MassLoss {
    /// Elements of `props` that are in `before` and not in `after`, summed over the pass.
    pub properties: usize,
    /// Notes that lose at least one.
    pub notes: usize,
}

/// The names of `props` of every note of a file; nothing for bytes that cannot be read.
fn properties_of(bytes: &[u8]) -> BTreeMap<String, BTreeSet<String>> {
    if bytes.is_empty() {
        return BTreeMap::new();
    }
    let Ok(parsed) = parse(GroupKind::Props, bytes) else {
        return BTreeMap::new();
    };
    parsed
        .lines
        .into_iter()
        .map(|(id, line)| {
            let names = line
                .value
                .get("props")
                .and_then(Value::as_object)
                .map(|props| props.keys().map(|name| name_key(name)).collect())
                .unwrap_or_default();
            (id, names)
        })
        .collect()
}

fn vanishing(before: &[u8], after: &[u8]) -> MassLoss {
    let (b, a) = (properties_of(before), properties_of(after));
    // A file that cannot be read after the pass counts nothing: it is not written either.
    if !after.is_empty() && parse(GroupKind::Props, after).is_err() {
        return MassLoss {
            properties: 0,
            notes: 0,
        };
    }
    let mut properties = 0;
    let mut notes = 0;
    for (id, names) in &b {
        let kept = a.get(id);
        let lost = names
            .iter()
            .filter(|name| !kept.is_some_and(|k| k.contains(*name)))
            .count();
        properties += lost;
        notes += usize::from(lost > 0);
    }
    MassLoss { properties, notes }
}

/// Elements of `props` (by note `id` and property name) of a `prop_<x>.jsonl` that `before` has
/// and `after` does not. A property whose differences changed, or that only moved in `order`, does
/// not vanish; a whole removed line loses all of its properties. Unreadable bytes count nothing.
/// З32, З52.
pub fn vanishing_properties(before: &[u8], after: &[u8]) -> usize {
    vanishing(before, after).properties
}

/// The check of a whole pass (З32): over **all** groups of the pass, merged and replaced from one
/// side, incoming and outgoing, sums the vanishing properties; `Some` if the sum is at least
/// [`PROPS_LOSS_MIN`] and more than [`PROPS_LOSS_PERCENT`] per cent of `total_properties`, all
/// elements of all groups on the device. Then no group of the pass is written or sent.
pub fn pass_mass_loss(writes: &[GroupWrite<'_>], total_properties: usize) -> Option<MassLoss> {
    let mut sum = MassLoss {
        properties: 0,
        notes: 0,
    };
    for write in writes {
        if kind_of_path(write.path) != Some(GroupKind::Props) {
            continue;
        }
        let loss = vanishing(write.before, write.after);
        sum.properties += loss.properties;
        sum.notes += loss.notes;
    }
    mass_change_reached(
        sum.properties,
        total_properties,
        PROPS_LOSS_MIN,
        PROPS_LOSS_PERCENT,
    )
    .then_some(sum)
}

/// How many `props` elements a file holds; used for the denominator of [`pass_mass_loss`].
pub fn count_properties(bytes: &[u8]) -> usize {
    properties_of(bytes).values().map(BTreeSet::len).sum()
}
