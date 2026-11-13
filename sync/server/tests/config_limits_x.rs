//! Appendix Х: the three new settings (Х1, Х2, Х4), read from the environment like the others
//! (П40).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;

use amby_sync_server::{Config, ConfigError};

fn parse(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    let vars: HashMap<String, String> = pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    Config::from_map(&vars)
}

fn parse_ok(pairs: &[(&str, &str)]) -> Config {
    parse(pairs).unwrap_or_else(|error| panic!("the settings were refused: {error}"))
}

#[test]
fn the_defaults_of_appendix_x() {
    // Х1: 1 GiB; Х2: no limit; Х4: four large bodies. Passes with the interface stubs.
    let config = parse_ok(&[]);
    assert_eq!(config.min_free_bytes, 1_073_741_824);
    assert_eq!(config.max_users, None);
    assert_eq!(config.max_large_bodies, 4);
}

#[test]
fn the_three_variables_are_read() {
    // Х1, Х2, Х4. Passes with the interface stubs.
    let config = parse_ok(&[
        ("AMBY_SYNC_MIN_FREE_BYTES", "5000000"),
        ("AMBY_SYNC_MAX_USERS", "25"),
        ("AMBY_SYNC_MAX_LARGE_BODIES", "2"),
    ]);
    assert_eq!(config.min_free_bytes, 5_000_000);
    assert_eq!(config.max_users, Some(25));
    assert_eq!(config.max_large_bodies, 2);
}

#[test]
fn a_zero_free_space_threshold_is_allowed_and_means_off() {
    // Х1: "`0` выключает". The shared `number` reader refuses zero, so this needs its own reading.
    let config = parse_ok(&[("AMBY_SYNC_MIN_FREE_BYTES", "0")]);
    assert_eq!(config.min_free_bytes, 0);
}

#[test]
fn bad_values_of_the_new_variables_refuse_to_start() {
    // П40: a clear refusal, not a silent default.
    for (name, value) in [
        ("AMBY_SYNC_MIN_FREE_BYTES", "lots"),
        ("AMBY_SYNC_MIN_FREE_BYTES", "-1"),
        ("AMBY_SYNC_MAX_USERS", "many"),
        ("AMBY_SYNC_MAX_USERS", "1.5"),
        ("AMBY_SYNC_MAX_LARGE_BODIES", "-3"),
        ("AMBY_SYNC_MAX_LARGE_BODIES", "some"),
    ] {
        match parse(&[(name, value)]) {
            Err(ConfigError::Invalid { name: got, .. }) => assert_eq!(got, name),
            other => panic!("{name}={value} must be refused, got {other:?}"),
        }
    }
}

#[test]
fn zero_large_bodies_is_refused() {
    // Х4: a place count of zero would refuse every large body for good; like the other counts
    // it must be greater than zero.
    let result = parse(&[("AMBY_SYNC_MAX_LARGE_BODIES", "0")]);
    assert!(
        matches!(result, Err(ConfigError::Invalid { .. })),
        "AMBY_SYNC_MAX_LARGE_BODIES=0 must be refused, got {result:?}"
    );
}
