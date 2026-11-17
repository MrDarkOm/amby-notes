use super::*;

#[test]
fn legacy_spellings_map_to_canonical_operators() {
    for (legacy, canonical_name) in [
        ("is", "equals"),
        ("isNot", "notEquals"),
        ("gt", "greaterThan"),
        ("gte", "greaterOrEqual"),
        ("lt", "lessThan"),
        ("lte", "lessOrEqual"),
        ("contains", "contains"),
    ] {
        assert_eq!(canonical(legacy), Some(canonical_name));
    }
    assert_eq!(canonical("between"), None);
}

#[test]
fn every_registered_pair_is_allowed_and_nothing_else() {
    for (kind, operators) in REGISTRY {
        for operator in *operators {
            assert!(allowed(kind, operator), "{kind} should allow {operator}");
        }
    }
    assert!(!allowed("number", "contains"));
    assert!(!allowed("select", "startsWith"));
    assert!(!allowed("files", "equals"));
    // Unknown kinds keep accepting anything.
    assert!(allowed("future-kind", "whatever"));
}

/// `filter-operators.json` is what the UI offers. It must be exactly the registry.
#[test]
fn the_shared_json_registry_matches_the_rust_registry() {
    let json: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/components/workspace/database/filter-operators.json"
    ))
    .unwrap();
    let object = json.as_object().unwrap();
    assert_eq!(object.len(), REGISTRY.len());
    for (kind, operators) in REGISTRY {
        let listed: Vec<&str> = object[*kind]
            .as_array()
            .unwrap_or_else(|| panic!("missing kind {kind}"))
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(&listed, operators, "operators of {kind}");
    }
}
