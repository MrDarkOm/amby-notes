//! The server for one space as the engine's port [`amby_sync_core::engine::Remote`], over the
//! asynchronous client of `sync/client` (docs/sync-plan.md, appendix Б). The engine runs on its
//! own thread and is synchronous; each call waits for the answer on the runtime of the
//! application. It must never be called from a task of that runtime.

use std::io::Read;

use amby_sync_client::{BlobDownload, ClientError, DeviceToken, SyncClient};
use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::engine::{
    BlobState, ChangesPage, CommitItem, CommitReply, Remote, RemoteError, ServerInfo,
};

/// A signed-in device and a space.
pub struct HttpRemote {
    handle: tokio::runtime::Handle,
    client: SyncClient,
    token: DeviceToken,
    space: [u8; 16],
}

impl HttpRemote {
    /// A remote for `space`; calls run on `handle`.
    pub fn new(
        handle: tokio::runtime::Handle,
        client: SyncClient,
        token: DeviceToken,
        space: [u8; 16],
    ) -> Self {
        Self {
            handle,
            client,
            token,
            space,
        }
    }
}

/// How a failure of the client reads for the engine: a lost connection, a timeout and an answer
/// that is not the protocol are [`RemoteError::Network`] (it is unknown whether the request was
/// applied, С1, С2); `401 token_revoked` is [`RemoteError::Revoked`], any other `401` is
/// [`RemoteError::Unauthorized`]; any other answer of the server is [`RemoteError::Rejected`].
pub fn remote_error(error: ClientError) -> RemoteError {
    match error {
        ClientError::Api { status, code, .. } => match (status, code.as_str()) {
            (401, "token_revoked") => RemoteError::Revoked,
            (401, _) => RemoteError::Unauthorized,
            _ => RemoteError::Rejected { status, code },
        },
        other => RemoteError::Network(other.code().to_string()),
    }
}

/// A body being read as a stream: each `read` waits for the next piece on the runtime.
struct BodyReader<'a> {
    handle: &'a tokio::runtime::Handle,
    download: BlobDownload,
    piece: Vec<u8>,
    at: usize,
    done: bool,
}

impl Read for BodyReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        while self.at == self.piece.len() {
            if self.done {
                return Ok(0);
            }
            match self.handle.block_on(self.download.chunk()) {
                Ok(Some(piece)) => {
                    self.piece = piece;
                    self.at = 0;
                }
                Ok(None) => {
                    self.done = true;
                    return Ok(0);
                }
                // A cut connection is not the end of the body (С1).
                Err(error) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionAborted,
                        error.code().to_string(),
                    ));
                }
            }
        }
        let n = buffer.len().min(self.piece.len() - self.at);
        buffer[..n].copy_from_slice(&self.piece[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

impl Remote for HttpRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        let info = self
            .handle
            .block_on(self.client.info())
            .map_err(remote_error)?;
        info.to_engine().map_err(remote_error)
    }

    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        self.handle
            .block_on(self.client.changes(&self.token, &self.space, since, limit))
            .map_err(remote_error)
    }

    fn blob_start(&mut self, blob: &BodyId, size: u64) -> Result<BlobState, RemoteError> {
        self.handle
            .block_on(self.client.blob_start(&self.token, &self.space, blob, size))
            .map_err(remote_error)
    }

    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError> {
        self.handle
            .block_on(self.client.blob_put_part(
                &self.token,
                &self.space,
                blob,
                part,
                bytes.to_vec(),
            ))
            .map_err(remote_error)
    }

    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        self.handle
            .block_on(self.client.blob_complete(&self.token, &self.space, blob))
            .map_err(remote_error)
    }

    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        let download = self
            .handle
            .block_on(self.client.blob_download(&self.token, &self.space, blob))
            .map_err(remote_error)?;
        Ok(Box::new(BodyReader {
            handle: &self.handle,
            download,
            piece: Vec::new(),
            at: 0,
            done: false,
        }))
    }

    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        self.handle
            .block_on(
                self.client
                    .commit(&self.token, &self.space, commit_id, items),
            )
            .map_err(remote_error)
    }
}
