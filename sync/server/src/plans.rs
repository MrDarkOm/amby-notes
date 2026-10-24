//! Plans (appendix Е, П50–П54): named sets of limits read from one JSON file.
//!
//! STUB of the red-tests step (docs/Road/sync-plans-tests-report.md): the types and signatures
//! are final, the bodies are `not_implemented`. The tests in `server/tests/plans.rs` and
//! `conformance/tests/plans.rs` describe what they must do.

use std::collections::BTreeMap;
use std::path::Path;

use crate::config::Config;

/// One plan (П50). Every limit is optional; a missing one means "no limit", except
/// `history_days`, where it means "as `AMBY_SYNC_RETAIN_VERSION_DAYS`".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Plan {
    /// A label for people.
    pub title: Option<String>,
    /// Number of spaces.
    pub max_spaces: Option<u64>,
    /// Sum of sealed bytes (П55).
    pub max_total_bytes: Option<u64>,
    /// The largest sealed body (П8).
    pub max_file_bytes: Option<u64>,
    /// Days to keep replaced and deleted versions (П35, П57-г).
    pub history_days: Option<u64>,
    /// The ceiling of the history in bytes (П57-д).
    pub max_history_bytes: Option<u64>,
}

/// The parsed `plans.json` (П51).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlansFile {
    /// The plan of users who are not pinned (П52).
    pub default_plan: Option<String>,
    /// The plans by name.
    pub plans: BTreeMap<String, Plan>,
}

/// Why the plans file was refused (П51, П52). The server does not start.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum PlansError {
    /// The file cannot be read.
    #[error("plans file: {0}")]
    Io(String),
    /// The file breaks a rule of П51.
    #[error("plans file: {0}")]
    Invalid(String),
    /// Users are pinned to plans the file does not have (П52); the list names them.
    #[error("users pinned to a plan that is not in the plans file: {0}")]
    MissingPinned(String),
}

/// The limits that apply to a user (П54): the smaller of the plan and the server ceiling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveLimits {
    /// Number of spaces; `None` is no limit.
    pub max_spaces: Option<u64>,
    /// Sealed bytes in all spaces; `None` is no limit.
    pub max_total_bytes: Option<u64>,
    /// The largest body; `None` is no limit.
    pub max_file_bytes: Option<u64>,
    /// Days of history, always a number (П50).
    pub history_days: u64,
    /// Ceiling of the history; `None` is no ceiling.
    pub max_history_bytes: Option<u64>,
}

/// A plan name: `[a-z0-9_-]{1,32}` (П50).
pub fn valid_plan_name(name: &str) -> bool {
    let _ = name;
    unimplemented!("not_implemented: plan names")
}

impl PlansFile {
    /// Parses the text of the file with the strictness of П51: an unknown field, a wrong type,
    /// a zero, a repeated name or a `default_plan` without a plan is an error.
    pub fn parse(text: &str) -> Result<Self, PlansError> {
        let _ = text;
        unimplemented!("not_implemented: plans file parsing")
    }

    /// Reads the file. No file is not an error: it gives an empty `PlansFile` (П52).
    pub fn load(path: &Path) -> Result<Self, PlansError> {
        let _ = path;
        unimplemented!("not_implemented: plans file loading")
    }

    /// The plan of a user: the pinned name when there is one, otherwise `default_plan`; `None`
    /// when neither names a plan of the file (П52).
    pub fn resolve(&self, pinned: Option<&str>) -> Option<(&str, &Plan)> {
        let _ = pinned;
        unimplemented!("not_implemented: plan resolution")
    }

    /// Fails with [`PlansError::MissingPinned`] naming every `(user, plan)` whose plan is not in
    /// the file (П52).
    pub fn check_pinned(&self, pinned: &[(String, String)]) -> Result<(), PlansError> {
        let _ = pinned;
        unimplemented!("not_implemented: pinned plan check")
    }
}

impl EffectiveLimits {
    /// The limits of a user: `plan` (or none) under the ceilings of `config` (П54).
    pub fn for_plan(plan: Option<&Plan>, config: &Config) -> Self {
        let _ = (plan, config);
        unimplemented!("not_implemented: effective limits")
    }
}
