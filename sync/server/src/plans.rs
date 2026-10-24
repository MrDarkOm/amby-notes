//! Plans (appendix Е, П50–П54): named sets of limits read from one JSON file.
//!
//! The file is read once, when the state is opened; which plan a user has is read from the
//! database on every request, so `user plan set` applies at once (П53).

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde::Deserialize;
use serde_json::Value;

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
    (1..=32).contains(&name.len())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

/// JSON as read for the file: objects keep their pairs, so that a repeated key is seen and
/// refused (П51); `serde_json::Map` would keep the last one silently.
enum Raw {
    Object(Vec<(String, Raw)>),
    Other(Value),
}

impl<'de> Deserialize<'de> for Raw {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RawVisitor;
        impl<'de> Visitor<'de> for RawVisitor {
            type Value = Raw;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Raw, A::Error> {
                let mut pairs: Vec<(String, Raw)> = Vec::new();
                while let Some(key) = map.next_key::<String>()? {
                    if pairs.iter().any(|(have, _)| *have == key) {
                        return Err(de::Error::custom(format!("`{key}` is repeated")));
                    }
                    pairs.push((key, map.next_value()?));
                }
                Ok(Raw::Object(pairs))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Raw, A::Error> {
                while seq.next_element::<de::IgnoredAny>()?.is_some() {}
                Ok(Raw::Other(Value::Array(Vec::new())))
            }
            fn visit_bool<E>(self, value: bool) -> Result<Raw, E> {
                Ok(Raw::Other(Value::Bool(value)))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Raw, E> {
                Ok(Raw::Other(Value::from(value)))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Raw, E> {
                Ok(Raw::Other(Value::from(value)))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Raw, E> {
                Ok(Raw::Other(Value::from(value)))
            }
            fn visit_str<E>(self, value: &str) -> Result<Raw, E> {
                Ok(Raw::Other(Value::String(value.to_string())))
            }
            fn visit_unit<E>(self) -> Result<Raw, E> {
                Ok(Raw::Other(Value::Null))
            }
        }
        deserializer.deserialize_any(RawVisitor)
    }
}

fn invalid(message: impl Into<String>) -> PlansError {
    PlansError::Invalid(message.into())
}

/// A whole number of at least 1 (П50).
fn limit(plan: &str, field: &str, value: &Raw) -> Result<u64, PlansError> {
    match value {
        Raw::Other(number) => number
            .as_u64()
            .filter(|number| *number >= 1)
            .ok_or_else(|| {
                invalid(format!(
                    "plan `{plan}`: `{field}` must be a whole number of at least 1"
                ))
            }),
        Raw::Object(_) => Err(invalid(format!(
            "plan `{plan}`: `{field}` must be a number"
        ))),
    }
}

fn parse_plan(name: &str, raw: &Raw) -> Result<Plan, PlansError> {
    let Raw::Object(fields) = raw else {
        return Err(invalid(format!("plan `{name}` must be an object")));
    };
    let mut plan = Plan::default();
    for (field, value) in fields {
        match field.as_str() {
            "title" => match value {
                Raw::Other(Value::String(title)) => plan.title = Some(title.clone()),
                _ => return Err(invalid(format!("plan `{name}`: `title` must be text"))),
            },
            "max_spaces" => plan.max_spaces = Some(limit(name, field, value)?),
            "max_total_bytes" => plan.max_total_bytes = Some(limit(name, field, value)?),
            "max_file_bytes" => plan.max_file_bytes = Some(limit(name, field, value)?),
            "history_days" => plan.history_days = Some(limit(name, field, value)?),
            "max_history_bytes" => plan.max_history_bytes = Some(limit(name, field, value)?),
            other => return Err(invalid(format!("plan `{name}`: unknown field `{other}`"))),
        }
    }
    Ok(plan)
}

impl PlansFile {
    /// Parses the text of the file with the strictness of П51: an unknown field, a wrong type,
    /// a zero, a repeated name or a `default_plan` without a plan is an error.
    pub fn parse(text: &str) -> Result<Self, PlansError> {
        let raw: Raw = serde_json::from_str(text).map_err(|error| invalid(error.to_string()))?;
        let Raw::Object(top) = raw else {
            return Err(invalid("the file must be a JSON object"));
        };
        let mut file = Self::default();
        let mut default_plan: Option<String> = None;
        for (key, value) in &top {
            match (key.as_str(), value) {
                ("default_plan", Raw::Other(Value::String(name))) => {
                    default_plan = Some(name.clone());
                }
                ("default_plan", Raw::Other(Value::Null)) => {}
                ("default_plan", _) => return Err(invalid("`default_plan` must be a plan name")),
                ("plans", Raw::Object(plans)) => {
                    for (name, plan) in plans {
                        if !valid_plan_name(name) {
                            return Err(invalid(format!(
                                "`{name}` is not a plan name (a-z, 0-9, _ and -, 1 to 32 characters)"
                            )));
                        }
                        file.plans.insert(name.clone(), parse_plan(name, plan)?);
                    }
                }
                ("plans", _) => return Err(invalid("`plans` must be an object")),
                (other, _) => return Err(invalid(format!("unknown field `{other}`"))),
            }
        }
        if let Some(name) = default_plan {
            if !file.plans.contains_key(&name) {
                return Err(invalid(format!(
                    "`default_plan` names `{name}`, which is not among the plans"
                )));
            }
            file.default_plan = Some(name);
        }
        Ok(file)
    }

    /// Reads the file. No file is not an error: it gives an empty `PlansFile` (П52).
    pub fn load(path: &Path) -> Result<Self, PlansError> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(PlansError::Io(format!("{}: {error}", path.display()))),
        }
    }

    /// The plan of a user: the pinned name when there is one, otherwise `default_plan`; `None`
    /// when neither names a plan of the file (П52).
    pub fn resolve(&self, pinned: Option<&str>) -> Option<(&str, &Plan)> {
        let name = pinned.or(self.default_plan.as_deref())?;
        self.plans
            .get_key_value(name)
            .map(|(name, plan)| (name.as_str(), plan))
    }

    /// Fails with [`PlansError::MissingPinned`] naming every `(user, plan)` whose plan is not in
    /// the file (П52).
    pub fn check_pinned(&self, pinned: &[(String, String)]) -> Result<(), PlansError> {
        let missing: Vec<String> = pinned
            .iter()
            .filter(|(_, plan)| !self.plans.contains_key(plan))
            .map(|(user, plan)| format!("{user} ({plan})"))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(PlansError::MissingPinned(missing.join(", ")))
        }
    }
}

impl EffectiveLimits {
    /// The limits of a user: `plan` (or none) under the ceilings of `config` (П54).
    pub fn for_plan(plan: Option<&Plan>, config: &Config) -> Self {
        let smaller = |left: Option<u64>, right: Option<u64>| match (left, right) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (left, right) => left.or(right),
        };
        Self {
            max_spaces: plan.and_then(|plan| plan.max_spaces),
            max_total_bytes: smaller(
                plan.and_then(|plan| plan.max_total_bytes),
                config.quota_bytes_per_user,
            ),
            max_file_bytes: smaller(
                plan.and_then(|plan| plan.max_file_bytes),
                Some(config.max_blob_bytes),
            ),
            history_days: plan
                .and_then(|plan| plan.history_days)
                .unwrap_or(config.retain_version_days),
            max_history_bytes: plan.and_then(|plan| plan.max_history_bytes),
        }
    }
}
