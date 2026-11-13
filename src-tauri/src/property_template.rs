//! The template of basic note properties (docs/sync-plan.md, appendix З: З45, З46).
//!
//! The list of basic properties — «Статус», «Приоритет», «Дата», «Теги» — with a type, an icon
//! and options lives in the code, in this one place, and is given to the interface over IPC. It
//! is never written to the vault. A note's record keeps only what differs from it (З47).
//!
//! The template may change in a new version (the owner's decision): notes without differences
//! then look different, and the values of the headers are never rewritten because of it (З45).
//! Every change of the list raises [`TEMPLATE_VERSION`], which `layout.json` remembers (З54).

use unicode_normalization::UnicodeNormalization;

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

/// One language of a basic property: the name and the options in that language.
struct Language {
    code: &'static str,
    name: &'static str,
    settings: &'static str,
}

/// A basic property: the same type and icon in every language.
struct Basic {
    property_type: &'static str,
    icon: &'static str,
    languages: &'static [Language],
}

/// The template, version 1.
const TEMPLATE: &[Basic] = &[
    Basic {
        property_type: "select",
        icon: "amby-icon:circle-chevron-down:",
        languages: &[
            Language {
                code: "ru",
                name: "Статус",
                settings: r#"{"options":["Идея","В работе","Готово"]}"#,
            },
            Language {
                code: "en",
                name: "Status",
                settings: r#"{"options":["Idea","In progress","Done"]}"#,
            },
        ],
    },
    Basic {
        property_type: "select",
        icon: "amby-icon:flag:",
        languages: &[
            Language {
                code: "ru",
                name: "Приоритет",
                settings: r#"{"options":["Низкий","Средний","Высокий"]}"#,
            },
            Language {
                code: "en",
                name: "Priority",
                settings: r#"{"options":["Low","Medium","High"]}"#,
            },
        ],
    },
    Basic {
        property_type: "date",
        icon: "amby-icon:calendar-days:",
        languages: &[
            Language {
                code: "ru",
                name: "Дата",
                settings: "",
            },
            Language {
                code: "en",
                name: "Date",
                settings: "",
            },
        ],
    },
    Basic {
        property_type: "list",
        icon: "amby-icon:list:",
        languages: &[
            Language {
                code: "ru",
                name: "Теги",
                settings: "",
            },
            Language {
                code: "en",
                name: "Tags",
                settings: "",
            },
        ],
    },
];

fn property_of(basic: &Basic, language: &Language) -> TemplateProperty {
    TemplateProperty {
        name: language.name.to_string(),
        property_type: basic.property_type.to_string(),
        icon: basic.icon.to_string(),
        settings: language.settings.to_string(),
    }
}

fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// Finds the basic property for a name from a header (З45): NFC, then exact, then the only match
/// apart from the ASCII case, over the names in every language of the interface. `None` for a name
/// that is not in the template — then the key is plain text without an icon.
pub fn lookup(name: &str) -> Option<TemplateProperty> {
    let name = nfc(name);
    let names = || {
        TEMPLATE
            .iter()
            .flat_map(|basic| basic.languages.iter().map(move |lang| (basic, lang)))
    };
    if let Some((basic, language)) = names().find(|(_, language)| nfc(language.name) == name) {
        return Some(property_of(basic, language));
    }
    let mut folded = names().filter(|(_, language)| nfc(language.name).eq_ignore_ascii_case(&name));
    let first = folded.next()?;
    if folded.next().is_some() {
        return None;
    }
    Some(property_of(first.0, first.1))
}

/// Every basic property once, with the names of all languages: what the interface gets over IPC
/// (З45). Each entry lists `(language, name)`.
pub fn all() -> Vec<(TemplateProperty, Vec<(String, String)>)> {
    TEMPLATE
        .iter()
        .map(|basic| {
            let first = &basic.languages[0];
            let names = basic
                .languages
                .iter()
                .map(|language| (language.code.to_string(), language.name.to_string()))
                .collect();
            (property_of(basic, first), names)
        })
        .collect()
}
