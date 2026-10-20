//! Errors of the client (П4, table Б.0.1). A caller looks at [`ClientError::code`], never at the
//! text of the server (П4: "the client never parses `message`").

use amby_sync_core::crypto::CryptoError;

/// Why a request or a flow failed.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The address cannot be used (empty, not `http(s)`, with a user name, ...). П41.
    #[error("the server address is not valid: {0}")]
    InvalidUrl(&'static str),
    /// `http://` for a host that is not local and without the "local network" switch. П41, Р11.
    #[error("the server address must start with https://")]
    InsecureUrl,
    /// The user name is not a name of the server (П11); checked before an account is created.
    #[error("the user name is not valid")]
    InvalidUsername,
    /// The name of the device is longer than 64 bytes (Ф34).
    #[error("the device name is not valid")]
    InvalidDeviceName,
    /// No connection: DNS, refused, TLS, reset. The text never contains the address.
    #[error("cannot reach the server")]
    Network,
    /// The server did not answer in time.
    #[error("the server did not answer in time")]
    Timeout,
    /// The server answered with an error (П4).
    #[error("{}", describe(.code))]
    Api {
        /// HTTP status.
        status: u16,
        /// The machine code of Б.0.1 (an unknown code of a newer server is kept as it is).
        code: String,
        /// `Retry-After` of a `429`, in seconds (П16).
        retry_after_secs: Option<u64>,
    },
    /// The answer is not what the protocol says (not JSON, a field is missing or has a wrong
    /// size). The text never contains the answer itself.
    #[error("unexpected answer from the server: {0}")]
    BadResponse(&'static str),
    /// The server speaks other protocol versions than this client (П9, Р13).
    #[error("the server speaks protocol {min}-{max}, this client speaks 1")]
    UnsupportedServer {
        /// Lowest protocol version of the server.
        min: u32,
        /// Highest protocol version of the server.
        max: u32,
    },
    /// The server's answer cannot be decrypted with the key we have: a wrong recovery code
    /// that still has the right look, or a damaged answer (О3, С12).
    #[error("the answer of the server cannot be decrypted")]
    CannotDecrypt,
    /// Another cryptography error (Ф8: parameters of the server outside the limits, ...).
    #[error("cryptography: {0}")]
    Crypto(#[from] CryptoError),
}

impl ClientError {
    /// A stable machine name of the error for the interface and for tests: the code of the
    /// server for [`ClientError::Api`] (Б.0.1), otherwise `invalid_url`, `insecure_url`,
    /// `invalid_username`, `invalid_device_name`, `network`, `timeout`, `bad_response`,
    /// `unsupported_server`, `cannot_decrypt` or `crypto`.
    pub fn code(&self) -> &str {
        todo!("П4")
    }

    /// Seconds to wait before the next try, from `Retry-After` of a `429` (П16).
    pub fn retry_after_secs(&self) -> Option<u64> {
        todo!("П16")
    }
}

/// A plain sentence for a machine code of Б.0.1, for logs and for programs without translations.
/// An unknown code gives a general sentence that still names the code.
pub fn describe(code: &str) -> String {
    let _ = code;
    todo!("П4")
}
