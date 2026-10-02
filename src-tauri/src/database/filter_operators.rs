//! The single registry of filter operators: which operators exist, which field
//! kinds accept them, and the legacy spellings that older view files may hold.
//! Query compilation and view validation both go through it, and the UI reads
//! the same table from `filter-operators.json` (a contract test keeps them equal).

/// Canonical operators per field kind, in the order the UI offers them.
pub const REGISTRY: &[(&str, &[&str])] = &[
    (
        "text",
        &[
            "contains",
            "equals",
            "notEquals",
            "startsWith",
            "isEmpty",
            "isNotEmpty",
        ],
    ),
    (
        "url",
        &[
            "contains",
            "equals",
            "notEquals",
            "startsWith",
            "isEmpty",
            "isNotEmpty",
        ],
    ),
    (
        "number",
        &[
            "equals",
            "notEquals",
            "greaterThan",
            "greaterOrEqual",
            "lessThan",
            "lessOrEqual",
            "isEmpty",
            "isNotEmpty",
        ],
    ),
    (
        "date",
        &[
            "equals",
            "notEquals",
            "greaterThan",
            "greaterOrEqual",
            "lessThan",
            "lessOrEqual",
            "isEmpty",
            "isNotEmpty",
        ],
    ),
    ("checkbox", &["equals", "notEquals"]),
    ("select", &["equals", "notEquals", "isEmpty", "isNotEmpty"]),
    ("status", &["equals", "notEquals", "isEmpty", "isNotEmpty"]),
    ("multiSelect", &["contains", "isEmpty", "isNotEmpty"]),
    ("relation", &["contains", "isEmpty", "isNotEmpty"]),
    ("files", &["isEmpty", "isNotEmpty"]),
    (
        "system",
        &[
            "contains",
            "equals",
            "notEquals",
            "startsWith",
            "greaterThan",
            "greaterOrEqual",
            "lessThan",
            "lessOrEqual",
            "isEmpty",
            "isNotEmpty",
        ],
    ),
];

/// Spellings used by earlier drafts of the view format.
const ALIASES: &[(&str, &str)] = &[
    ("is", "equals"),
    ("isNot", "notEquals"),
    ("gt", "greaterThan"),
    ("gte", "greaterOrEqual"),
    ("lt", "lessThan"),
    ("lte", "lessOrEqual"),
];

/// Maps an operator, canonical or legacy, to its canonical spelling.
pub fn canonical(operator: &str) -> Option<&'static str> {
    if let Some((_, canonical)) = ALIASES.iter().find(|(alias, _)| *alias == operator) {
        return Some(canonical);
    }
    REGISTRY
        .iter()
        .flat_map(|(_, operators)| operators.iter())
        .find(|candidate| **candidate == operator)
        .copied()
}

/// Whether a field kind accepts an operator (canonical or legacy spelling).
/// Kinds the registry does not know accept anything, as before.
pub fn allowed(kind: &str, operator: &str) -> bool {
    let Some(operators) = REGISTRY
        .iter()
        .find(|(candidate, _)| {
            *candidate == kind || (*candidate == "multiSelect" && kind == "multiselect")
        })
        .map(|(_, operators)| *operators)
    else {
        return true;
    };
    canonical(operator).is_some_and(|canonical| operators.contains(&canonical))
}

#[cfg(test)]
#[path = "filter_operators_test.rs"]
mod tests;
