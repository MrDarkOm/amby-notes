//! Versioned request and response shared by the desktop and standalone CLI.

#[cfg(unix)]
#[path = "unix.rs"]
mod transport;
#[cfg(windows)]
#[path = "windows.rs"]
mod transport;

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

use crate::structural::{Operation, Outcome};

pub use transport::{Listener, Stream};

pub const VERSION: u32 = 1;
const REQUEST_BYTES: usize = 64 * 1024;
const RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub vault: PathBuf,
    pub action: Action,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Rename {
        path: String,
        name: String,
    },
    Move {
        path: String,
        folder: String,
    },
    Archive {
        path: String,
    },
    Restore {
        path: String,
    },
    Recover,
    Tool {
        grant: String,
        request: crate::vault_tools::Mutation,
    },
}

impl Action {
    pub fn operation(&self) -> Option<Operation<'_>> {
        Some(match self {
            Self::Rename { path, name } => Operation::Rename { path, name },
            Self::Move { path, folder } => Operation::Move { path, folder },
            Self::Archive { path } => Operation::Archive { path },
            Self::Restore { path } => Operation::Restore { path },
            Self::Recover | Self::Tool { .. } => return None,
        })
    }
}

impl From<Operation<'_>> for Action {
    fn from(operation: Operation<'_>) -> Self {
        match operation {
            Operation::Rename { path, name } => Self::Rename {
                path: path.into(),
                name: name.into(),
            },
            Operation::Move { path, folder } => Self::Move {
                path: path.into(),
                folder: folder.into(),
            },
            Operation::Archive { path } => Self::Archive { path: path.into() },
            Operation::Restore { path } => Self::Restore { path: path.into() },
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub version: u32,
    pub result: Result<Payload, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Payload {
    Mutation(Outcome),
    Recovery(bool),
    Tool(serde_json::Value),
}

async fn read_frame<T: DeserializeOwned>(
    stream: &mut (impl AsyncRead + Unpin),
    limit: usize,
) -> io::Result<T> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid CLI frame length",
        ));
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> io::Result<()> {
    let length = u32::try_from(data.len()).map_err(io::Error::other)?;
    stream.write_u32(length).await?;
    stream.write_all(data).await?;
    stream.flush().await
}

pub async fn read_request(stream: &mut Stream) -> io::Result<Result<Request, &'static str>> {
    let envelope: serde_json::Value =
        timeout(FRAME_TIMEOUT, read_frame(stream, REQUEST_BYTES)).await??;
    let version = envelope.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(u64::from(VERSION)) {
        return Ok(Err("desktopProtocolVersion"));
    }
    Ok(serde_json::from_value(envelope).map_err(|_| "invalidArguments"))
}

pub async fn write_response(
    stream: &mut Stream,
    result: Result<Payload, String>,
) -> io::Result<()> {
    let response = Response {
        version: VERSION,
        result,
    };
    let mut bytes = serde_json::to_vec(&response).map_err(io::Error::other)?;
    if bytes.len() > RESPONSE_BYTES {
        // The mutation may already have committed. Do not report a retryable failure.
        bytes = serde_json::to_vec(&Response {
            version: VERSION,
            result: Err("desktopRequestInterrupted".into()),
        })
        .map_err(io::Error::other)?;
    }
    timeout(FRAME_TIMEOUT, write_frame(stream, &bytes)).await??;
    // Keep the server endpoint alive until the client has read the reply.
    // This also makes named-pipe response delivery independent of close timing.
    let _ = timeout(FRAME_TIMEOUT, stream.read_u8()).await;
    Ok(())
}

pub async fn dispatch(profile: &Path, request: Request) -> Result<Payload, String> {
    let data = serde_json::to_vec(&request).map_err(|_| "invalidArguments")?;
    if data.len() > REQUEST_BYTES {
        return Err("invalidArguments".into());
    }
    let mut stream = timeout(FRAME_TIMEOUT, transport::connect(profile))
        .await
        .map_err(|_| "vaultBusy")?
        .map_err(|_| "vaultBusy")?;
    // After connecting there is no retry or fallback. A lost response cannot
    // distinguish a rejected request from one that was already published.
    timeout(FRAME_TIMEOUT, write_frame(&mut stream, &data))
        .await
        .map_err(|_| "desktopRequestInterrupted")?
        .map_err(|_| "desktopRequestInterrupted")?;
    let response: Response = timeout(RESPONSE_TIMEOUT, read_frame(&mut stream, RESPONSE_BYTES))
        .await
        .map_err(|_| "desktopRequestInterrupted")?
        .map_err(|_| "desktopRequestInterrupted")?;
    if response.version != VERSION {
        return Err("desktopRequestInterrupted".into());
    }
    response.result
}

fn profile_key(profile: &Path) -> io::Result<String> {
    use sha2::{Digest, Sha256};
    let profile = profile.canonicalize()?;
    let digest = Sha256::digest(profile.as_os_str().as_encoded_bytes());
    Ok(format!("{digest:x}")[..24].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_reject_an_invalid_length_before_reading_a_body() {
        for length in [0, REQUEST_BYTES as u32 + 1] {
            let (mut sender, mut receiver) = tokio::io::duplex(8);
            sender.write_u32(length).await.unwrap();
            let result = read_frame::<Request>(&mut receiver, REQUEST_BYTES).await;
            assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::InvalidData));
        }
    }
}
