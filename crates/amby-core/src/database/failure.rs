//! Why a database operation failed, as a stable machine code.
//!
//! The write paths report their refusals as English sentences (`Result<_, String>`). The interface
//! never shows those sentences (docs/notices.md §10): it shows a text chosen by this code. The
//! sentence is classified here, once, at the command boundary; a sentence nobody classified is
//! `Failed`, which the interface words as a general failure with the command's own code beside it.
//!
//! Adding a refusal that a person can act on: give it a variant, a pattern in [`classify`], a text
//! in `src/locales/resources.ts` (`databaseErrors.reason.*`) and a row in `failure_test.rs`.

use serde::Serialize;

/// The meaning of a failure for a person, not the internal type that raised it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// The file changed after it was read (another window, another app, sync).
    RevisionConflict,
    /// The database is locked by its owner against edits.
    Locked,
    /// The database or view is in a newer format and is open for reading only.
    ReadOnly,
    /// The property, view, row or database is no longer there.
    NotFound,
    /// The name is already used.
    NameTaken,
    /// The name or title is empty, too long or not allowed.
    InvalidName,
    /// A property type can change only after its values are cleared.
    ValuesNotEmpty,
    /// Another property is computed from this one.
    HasDependents,
    /// The formula does not parse.
    FormulaInvalid,
    /// The last view of a database cannot be deleted.
    LastView,
    /// The settings are not allowed for this property or view.
    InvalidConfig,
    /// A relation is not valid: no reciprocal property, wrong target.
    RelationInvalid,
    /// A value or a file is not valid (a number, a date, a frontmatter value).
    InvalidValue,
    /// A file is too large or over a limit.
    TooLarge,
    /// The operation failed half-way and was rolled back; nothing changed.
    RolledBack,
    /// An earlier interrupted operation must finish first.
    RecoveryRequired,
    /// The result list moved on; the caller asks again from the start.
    StaleCursor,
    /// The two sources of a value disagree and a person must choose.
    YamlConflict,
    /// A file could not be read or written.
    Io,
    /// Nothing more specific is known.
    Failed,
}

fn has(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// The reason behind a failure sentence of the database write and read paths.
///
/// Order matters: the most specific meaning is tested first, so "Related database is locked" is a
/// lock and not a relation problem.
pub fn classify(message: &str) -> FailureReason {
    let lower = message.to_ascii_lowercase();
    let text = lower.as_str();
    // A refused rollback leaves the files as the failed write left them: that needs recovery.
    if has(
        text,
        &[
            "requires vault recovery",
            "recovery journal",
            "rollback refused",
        ],
    ) {
        return FailureReason::RecoveryRequired;
    }
    if text.contains("rolled back") {
        return FailureReason::RolledBack;
    }
    if has(
        text,
        &[
            "revision conflict",
            "changed externally",
            "changed during yaml sync",
            "changed before publication",
            "appeared during yaml sync",
            "revision changed",
        ],
    ) {
        return FailureReason::RevisionConflict;
    }
    if text.contains("is locked") {
        return FailureReason::Locked;
    }
    if has(text, &["is read-only", "read-only because"]) {
        return FailureReason::ReadOnly;
    }
    if text.contains("existing values are cleared") {
        return FailureReason::ValuesNotEmpty;
    }
    if text.contains("another property depends on it") {
        return FailureReason::HasDependents;
    }
    if has(text, &["invalid formula", "formula expression is required"]) {
        return FailureReason::FormulaInvalid;
    }
    if text.contains("last database view") {
        return FailureReason::LastView;
    }
    if has(text, &["already exists"]) {
        return FailureReason::NameTaken;
    }
    if has(
        text,
        &[
            "name is required",
            "name is invalid",
            "invalid database name",
            "invalid row title",
            "cannot be renamed",
        ],
    ) {
        return FailureReason::InvalidName;
    }
    if has(text, &["yaml and database values changed independently"]) {
        return FailureReason::YamlConflict;
    }
    if has(
        text,
        &[
            "was not found",
            "not found",
            "does not belong to database",
            "row does not belong",
        ],
    ) {
        return FailureReason::NotFound;
    }
    if has(text, &["relation", "inverse property", "reciprocal"]) {
        return FailureReason::RelationInvalid;
    }
    if has(text, &["exceeds", "too large"]) {
        return FailureReason::TooLarge;
    }
    if has(
        text,
        &[
            "would make",
            "do not apply",
            "option color",
            "only one option",
            "too many options",
            "has no options",
            "unknown ",
            "unsupported",
            "not a rollup",
            "configuration is invalid",
            "view config",
            "must contain every",
            "option name",
            "option id is repeated",
            "remove the yaml binding",
        ],
    ) {
        return FailureReason::InvalidConfig;
    }
    if has(
        text,
        &["invalid ", "must be canonical", "must be a", "is invalid"],
    ) {
        return FailureReason::InvalidValue;
    }
    if has(
        text,
        &[
            "failed to read",
            "cannot scan",
            "cannot create",
            "not readable",
            "not accessible",
            "file does not belong",
            "os error",
            "permission denied",
        ],
    ) {
        return FailureReason::Io;
    }
    FailureReason::Failed
}

#[cfg(test)]
#[path = "failure_test.rs"]
mod tests;
