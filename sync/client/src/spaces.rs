//! The requests of the data protocol (appendix Б.3–Б.6): spaces, bodies, commits, the change feed
//! and the notification stream (П20–П34). Like [`crate::api`], one method per request and no
//! logic; the engine of the application drives them.

use std::time::Duration;

use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::engine::{
    BlobState, ChangeEntry, ChangesPage, CommitAccepted, CommitItem, CommitReply, VersionConflict,
};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

use crate::api::{
    bad, error_from, hex_array, hex_bytes, number_field, read_body, retry_after, signed_field,
    transport_error, DeviceToken, ServerInfo, SyncClient,
};
use crate::error::ClientError;

/// Time for one part of a body to go (8 MiB on a slow line) or to come.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A notification stream stays open as long as the connection lives.
const STREAM_TIMEOUT: Duration = Duration::from_secs(60 * 60 * 24 * 7);
/// The longest line of a stream the client accepts; a longer one is not a server of ours.
const MAX_LINE_BYTES: usize = 64 * 1024;

fn hex16(bytes: &[u8; 16]) -> String {
    hex::encode(bytes)
}

fn space_path(space: &[u8; 16], suffix: &str) -> String {
    format!("/v1/spaces/{}{suffix}", hex16(space))
}

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

/// The plan of the user in `GET /v1/account` (П61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountPlan {
    /// The key of the plan; `None` when the server has no plans.
    pub name: Option<String>,
    /// The label for people.
    pub title: Option<String>,
    /// The administrator pinned the user to this plan.
    pub pinned: bool,
}

/// The effective limits in `GET /v1/account`; `None` is no limit (П61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLimits {
    /// Number of spaces.
    pub max_spaces: Option<u64>,
    /// Sealed bytes in all spaces.
    pub max_total_bytes: Option<u64>,
    /// The largest sealed body.
    pub max_file_bytes: Option<u64>,
    /// Days of history.
    pub history_days: u64,
    /// The ceiling of the history in bytes (П50); needed by the line of the plan in the
    /// interface (У2). A key `limits.max_history_bytes` is asked of the server, see the report.
    pub max_history_bytes: Option<u64>,
}

/// What the user holds, in sealed bytes (П55, П61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountUsage {
    /// The latest versions.
    pub live_bytes: u64,
    /// Started bodies no version refers to.
    pub pending_bytes: u64,
    /// Replaced and deleted versions before the cleanup; not in the quota.
    pub history_bytes: u64,
    /// Number of spaces.
    pub spaces: u64,
}

/// A space in `GET /v1/account`: the entry of the listing and its sizes (П61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSpace {
    /// The entry as `GET /v1/spaces` gives it.
    pub entry: SpaceEntry,
    /// The latest versions in this space.
    pub live_bytes: u64,
    /// The history of this space.
    pub history_bytes: u64,
}

/// `GET /v1/account` (П61).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountView {
    /// The plan.
    pub plan: AccountPlan,
    /// The limits in force.
    pub limits: AccountLimits,
    /// The usage.
    pub usage: AccountUsage,
    /// The spaces with their sizes.
    pub spaces: Vec<AccountSpace>,
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
        let limits = self.limits()?;
        let instance: [u8; 16] = hex::decode(&self.instance_id)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| bad("the instance identifier has the wrong form"))?;
        Ok(amby_sync_core::engine::ServerInfo {
            protocol_min: self.protocol_min,
            protocol_max: self.protocol_max,
            instance_id: instance,
            max_blob_bytes: limits.max_blob_bytes,
            max_commit_items: limits.max_commit_items,
        })
    }

    /// The limits of the server (П8).
    pub fn limits(&self) -> Result<ServerLimits, ClientError> {
        let limits = self
            .rest
            .get("limits")
            .filter(|value| value.is_object())
            .ok_or_else(|| bad("the limits are missing"))?;
        Ok(ServerLimits {
            max_blob_bytes: number_field(limits, "max_blob_bytes")?,
            max_commit_items: u32::try_from(number_field(limits, "max_commit_items")?)
                .map_err(|_| bad("a limit is too large"))?,
            part_size: number_field(limits, "part_size")?,
        })
    }
}

/// The body of a download, read piece by piece (П24): the whole body is never held in memory by
/// the client.
pub struct BlobDownload {
    response: reqwest::Response,
}

impl BlobDownload {
    /// The next piece, or `None` at the end. A broken connection is an error, not an end.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, ClientError> {
        match self.response.chunk().await {
            Ok(Some(piece)) => Ok(Some(piece.to_vec())),
            Ok(None) => Ok(None),
            Err(error) => Err(transport_error(&error)),
        }
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
    response: reqwest::Response,
    buffer: Vec<u8>,
    name: String,
    data: String,
}

impl EventStream {
    /// The next event; `None` when the server closed the stream (a revoked token closes it,
    /// П34). A broken connection is an error.
    pub async fn next(&mut self) -> Result<Option<ServerEvent>, ClientError> {
        loop {
            while let Some(line) = self.take_line()? {
                if let Some(event) = self.feed(&line) {
                    return Ok(Some(event));
                }
            }
            match self.response.chunk().await {
                Ok(Some(piece)) => self.buffer.extend_from_slice(&piece),
                Ok(None) => return Ok(None),
                Err(error) => return Err(transport_error(&error)),
            }
        }
    }

    /// A whole line out of the buffer, without its end of line.
    fn take_line(&mut self) -> Result<Option<String>, ClientError> {
        let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') else {
            if self.buffer.len() > MAX_LINE_BYTES {
                return Err(bad("a line of the stream is too long"));
            }
            return Ok(None);
        };
        let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        Ok(Some(String::from_utf8_lossy(&line).into_owned()))
    }

    /// One line of the stream; an event when a block ends (or a ping comes).
    fn feed(&mut self, line: &str) -> Option<ServerEvent> {
        if line.is_empty() {
            let (name, data) = (
                std::mem::take(&mut self.name),
                std::mem::take(&mut self.data),
            );
            if name.is_empty() && data.is_empty() {
                return None;
            }
            return parse_event(&name, &data);
        }
        if let Some(comment) = line.strip_prefix(':') {
            return (comment.trim() == "ping").then_some(ServerEvent::Ping);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.name = value.to_string(),
            "data" => {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value);
            }
            _ => {}
        }
        None
    }
}

/// An event of ours, or `None` for one this client does not know (a newer server, Р13).
fn parse_event(name: &str, data: &str) -> Option<ServerEvent> {
    let value: Value = serde_json::from_str(data).ok()?;
    match name {
        "hello" => Some(ServerEvent::Hello {
            seq: number_field(&value, "seq").ok()?,
            instance_id: hex_array(&value, "instance_id").ok()?,
        }),
        "commit" => Some(ServerEvent::Commit {
            seq: number_field(&value, "seq").ok()?,
            device_id: hex_array(&value, "device_id").ok()?,
            items: number_field(&value, "items").ok()?,
        }),
        _ => None,
    }
}

fn entry_from(value: &Value) -> Result<ChangeEntry, ClientError> {
    let blob_id = match value.get("blob_id") {
        None | Some(Value::Null) => None,
        Some(_) => Some(BodyId::from_bytes(hex_array(value, "blob_id")?)),
    };
    let blob_size = match value.get("blob_size") {
        None | Some(Value::Null) => None,
        Some(_) => Some(number_field(value, "blob_size")?),
    };
    Ok(ChangeEntry {
        seq: number_field(value, "seq")?,
        item_id: ItemId::from_bytes(hex_array(value, "item_id")?),
        version: number_field(value, "version")?,
        header: hex_bytes(value, "header")?,
        blob_id,
        blob_size,
        deleted: bool_field(value, "deleted")?,
        device_id: hex_array(value, "device_id")?,
        committed_ms: signed_field(value, "committed_ms")?,
    })
}

fn bool_field(value: &Value, name: &'static str) -> Result<bool, ClientError> {
    value
        .get(name)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("a flag is missing"))
}

/// The conflicts of a `409 version_conflict` answer (П27); `None` for any other `409`.
fn version_conflicts(bytes: &[u8]) -> Option<Vec<VersionConflict>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value["error"]["code"].as_str() != Some("version_conflict") {
        return None;
    }
    value["error"]["details"]["conflicts"]
        .as_array()?
        .iter()
        .map(|entry| {
            Some(VersionConflict {
                item_id: ItemId::from_bytes(hex_array(entry, "item_id").ok()?),
                base_version: number_field(entry, "base_version").ok()?,
                current_version: number_field(entry, "current_version").ok()?,
            })
        })
        .collect()
}

impl SyncClient {
    /// `GET /v1/spaces` (П20).
    pub async fn list_spaces(&self, token: &DeviceToken) -> Result<Vec<SpaceEntry>, ClientError> {
        let value = self
            .send(Method::GET, "/v1/spaces", Some(token), None)
            .await?;
        let list = value
            .get("spaces")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of spaces is missing"))?;
        list.iter()
            .map(|entry| {
                Ok(SpaceEntry {
                    space_id: hex_array(entry, "space_id")?,
                    name_enc: hex_bytes(entry, "name_enc")?,
                    key_epoch: u32::try_from(number_field(entry, "key_epoch")?)
                        .map_err(|_| bad("an epoch is too large"))?,
                    wrapped_vk: hex_bytes(entry, "wrapped_vk")?,
                    seq: number_field(entry, "seq")?,
                    created_ms: signed_field(entry, "created_ms")?,
                })
            })
            .collect()
    }

    /// `POST /v1/spaces` (П20). A taken `space_id` is the error `space_exists`.
    pub async fn create_space(
        &self,
        token: &DeviceToken,
        space: &NewSpace<'_>,
    ) -> Result<(), ClientError> {
        let body = json!({
            "space_id": hex16(&space.space_id),
            "name_enc": hex::encode(space.name_enc),
            "key_epoch": space.key_epoch,
            "wrapped_vk": hex::encode(space.wrapped_vk),
        });
        self.send(Method::POST, "/v1/spaces", Some(token), Some(body))
            .await?;
        Ok(())
    }

    /// `GET …/changes?since=…&limit=…` (П31).
    pub async fn changes(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        since: u64,
        limit: Option<u32>,
    ) -> Result<ChangesPage, ClientError> {
        let mut path = space_path(space, &format!("/changes?since={since}"));
        if let Some(limit) = limit {
            path.push_str(&format!("&limit={limit}"));
        }
        let value = self.send(Method::GET, &path, Some(token), None).await?;
        let list = value
            .get("changes")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of changes is missing"))?;
        Ok(ChangesPage {
            instance_id: hex_array(&value, "instance_id")?,
            seq: number_field(&value, "seq")?,
            since: number_field(&value, "since")?,
            next: number_field(&value, "next")?,
            more: bool_field(&value, "more")?,
            gap: bool_field(&value, "gap")?,
            changes: list.iter().map(entry_from).collect::<Result<_, _>>()?,
        })
    }

    /// `POST …/blobs` (П21): starts a body or finds out how far it got.
    pub async fn blob_start(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
        size: u64,
    ) -> Result<BlobState, ClientError> {
        let value = self
            .send(
                Method::POST,
                &space_path(space, "/blobs"),
                Some(token),
                Some(json!({ "blob_id": hex16(blob.as_bytes()), "size": size })),
            )
            .await?;
        blob_state_of(&value)
    }

    /// `PUT …/blobs/{id}/parts/{n}` (П22).
    pub async fn blob_put_part(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
        part: u64,
        bytes: Vec<u8>,
    ) -> Result<(), ClientError> {
        let path = space_path(
            space,
            &format!("/blobs/{}/parts/{part}", hex16(blob.as_bytes())),
        );
        let response = self
            .builder(Method::PUT, &path, Some(token))
            .timeout(TRANSFER_TIMEOUT)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let status = response.status();
        let wait = retry_after(&response);
        let answer = read_body(response).await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(error_from(status.as_u16(), wait, &answer))
        }
    }

    /// `POST …/blobs/{id}/complete` (П23).
    pub async fn blob_complete(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
    ) -> Result<(), ClientError> {
        let path = space_path(
            space,
            &format!("/blobs/{}/complete", hex16(blob.as_bytes())),
        );
        self.send(Method::POST, &path, Some(token), Some(json!({})))
            .await?;
        Ok(())
    }

    /// `GET …/blobs/{id}` (П24): the sealed body as a stream of pieces.
    pub async fn blob_download(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
    ) -> Result<BlobDownload, ClientError> {
        let path = space_path(space, &format!("/blobs/{}", hex16(blob.as_bytes())));
        let response = self
            .builder(Method::GET, &path, Some(token))
            .timeout(TRANSFER_TIMEOUT)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        if !response.status().is_success() {
            let (status, wait) = (response.status().as_u16(), retry_after(&response));
            let bytes = read_body(response).await?;
            return Err(error_from(status, wait, &bytes));
        }
        Ok(BlobDownload { response })
    }

    /// `POST …/commit` (П26–П28). `409 version_conflict` is the answer
    /// [`CommitReply::Conflict`], not an error.
    pub async fn commit(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, ClientError> {
        let body = json!({
            "commit_id": hex16(commit_id),
            "items": items.iter().map(|item| json!({
                "item_id": hex16(item.item_id.as_bytes()),
                "base_version": item.base_version,
                "header": hex::encode(&item.header),
                "blob_id": item.blob_id.map(|blob| hex16(blob.as_bytes())),
                "deleted": item.deleted,
            })).collect::<Vec<_>>(),
        });
        let response = self
            .builder(Method::POST, &space_path(space, "/commit"), Some(token))
            .json(&body)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        let status = response.status();
        let wait = retry_after(&response);
        let bytes = read_body(response).await?;
        if status == StatusCode::CONFLICT {
            if let Some(conflicts) = version_conflicts(&bytes) {
                return Ok(CommitReply::Conflict(conflicts));
            }
        }
        if !status.is_success() {
            return Err(error_from(status.as_u16(), wait, &bytes));
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| bad("the answer is not JSON"))?;
        let versions = value
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of versions is missing"))?
            .iter()
            .map(|entry| {
                Ok((
                    ItemId::from_bytes(hex_array(entry, "item_id")?),
                    number_field(entry, "version")?,
                ))
            })
            .collect::<Result<_, ClientError>>()?;
        Ok(CommitReply::Accepted(CommitAccepted {
            seq: number_field(&value, "seq")?,
            replayed: bool_field(&value, "replayed")?,
            versions,
        }))
    }

    /// `GET …/events` (П34): opens the notification stream.
    pub async fn events(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
    ) -> Result<EventStream, ClientError> {
        let response = self
            .builder(Method::GET, &space_path(space, "/events"), Some(token))
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .timeout(STREAM_TIMEOUT)
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        if !response.status().is_success() {
            let (status, wait) = (response.status().as_u16(), retry_after(&response));
            let bytes = read_body(response).await?;
            return Err(error_from(status, wait, &bytes));
        }
        Ok(EventStream {
            response,
            buffer: Vec::new(),
            name: String::new(),
            data: String::new(),
        })
    }
}

impl SyncClient {
    /// `GET /v1/account` (П61). A server without it answers `404 not_found`: the caller goes on
    /// as before (Р13).
    pub async fn account(&self, token: &DeviceToken) -> Result<AccountView, ClientError> {
        let value = self
            .send(Method::GET, "/v1/account", Some(token), None)
            .await?;
        let object = |name: &'static str| {
            value
                .get(name)
                .filter(|inner| inner.is_object())
                .ok_or_else(|| bad("a part of the account is missing"))
        };
        let plan = object("plan")?;
        let limits = object("limits")?;
        let usage = object("usage")?;
        let optional_text =
            |inner: &Value, name: &str| inner.get(name).and_then(Value::as_str).map(str::to_string);
        let optional_number = |inner: &Value, name: &'static str| match inner.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(_) => number_field(inner, name).map(Some),
        };
        let spaces = value
            .get("spaces")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of spaces is missing"))?
            .iter()
            .map(|entry| {
                Ok(AccountSpace {
                    entry: SpaceEntry {
                        space_id: hex_array(entry, "space_id")?,
                        name_enc: hex_bytes(entry, "name_enc")?,
                        key_epoch: u32::try_from(number_field(entry, "key_epoch")?)
                            .map_err(|_| bad("an epoch is too large"))?,
                        wrapped_vk: hex_bytes(entry, "wrapped_vk")?,
                        seq: number_field(entry, "seq")?,
                        created_ms: signed_field(entry, "created_ms")?,
                    },
                    live_bytes: number_field(entry, "live_bytes")?,
                    history_bytes: number_field(entry, "history_bytes")?,
                })
            })
            .collect::<Result<Vec<_>, ClientError>>()?;
        Ok(AccountView {
            plan: AccountPlan {
                name: optional_text(plan, "name"),
                title: optional_text(plan, "title"),
                pinned: bool_field(plan, "pinned")?,
            },
            limits: AccountLimits {
                max_spaces: optional_number(limits, "max_spaces")?,
                max_total_bytes: optional_number(limits, "max_total_bytes")?,
                max_file_bytes: optional_number(limits, "max_file_bytes")?,
                history_days: number_field(limits, "history_days")?,
                max_history_bytes: optional_number(limits, "max_history_bytes")?,
            },
            usage: AccountUsage {
                live_bytes: number_field(usage, "live_bytes")?,
                pending_bytes: number_field(usage, "pending_bytes")?,
                history_bytes: number_field(usage, "history_bytes")?,
                spaces: number_field(usage, "spaces")?,
            },
            spaces,
        })
    }

    /// `POST …/blobs` with the credit hint `replaces` (П56-б): the item whose current body the new
    /// one replaces. Without a hint it is [`SyncClient::blob_start`].
    pub async fn blob_start_replacing(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
        size: u64,
        replaces: &ItemId,
    ) -> Result<BlobState, ClientError> {
        let value = self
            .send(
                Method::POST,
                &space_path(space, "/blobs"),
                Some(token),
                Some(json!({
                    "blob_id": hex16(blob.as_bytes()),
                    "size": size,
                    "replaces": hex16(replaces.as_bytes()),
                })),
            )
            .await?;
        blob_state_of(&value)
    }

    /// `DELETE …/blobs/{id}` (П56-д): drops an own body no version refers to.
    pub async fn blob_delete(
        &self,
        token: &DeviceToken,
        space: &[u8; 16],
        blob: &BodyId,
    ) -> Result<(), ClientError> {
        self.send(
            Method::DELETE,
            &space_path(space, &format!("/blobs/{}", hex16(blob.as_bytes()))),
            Some(token),
            None,
        )
        .await?;
        Ok(())
    }
}

fn blob_state_of(value: &Value) -> Result<BlobState, ClientError> {
    Ok(BlobState {
        size: number_field(value, "size")?,
        uploaded: value
            .get("uploaded")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("the list of parts is missing"))?
            .iter()
            .map(|part| part.as_u64().ok_or_else(|| bad("a part number is wrong")))
            .collect::<Result<_, _>>()?,
        complete: bool_field(value, "complete")?,
    })
}
