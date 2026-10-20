//! Wire constants of the sync protocol v1 (docs/sync-plan.md, appendix Б).
//!
//! Only names and numbers live here: the server and the client agree on them. The shapes of the
//! requests are in the appendix, and the conformance suite writes them out by hand on purpose,
//! so that it does not repeat a mistake of the server's own types.

/// The protocol version this code speaks (П9).
pub const PROTOCOL_VERSION: u32 = 1;

/// Size of one part of a body upload: 8 MiB (Р11, П21).
pub const PART_SIZE: u64 = 8 * 1024 * 1024;

/// Machine error codes (П4, table Б.0.1).
pub mod error_code {
    /// Not JSON, a missing or malformed field, a wrong content type.
    pub const BAD_REQUEST: &str = "bad_request";
    /// More than `max_commit_items` items in one commit.
    pub const TOO_MANY_ITEMS: &str = "too_many_items";
    /// The same item twice in one commit.
    pub const DUPLICATE_ITEM: &str = "duplicate_item";
    /// A wrong part number or length (П22).
    pub const BAD_PART: &str = "bad_part";
    /// No token or an unknown token.
    pub const UNAUTHORIZED: &str = "unauthorized";
    /// The token of a disconnected device.
    pub const TOKEN_REVOKED: &str = "token_revoked";
    /// A wrong password or recovery code, an unknown name (П15).
    pub const INVALID_CREDENTIALS: &str = "invalid_credentials";
    /// A wrong, used or unknown enrolment code (П17).
    pub const INVALID_ENROLL_CODE: &str = "invalid_enroll_code";
    /// The right code, but older than 24 hours (П17).
    pub const ENROLL_CODE_EXPIRED: &str = "enroll_code_expired";
    /// A wrong proof when the keys are replaced (П18).
    pub const INVALID_PROOF: &str = "invalid_proof";
    /// No such object, or somebody else's (П6).
    pub const NOT_FOUND: &str = "not_found";
    /// The path exists, the method does not.
    pub const METHOD_NOT_ALLOWED: &str = "method_not_allowed";
    /// A base version did not match; the whole commit is refused (П27).
    pub const VERSION_CONFLICT: &str = "version_conflict";
    /// The same `commit_id` with different content (П28).
    pub const COMMIT_ID_REUSED: &str = "commit_id_reused";
    /// A stale `base_keys_version` (П18).
    pub const KEYS_CONFLICT: &str = "keys_conflict";
    /// The space already exists (П20).
    pub const SPACE_EXISTS: &str = "space_exists";
    /// The body was started with another size, or is already complete (П21, П22).
    pub const BLOB_EXISTS: &str = "blob_exists";
    /// `complete` before every part arrived (П23).
    pub const PARTS_MISSING: &str = "parts_missing";
    /// A JSON request over the limit (П8).
    pub const PAYLOAD_TOO_LARGE: &str = "payload_too_large";
    /// A body over the limit (П8).
    pub const BLOB_TOO_LARGE: &str = "blob_too_large";
    /// A byte range outside the body (П24).
    pub const RANGE_NOT_SATISFIABLE: &str = "range_not_satisfiable";
    /// A commit refers to a body that does not exist or is not complete (П30).
    pub const UNKNOWN_BLOB: &str = "unknown_blob";
    /// Too many failed sign-in attempts (П16).
    pub const RATE_LIMITED: &str = "rate_limited";
    /// The user's quota would be exceeded (П42).
    pub const QUOTA_EXCEEDED: &str = "quota_exceeded";
    /// A server fault; details only in the log.
    pub const INTERNAL: &str = "internal";
    /// A stub: the handler is not written yet (plan, раздел 6, шаг 1).
    pub const NOT_IMPLEMENTED: &str = "not_implemented";
}
