//! Settings from the environment (П40, П41, table Б.9). The tests feed a map of variables and
//! look at the result, never at how it is parsed.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::path::PathBuf;

use amby_sync_server::{Config, ConfigError};

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn parse(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
    Config::from_map(&vars(pairs))
}

fn parse_ok(pairs: &[(&str, &str)]) -> Config {
    parse(pairs).unwrap_or_else(|error| panic!("the settings were refused: {error}"))
}

#[test]
fn an_empty_environment_gives_the_defaults_of_the_table() {
    // П40: the defaults of Б.9; Р11: 512 MiB, 24 hours; Р3, Р8: 30 days; П16: 5 in 900 seconds.
    assert_eq!(parse_ok(&[]), Config::default());
}

#[test]
fn the_defaults_are_the_values_the_plan_names() {
    // Р11, Р8, П16, П17, П25: the numbers the owner and the plan fixed.
    let config = parse_ok(&[]);
    assert_eq!(config.max_blob_bytes, 536_870_912);
    assert_eq!(config.retain_version_days, 30);
    assert_eq!(config.orphan_blob_hours, 24);
    assert_eq!(config.enroll_code_hours, 24);
    assert_eq!(config.login_max_failures, 5);
    assert_eq!(config.login_window_secs, 900);
    assert_eq!(config.data_dir, PathBuf::from("/data"));
}

#[test]
fn every_variable_of_the_table_is_read() {
    // П40: the whole of Б.9.
    let config = parse_ok(&[
        ("AMBY_SYNC_DATA_DIR", "/srv/amby"),
        ("AMBY_SYNC_LISTEN", "127.0.0.1:9000"),
        ("AMBY_SYNC_PUBLIC_URL", "https://sync.example.org"),
        ("AMBY_SYNC_MAX_BLOB_BYTES", "1000"),
        ("AMBY_SYNC_MAX_COMMIT_ITEMS", "7"),
        ("AMBY_SYNC_MAX_HEADER_BYTES", "999"),
        ("AMBY_SYNC_MAX_JSON_BYTES", "4096"),
        ("AMBY_SYNC_RETAIN_VERSION_DAYS", "10"),
        ("AMBY_SYNC_ORPHAN_BLOB_HOURS", "2"),
        ("AMBY_SYNC_ENROLL_CODE_HOURS", "3"),
        ("AMBY_SYNC_LOGIN_MAX_FAILURES", "9"),
        ("AMBY_SYNC_LOGIN_WINDOW_SECS", "60"),
        ("AMBY_SYNC_SSE_KEEPALIVE_SECS", "5"),
    ]);
    assert_eq!(config.data_dir, PathBuf::from("/srv/amby"));
    assert_eq!(config.listen, "127.0.0.1:9000");
    assert_eq!(config.public_url, "https://sync.example.org");
    assert_eq!(config.max_blob_bytes, 1000);
    assert_eq!(config.max_commit_items, 7);
    assert_eq!(config.max_header_bytes, 999);
    assert_eq!(config.max_json_bytes, 4096);
    assert_eq!(config.retain_version_days, 10);
    assert_eq!(config.orphan_blob_hours, 2);
    assert_eq!(config.enroll_code_hours, 3);
    assert_eq!(config.login_max_failures, 9);
    assert_eq!(config.login_window_secs, 60);
    assert_eq!(config.sse_keepalive_secs, 5);
}

#[test]
fn an_unknown_variable_with_the_prefix_is_ignored() {
    // П40, Р13: a newer deployment file must not stop an older server.
    assert_eq!(
        parse_ok(&[("AMBY_SYNC_SOMETHING_NEW", "1")]),
        Config::default()
    );
}

#[test]
fn a_bad_value_of_a_known_variable_refuses_to_start() {
    // П40: a clear refusal, not a silent default.
    for (name, value) in [
        ("AMBY_SYNC_MAX_BLOB_BYTES", "lots"),
        ("AMBY_SYNC_LOGIN_MAX_FAILURES", "-1"),
        ("AMBY_SYNC_ORPHAN_BLOB_HOURS", "1.5"),
        ("AMBY_SYNC_ALLOW_HTTP", "maybe"),
    ] {
        match parse(&[(name, value)]) {
            Err(ConfigError::Invalid { name: got, .. }) => assert_eq!(got, name),
            other => panic!("{name}={value} must be refused, got {other:?}"),
        }
    }
}

#[test]
fn zero_retention_is_refused() {
    // Р8, П35: zero days would delete every old version at once; the owner's data comes first.
    for name in [
        "AMBY_SYNC_RETAIN_VERSION_DAYS",
        "AMBY_SYNC_ORPHAN_BLOB_HOURS",
        "AMBY_SYNC_ENROLL_CODE_HOURS",
    ] {
        let result = parse(&[(name, "0")]);
        assert!(
            matches!(result, Err(ConfigError::Invalid { .. })),
            "{name}=0 must be refused, got {result:?}"
        );
    }
}

#[test]
fn a_public_http_address_needs_the_explicit_switch() {
    // Р11, П41: HTTPS is mandatory; plain HTTP only for localhost or by the switch.
    let result = parse(&[("AMBY_SYNC_PUBLIC_URL", "http://sync.example.org")]);
    assert!(
        matches!(result, Err(ConfigError::Invalid { .. })),
        "a public http:// address must be refused, got {result:?}"
    );
    parse_ok(&[
        ("AMBY_SYNC_PUBLIC_URL", "http://sync.example.org"),
        ("AMBY_SYNC_ALLOW_HTTP", "1"),
    ]);
    parse_ok(&[("AMBY_SYNC_PUBLIC_URL", "https://sync.example.org")]);
}

#[test]
fn plain_http_is_fine_for_a_local_host() {
    // Р11, П41: localhost, 127.0.0.1 and [::1] need no switch.
    for url in [
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://[::1]:8080",
    ] {
        parse_ok(&[("AMBY_SYNC_PUBLIC_URL", url)]);
    }
}
