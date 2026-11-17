//! Rollup aggregation: which aggregations exist, which target field kinds accept
//! them, and how a list of related values becomes one number or date.
//!
//! The registry is the only list. Creation, `validate_manifest` and the
//! projection all use it, and `rollup-aggregations.json` in the UI must equal it
//! (a test checks). Results keep three states apart: no data (`Empty`), a real
//! zero (`Number("0")`), and a failure (an `Err`, recorded as a diagnostic).

use std::collections::HashSet;

use super::formula::{Decimal, FormulaError};

/// Canonical aggregations per target field kind, in the order the UI offers them.
pub const REGISTRY: &[(&str, &[&str])] = &[
    ("text", &["count", "countNonEmpty", "unique"]),
    ("url", &["count", "countNonEmpty", "unique"]),
    (
        "number",
        &[
            "count",
            "countNonEmpty",
            "unique",
            "sum",
            "average",
            "min",
            "max",
        ],
    ),
    (
        "date",
        &["count", "countNonEmpty", "unique", "earliest", "latest"],
    ),
    ("checkbox", &["count", "percentChecked"]),
    ("select", &["count", "countNonEmpty", "unique"]),
    (
        "status",
        &["count", "countNonEmpty", "unique", "percentChecked"],
    ),
    ("multiSelect", &["count", "countNonEmpty"]),
    ("relation", &["count", "countNonEmpty"]),
    ("files", &["count", "countNonEmpty"]),
];

/// Names used by earlier builds of the evaluator.
const ALIASES: &[(&str, &str)] = &[("avg", "average"), ("countUnique", "unique")];

pub fn canonical(aggregation: &str) -> Option<&'static str> {
    if let Some((_, name)) = ALIASES.iter().find(|(alias, _)| *alias == aggregation) {
        return Some(name);
    }
    REGISTRY
        .iter()
        .flat_map(|(_, aggregations)| aggregations.iter())
        .find(|candidate| **candidate == aggregation)
        .copied()
}

/// Whether a target field kind accepts an aggregation. Kinds the registry does not
/// list (formula, rollup) are numeric or text depending on their result, which is
/// only known at compute time, so they accept every aggregation here.
pub fn allowed(kind: &str, aggregation: &str) -> bool {
    let Some(canonical) = canonical(aggregation) else {
        return false;
    };
    match REGISTRY.iter().find(|(candidate, _)| *candidate == kind) {
        Some((_, aggregations)) => aggregations.contains(&canonical),
        None => matches!(kind, "formula" | "rollup"),
    }
}

/// What the projection stored for one related page.
#[derive(Clone, Debug, Default)]
pub struct TargetValue {
    pub text: Option<String>,
    pub decimal: Option<String>,
    pub boolean: Option<i64>,
    pub date: Option<String>,
    pub option_id: Option<String>,
}

impl TargetValue {
    fn is_empty(&self) -> bool {
        self.text.as_deref().is_none_or(str::is_empty)
            && self.decimal.is_none()
            && self.boolean.is_none()
            && self.date.is_none()
            && self.option_id.is_none()
    }

    fn identity(&self) -> Option<String> {
        self.decimal
            .clone()
            .or_else(|| self.text.clone().filter(|text| !text.is_empty()))
            .or_else(|| self.option_id.clone())
            .or_else(|| self.boolean.map(|boolean| boolean.to_string()))
            .or_else(|| self.date.clone())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RollupOutcome {
    /// No data to aggregate (not zero).
    Empty,
    Number(String),
    Date(String),
}

fn number(value: i64) -> RollupOutcome {
    RollupOutcome::Number(value.to_string())
}

/// `values` holds one entry per related page, in relation order, `None` for a
/// page that has no value in the target field. `done_options` are the target
/// Status options of the `done` group.
pub fn aggregate(
    aggregation: &str,
    values: &[Option<TargetValue>],
    done_options: &HashSet<String>,
) -> Result<RollupOutcome, FormulaError> {
    let Some(aggregation) = canonical(aggregation) else {
        return Err(FormulaError::new(
            "unknownAggregation",
            format!("unknown rollup aggregation {aggregation}"),
        ));
    };
    let present: Vec<&TargetValue> = values
        .iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect();
    match aggregation {
        "count" => Ok(number(values.len() as i64)),
        "countNonEmpty" => Ok(number(present.len() as i64)),
        "unique" => {
            let unique: HashSet<String> = present
                .iter()
                .filter_map(|value| value.identity())
                .collect();
            Ok(number(unique.len() as i64))
        }
        "sum" | "average" => {
            let mut sum = Decimal::from_i64(0);
            let mut count = 0;
            for value in &present {
                if let Some(raw) = &value.decimal {
                    sum = sum.add(&Decimal::parse(raw)?)?;
                    count += 1;
                }
            }
            if aggregation == "average" {
                if count == 0 {
                    return Ok(RollupOutcome::Empty);
                }
                return Ok(RollupOutcome::Number(
                    sum.div(&Decimal::from_i64(count))?.to_string(),
                ));
            }
            // A sum over nothing is a real zero: nothing was added up.
            Ok(RollupOutcome::Number(sum.to_string()))
        }
        "min" | "max" => {
            let mut best: Option<Decimal> = None;
            for value in &present {
                if let Some(raw) = &value.decimal {
                    let parsed = Decimal::parse(raw)?;
                    best = Some(match best {
                        None => parsed,
                        Some(current) => {
                            let order = parsed.cmp(&current)?;
                            let better = if aggregation == "max" {
                                order == std::cmp::Ordering::Greater
                            } else {
                                order == std::cmp::Ordering::Less
                            };
                            if better {
                                parsed
                            } else {
                                current
                            }
                        }
                    });
                }
            }
            Ok(best.map_or(RollupOutcome::Empty, |value| {
                RollupOutcome::Number(value.to_string())
            }))
        }
        "earliest" | "latest" => {
            let mut best: Option<(i64, String)> = None;
            for value in &present {
                let Some(date) = &value.date else { continue };
                let (Some(key), _) = super::projection::date_key(date) else {
                    continue;
                };
                let better = match &best {
                    None => true,
                    Some((current, _)) => {
                        if aggregation == "latest" {
                            key > *current
                        } else {
                            key < *current
                        }
                    }
                };
                if better {
                    best = Some((key, date.clone()));
                }
            }
            Ok(best.map_or(RollupOutcome::Empty, |(_, date)| RollupOutcome::Date(date)))
        }
        "percentChecked" => {
            if values.is_empty() {
                return Ok(RollupOutcome::Empty);
            }
            let done = values
                .iter()
                .flatten()
                .filter(|value| {
                    value.boolean == Some(1)
                        || value
                            .option_id
                            .as_ref()
                            .is_some_and(|option| done_options.contains(option))
                })
                .count() as i64;
            // Whole hundredths, rounded down: 1 of 3 is 33.33, never 33.333...
            let hundredths = done * 10_000 / values.len() as i64;
            Ok(RollupOutcome::Number(format!(
                "{}.{:02}",
                hundredths / 100,
                hundredths % 100
            )))
        }
        _ => unreachable!("canonical() only returns registered aggregations"),
    }
}

#[cfg(test)]
#[path = "rollup_test.rs"]
mod tests;
