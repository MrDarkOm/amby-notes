//! The template of basic note properties (docs/sync-plan.md, appendix З: З45, З46). Interfaces
//! only (раздел 6, шаг 1): bodies are `todo!()` until the tests are reviewed.
//!
//! The list of basic properties — «Статус», «Приоритет», «Дата», «Теги», … — with a type, an icon
//! and options lives in the code, in this one place, and is given to the interface over IPC. It
//! is never written to the vault. A note's record keeps only what differs from it (З47).
#![allow(dead_code, unused_variables)]

/// The number of the template: written to `layout.json` (`template`), raised when the template
/// changes (З48, З54).
pub const TEMPLATE_VERSION: u32 = 1;

/// A basic property as it looks for a name found in the header (З45).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateProperty {
    /// The name that matched, as written in the template (in its language).
    pub name: String,
    /// `text`, `select`, `number`, `date`, `list`, `checkbox`, …
    pub property_type: String,
    pub icon: String,
    /// Options in the language of the name that matched, as the comma-separated `settings`.
    pub settings: String,
}

/// Finds the basic property for a name from a header (З45): NFC, then exact, then the only match
/// apart from the ASCII case, over the names in every language of the interface. `None` for a name
/// that is not in the template — then the key is plain text without an icon.
pub fn lookup(name: &str) -> Option<TemplateProperty> {
    todo!("З45, З24")
}

/// Every basic property once, with the names of all languages: what the interface gets over IPC
/// (З45). Each entry lists `(language, name)`.
pub fn all() -> Vec<(TemplateProperty, Vec<(String, String)>)> {
    todo!("З45")
}
