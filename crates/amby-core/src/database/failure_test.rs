use super::*;
use crate::database::model::DatabaseError;
use crate::database::query::QueryFailure;
use serde_json::json;

/// Sentences the write paths really raise (copied from the sources that raise them), with the
/// reason a person is told. Add a row when a refusal gets its own text in the interface.
const SENTENCES: &[(&str, FailureReason)] = &[
    (
        "Manifest revision conflict",
        FailureReason::RevisionConflict,
    ),
    ("View revision conflict", FailureReason::RevisionConflict),
    (
        "Target manifest revision conflict",
        FailureReason::RevisionConflict,
    ),
    (
        "Related manifest revision conflict",
        FailureReason::RevisionConflict,
    ),
    ("Record revision conflict", FailureReason::RevisionConflict),
    (
        "Relation source revision conflict",
        FailureReason::RevisionConflict,
    ),
    (
        "Note changed during YAML sync",
        FailureReason::RevisionConflict,
    ),
    (
        "Relation target path changed before publication",
        FailureReason::RevisionConflict,
    ),
    ("Database is locked", FailureReason::Locked),
    ("Target database is locked", FailureReason::Locked),
    ("Related database is locked", FailureReason::Locked),
    ("Database is read-only", FailureReason::ReadOnly),
    (
        "Related database manifest is read-only",
        FailureReason::ReadOnly,
    ),
    (
        "View is read-only because its format is unsupported",
        FailureReason::ReadOnly,
    ),
    (
        "View was not found in the manifest",
        FailureReason::NotFound,
    ),
    ("Property was not found", FailureReason::NotFound),
    ("Database row was not found", FailureReason::NotFound),
    ("Row does not belong to database", FailureReason::NotFound),
    (
        "Relation property not found: 01J00000000000000000000001",
        FailureReason::NotFound,
    ),
    (
        "A property with this name already exists",
        FailureReason::NameTaken,
    ),
    ("File already exists: Notes/A.md", FailureReason::NameTaken),
    ("Property name is required", FailureReason::InvalidName),
    ("View name is invalid", FailureReason::InvalidName),
    ("Invalid database name", FailureReason::InvalidName),
    ("Invalid row title", FailureReason::InvalidName),
    ("Property cannot be renamed", FailureReason::InvalidName),
    (
        "Property type can only be changed after its existing values are cleared",
        FailureReason::ValuesNotEmpty,
    ),
    (
        "Date time and range settings can only change after the existing values are cleared",
        FailureReason::ValuesNotEmpty,
    ),
    (
        "Property type cannot be changed while another property depends on it",
        FailureReason::HasDependents,
    ),
    (
        "Invalid formula: unexpected end",
        FailureReason::FormulaInvalid,
    ),
    (
        "Formula expression is required",
        FailureReason::FormulaInvalid,
    ),
    (
        "The last database view cannot be deleted",
        FailureReason::LastView,
    ),
    (
        "Only one option can be the default",
        FailureReason::InvalidConfig,
    ),
    (
        "Option color must be a #rrggbb value",
        FailureReason::InvalidConfig,
    ),
    ("Too many options", FailureReason::InvalidConfig),
    (
        "These settings do not apply to this property",
        FailureReason::InvalidConfig,
    ),
    (
        "Property rename would make the database manifest invalid",
        FailureReason::InvalidConfig,
    ),
    ("Unsupported property type", FailureReason::InvalidConfig),
    (
        "Related inverse property is not reciprocal",
        FailureReason::RelationInvalid,
    ),
    (
        "Invalid Relation target database ID",
        FailureReason::RelationInvalid,
    ),
    (
        "Inverse property is not a relation",
        FailureReason::RelationInvalid,
    ),
    (
        "noteId and propertyId must be canonical ULIDs",
        FailureReason::InvalidValue,
    ),
    (
        "Invalid value for Price: expected a number",
        FailureReason::InvalidValue,
    ),
    (
        "Source asset exceeds the attachment size limit",
        FailureReason::TooLarge,
    ),
    (
        "Generated database JSON is too large",
        FailureReason::TooLarge,
    ),
    (
        "Undo failed during atomic write; rolled back: disk full",
        FailureReason::RolledBack,
    ),
    (
        "file changed externally; rollback refused",
        FailureReason::RecoveryRequired,
    ),
    (
        "An unfinished Relation schema operation requires vault recovery",
        FailureReason::RecoveryRequired,
    ),
    (
        "YAML and database values changed independently; choose a field value",
        FailureReason::YamlConflict,
    ),
    (
        "Failed to read Notes/A.md: No such file or directory",
        FailureReason::Io,
    ),
    ("Cannot scan vault: permission denied", FailureReason::Io),
    ("Something nobody classified", FailureReason::Failed),
];

#[test]
fn every_known_sentence_has_its_reason() {
    for (sentence, expected) in SENTENCES {
        assert_eq!(classify(sentence), *expected, "{sentence}");
    }
}

#[test]
fn the_reason_ignores_letter_case_and_the_text_around_the_sentence() {
    assert_eq!(
        classify("Operation failed: MANIFEST REVISION CONFLICT (expected abc)"),
        FailureReason::RevisionConflict
    );
}

#[test]
fn a_locked_database_is_a_lock_even_when_it_is_the_related_one() {
    assert_eq!(
        classify("Related database is locked"),
        FailureReason::Locked
    );
}

#[test]
fn a_command_failure_carries_its_command_code_and_the_reason() {
    let error = DatabaseError::failed("databaseRenameFailed", "Manifest revision conflict");
    assert_eq!(
        serde_json::to_value(&error).unwrap(),
        json!({
            "kind": "failed",
            "code": "databaseRenameFailed",
            "reason": "revision_conflict",
            "message": "Manifest revision conflict",
        })
    );
}

#[test]
fn reasons_are_serialised_in_snake_case() {
    let names: Vec<String> = [
        FailureReason::RevisionConflict,
        FailureReason::ValuesNotEmpty,
        FailureReason::StaleCursor,
        FailureReason::Failed,
    ]
    .iter()
    .map(|reason| {
        serde_json::to_value(reason)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    })
    .collect();
    assert_eq!(
        names,
        [
            "revision_conflict",
            "values_not_empty",
            "stale_cursor",
            "failed"
        ]
    );
}

#[test]
fn query_failures_keep_their_own_code_and_get_a_reason() {
    let stale: DatabaseError = QueryFailure::for_test("staleCursor", "Cursor is stale").into();
    assert!(matches!(
        stale,
        DatabaseError::Failed { ref code, reason: FailureReason::StaleCursor, .. }
            if code == "staleCursor"
    ));
    let missing: DatabaseError = QueryFailure::for_test("databaseNotFound", "no").into();
    assert!(matches!(
        missing,
        DatabaseError::Failed {
            reason: FailureReason::NotFound,
            ..
        }
    ));
    let operand: DatabaseError = QueryFailure::for_test("invalidOperand", "bad").into();
    assert!(matches!(
        operand,
        DatabaseError::Failed {
            reason: FailureReason::InvalidConfig,
            ..
        }
    ));
    let other: DatabaseError = QueryFailure::for_test("queryFailed", "sql").into();
    assert!(matches!(
        other,
        DatabaseError::Failed {
            reason: FailureReason::Failed,
            ..
        }
    ));
}
