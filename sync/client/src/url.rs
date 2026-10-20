//! The address of a server and the `https://` rule (П41, Р11).

use crate::error::ClientError;

/// A checked address of a sync server, without a trailing slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerUrl(String);

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
        let _ = (input, allow_http);
        todo!("П41")
    }

    /// The address without a trailing slash, e.g. `https://sync.example.com`.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The host (with the port, if any) for showing "connected to …".
    pub fn host_display(&self) -> String {
        todo!("П41")
    }

    /// The full address of an endpoint: `endpoint("/v1/info")`.
    pub fn endpoint(&self, path: &str) -> String {
        let _ = path;
        todo!("П1")
    }
}
