//! The server for one space as the engine's port [`amby_sync_core::engine::Remote`], over the
//! asynchronous client of `sync/client` (docs/sync-plan.md, appendix Б). The engine runs on its
//! own thread and is synchronous; each call waits for the answer on the runtime of the
//! application. It must never be called from a task of that runtime.

use amby_sync_client::{ClientError, DeviceToken, SyncClient};
use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::engine::{
    BlobState, ChangesPage, CommitItem, CommitReply, Remote, RemoteError, ServerInfo,
};
use std::io::Read;

/// A signed-in device and a space.
pub struct HttpRemote {
    _handle: tokio::runtime::Handle,
    _client: SyncClient,
    _token: DeviceToken,
    _space: [u8; 16],
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
            _handle: handle,
            _client: client,
            _token: token,
            _space: space,
        }
    }
}

/// How a failure of the client reads for the engine: a lost connection, a timeout and an answer
/// that is not the protocol are [`RemoteError::Network`] (it is unknown whether the request was
/// applied, С1, С2); `401 token_revoked` is [`RemoteError::Revoked`], any other `401` is
/// [`RemoteError::Unauthorized`]; any other answer of the server is [`RemoteError::Rejected`].
pub fn remote_error(_error: ClientError) -> RemoteError {
    todo!("Э4: remote_error")
}

impl Remote for HttpRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        todo!("Э4: HttpRemote::info")
    }

    fn changes(&mut self, _since: u64, _limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        todo!("Э4: HttpRemote::changes")
    }

    fn blob_start(&mut self, _blob: &BodyId, _size: u64) -> Result<BlobState, RemoteError> {
        todo!("Э4: HttpRemote::blob_start")
    }

    fn blob_put_part(
        &mut self,
        _blob: &BodyId,
        _part: u64,
        _bytes: &[u8],
    ) -> Result<(), RemoteError> {
        todo!("Э4: HttpRemote::blob_put_part")
    }

    fn blob_complete(&mut self, _blob: &BodyId) -> Result<(), RemoteError> {
        todo!("Э4: HttpRemote::blob_complete")
    }

    fn blob_download(&mut self, _blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        todo!("Э4: HttpRemote::blob_download")
    }

    fn commit(
        &mut self,
        _commit_id: &[u8; 16],
        _items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        todo!("Э4: HttpRemote::commit")
    }
}
