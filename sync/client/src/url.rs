//! The address of a server and the `https://` rule (П41, Р11).

use std::net::{Ipv4Addr, Ipv6Addr};

use url::{Host, Url};

use crate::error::ClientError;

/// A checked address of a sync server, without a trailing slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerUrl {
    text: String,
    host: String,
}

/// Whether `host` is this computer: `localhost`, `127.0.0.1` or `[::1]`, compared whole (П41).
fn is_local(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => *address == Ipv4Addr::LOCALHOST,
        Host::Ipv6(address) => *address == Ipv6Addr::LOCALHOST,
    }
}

impl ServerUrl {
    /// Reads an address typed by a person (П41, Р11).
    ///
    /// - Surrounding spaces are removed; an empty text is `InvalidUrl`.
    /// - An address without `://` gets `https://` in front.
    /// - Only `http` and `https` are accepted; a user name, a password, a query or a fragment in
    ///   the address are `InvalidUrl`.
    /// - `http://` is accepted only for the host `localhost`, `127.0.0.1` or `[::1]`, or when
    ///   `allow_http` ("in the local network") is set; otherwise `InsecureUrl`.
    /// - A path prefix is kept (a server behind a reverse proxy), the trailing `/` is dropped.
    pub fn parse(input: &str, allow_http: bool) -> Result<Self, ClientError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(ClientError::InvalidUrl("the address is empty"));
        }
        let with_scheme = if trimmed.contains("://") {
            trimmed.to_string()
        } else {
            format!("https://{trimmed}")
        };
        let url = Url::parse(&with_scheme)
            .map_err(|_| ClientError::InvalidUrl("the address cannot be read"))?;
        let secure = match url.scheme() {
            "https" => true,
            "http" => false,
            _ => return Err(ClientError::InvalidUrl("only http and https are supported")),
        };
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ClientError::InvalidUrl(
                "a user name or password in the address",
            ));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(ClientError::InvalidUrl(
                "a query or a fragment in the address",
            ));
        }
        let Some(host) = url.host() else {
            return Err(ClientError::InvalidUrl("the address has no host"));
        };
        if !secure && !allow_http && !is_local(&host) {
            return Err(ClientError::InsecureUrl);
        }
        let mut host_display = url.host_str().unwrap_or_default().to_string();
        if let Some(port) = url.port() {
            host_display.push_str(&format!(":{port}"));
        }
        Ok(Self {
            text: url.as_str().trim_end_matches('/').to_string(),
            host: host_display,
        })
    }

    /// The address without a trailing slash, e.g. `https://sync.example.com`.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The host (with the port, if any) for showing "connected to …".
    pub fn host_display(&self) -> String {
        self.host.clone()
    }

    /// The full address of an endpoint: `endpoint("/v1/info")`.
    pub fn endpoint(&self, path: &str) -> String {
        format!("{}{}", self.text, path)
    }
}
