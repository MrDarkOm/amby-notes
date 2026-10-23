//! The requests of the data protocol (appendix Б.3–Б.6): spaces, bodies, commits, the change feed
//! and the notification stream (П20–П34). Like [`crate::api`], one method per request and no
//! logic; the engine of the application drives them.
//!
//! Interface of stage Э4 (tests first): the bodies are `todo!()` until the tests are reviewed.

use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::engine::{BlobState, ChangesPage, CommitItem, CommitReply};

use crate::api::{DeviceToken, ServerInfo, SyncClient};
use crate::error::ClientError;

/// One entry of `GET /v1/spaces` (П20).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceEntry {
    /// The identifier of the space.
    pub space_id: [u8; 16],
    /// The name sealed by Ф34 (105 bytes).
    pub name_enc: Vec<u8>,
    /// The epoch of the key of the space (always 1 in the first version, Ф3).
    pub key_epoch: u32,
    /// VK wrapped by AK (Ф12).
    pub wrapped_vk: Vec<u8>,
    /// The number of the last accepted commit (0 for a new space).
    pub seq: u64,
    /// When the space was created, Unix milliseconds.
    pub created_ms: i64,
}

/// What `POST /v1/spaces` sends (П20).
#[derive(Debug)]
pub struct NewSpace<'a> {
    /// The identifier the device chose; it is part of the AAD of the wrapped key (Ф12).
    pub space_id: [u8; 16],
    /// The name sealed by Ф34 (105 bytes).
    pub name_enc: &'a [u8],
    /// The epoch of the key.
    pub key_epoch: u32,
    /// VK wrapped by AK.
    pub wrapped_vk: &'a [u8],
}

/// The limits of the server that the engine needs (П8, П9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerLimits {
    /// The largest body after encryption.
    pub max_blob_bytes: u64,
    /// The most items in one commit.
    pub max_commit_items: u32,
    /// The size of a part of a body (always 8 MiB, П21).
    pub part_size: u64,
}

impl ServerInfo {
    /// The engine's view of `/v1/info`: protocol range, `instance_id` and the limits. A missing
    /// limit is [`ClientError::BadResponse`].
    pub fn to_engine(&self) -> Result<amby_sync_core::engine::ServerInfo, ClientError> {
        todo!("Э4: ServerInfo::to_engine")
    }

    /// The limits of the server (П8).
    pub fn limits(&self) -> Result<ServerLimits, ClientError> {
        todo!("Э4: ServerInfo::limits")
    }
}

/// The body of a download, read piece by piece (П24): the whole body is never held in memory by
/// the client.
pub struct BlobDownload {
    // The real field is the open response; the stub keeps nothing.
    _private: (),
}

impl BlobDownload {
    /// The next piece, or `None` at the end. A broken connection is an error, not an end.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, ClientError> {
        todo!("Э4: BlobDownload::chunk")
    }
}

/// What the notification stream says (П34). Events carry no headers and no paths: they only mean
/// "look at the feed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerEvent {
    /// Right after connecting: the head of the feed and the server instance.
    Hello {
        /// The head of the feed.
        seq: u64,
        /// The server instance.
        instance_id: [u8; 16],
    },
    /// A commit was accepted.
    Commit {
        /// Its number.
        seq: u64,
        /// The device that made it.
        device_id: [u8; 16],
        /// How many items it holds.
        items: u64,
    },
    /// A `: ping` comment: the connection is alive.
    Ping,
}

/// An open notification stream.
pub struct EventStream {
    _private: (),
}

impl EventStream {
    /// The next event; `None` when the server closed the stream (a revoked token closes it,
    /// П34). A broken connection is an error.
    pub async fn next(&mut self) -> Result<Option<ServerEvent>, ClientError> {
        todo!("Э4: EventStream::next")
    }
}

impl SyncClient {
    /// `GET /v1/spaces` (П20).
    pub async fn list_spaces(&self, _token: &DeviceToken) -> Result<Vec<SpaceEntry>, ClientError> {
        todo!("Э4: list_spaces")
    }

    /// `POST /v1/spaces` (П20). A taken `space_id` is the error `space_exists`.
    pub async fn create_space(
        &self,
        _token: &DeviceToken,
        _space: &NewSpace<'_>,
    ) -> Result<(), ClientError> {
        todo!("Э4: create_space")
    }

    /// `GET …/changes?since=…&limit=…` (П31).
    pub async fn changes(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _since: u64,
        _limit: Option<u32>,
    ) -> Result<ChangesPage, ClientError> {
        todo!("Э4: changes")
    }

    /// `POST …/blobs` (П21): starts a body or finds out how far it got.
    pub async fn blob_start(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _blob: &BodyId,
        _size: u64,
    ) -> Result<BlobState, ClientError> {
        todo!("Э4: blob_start")
    }

    /// `PUT …/blobs/{id}/parts/{n}` (П22).
    pub async fn blob_put_part(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _blob: &BodyId,
        _part: u64,
        _bytes: Vec<u8>,
    ) -> Result<(), ClientError> {
        todo!("Э4: blob_put_part")
    }

    /// `POST …/blobs/{id}/complete` (П23).
    pub async fn blob_complete(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _blob: &BodyId,
    ) -> Result<(), ClientError> {
        todo!("Э4: blob_complete")
    }

    /// `GET …/blobs/{id}` (П24): the sealed body as a stream of pieces.
    pub async fn blob_download(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _blob: &BodyId,
    ) -> Result<BlobDownload, ClientError> {
        todo!("Э4: blob_download")
    }

    /// `POST …/commit` (П26–П28). `409 version_conflict` is the answer
    /// [`CommitReply::Conflict`], not an error.
    pub async fn commit(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
        _commit_id: &[u8; 16],
        _items: &[CommitItem],
    ) -> Result<CommitReply, ClientError> {
        todo!("Э4: commit")
    }

    /// `GET …/events` (П34): opens the notification stream.
    pub async fn events(
        &self,
        _token: &DeviceToken,
        _space: &[u8; 16],
    ) -> Result<EventStream, ClientError> {
        todo!("Э4: events")
    }
}
