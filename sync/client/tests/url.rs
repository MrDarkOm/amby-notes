//! The address of a server and the `https://` rule (П41, Р11): the client demands it by itself.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_client::{ClientError, ServerUrl};

fn parse(input: &str) -> Result<ServerUrl, ClientError> {
    ServerUrl::parse(input, false)
}

#[test]
fn https_addresses_are_accepted_and_written_without_a_trailing_slash() {
    // П41
    assert_eq!(
        parse("https://sync.example.com").unwrap().as_str(),
        "https://sync.example.com"
    );
    assert_eq!(
        parse("https://sync.example.com/").unwrap().as_str(),
        "https://sync.example.com"
    );
    assert_eq!(
        parse("  https://sync.example.com:8443  ").unwrap().as_str(),
        "https://sync.example.com:8443"
    );
}

#[test]
fn an_address_without_a_scheme_gets_https() {
    // П41: the safe guess for what a person types
    assert_eq!(
        parse("sync.example.com").unwrap().as_str(),
        "https://sync.example.com"
    );
    assert_eq!(
        parse("sync.example.com:8443").unwrap().as_str(),
        "https://sync.example.com:8443"
    );
}

#[test]
fn plain_http_is_refused_for_a_remote_host() {
    // П41, Р11: HTTPS is required
    for address in [
        "http://sync.example.com",
        "http://192.168.1.20:8080",
        "HTTP://Sync.Example.com",
    ] {
        let error = parse(address).unwrap_err();
        assert_eq!(error.code(), "insecure_url", "{address}");
        assert!(matches!(error, ClientError::InsecureUrl), "{address}");
    }
}

#[test]
fn plain_http_is_fine_for_this_computer() {
    // П41: localhost, 127.0.0.1 and [::1]
    for address in [
        "http://localhost:8080",
        "http://LOCALHOST:8080",
        "http://127.0.0.1:8080",
        "http://[::1]:8080",
    ] {
        assert!(parse(address).is_ok(), "{address}");
    }
}

#[test]
fn the_local_network_switch_allows_plain_http_for_any_host() {
    // П41: "in the local network" is an explicit choice of the person
    let url = ServerUrl::parse("http://192.168.1.20:8080", true).unwrap();
    assert_eq!(url.as_str(), "http://192.168.1.20:8080");
}

#[test]
fn a_look_alike_of_localhost_is_not_localhost() {
    // П41: the host is compared whole, not by its beginning or end
    for address in [
        "http://localhost.evil.com",
        "http://evil-localhost",
        "http://127.0.0.1.evil.com",
    ] {
        assert_eq!(
            parse(address).unwrap_err().code(),
            "insecure_url",
            "{address}"
        );
    }
}

#[test]
fn other_schemes_and_odd_addresses_are_refused() {
    // П41: only http(s); no user name, query or fragment; not empty
    for address in [
        "",
        "   ",
        "ftp://sync.example.com",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:secret@sync.example.com",
        "https://user@sync.example.com",
        "https://sync.example.com/?token=1",
        "https://sync.example.com/#x",
        "https://",
        "https://exa mple.com",
    ] {
        let error = parse(address).unwrap_err();
        assert_eq!(error.code(), "invalid_url", "{address:?}");
    }
}

#[test]
fn a_path_prefix_is_kept_for_a_server_behind_a_proxy() {
    // Р11: a reverse proxy may serve the API under a prefix
    let url = parse("https://example.com/amby/").unwrap();
    assert_eq!(url.as_str(), "https://example.com/amby");
    assert_eq!(url.endpoint("/v1/info"), "https://example.com/amby/v1/info");
}

#[test]
fn an_endpoint_is_the_address_plus_the_path() {
    // П1
    let url = parse("https://sync.example.com").unwrap();
    assert_eq!(url.endpoint("/v1/info"), "https://sync.example.com/v1/info");
}

#[test]
fn the_host_for_display_has_no_scheme_and_keeps_a_port() {
    // «подключено к …»
    assert_eq!(
        parse("https://sync.example.com").unwrap().host_display(),
        "sync.example.com"
    );
    assert_eq!(
        parse("https://sync.example.com:8443/amby")
            .unwrap()
            .host_display(),
        "sync.example.com:8443"
    );
}

#[test]
fn the_address_does_not_show_a_default_port() {
    // so that the same server is not written two ways
    assert_eq!(
        parse("https://sync.example.com:443").unwrap().as_str(),
        "https://sync.example.com"
    );
}
