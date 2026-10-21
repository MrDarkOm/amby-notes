//! The real server of stage Э2, reached over HTTP through the client of the conformance suite, as
//! an implementation of the [`Remote`] port. This is test code: the application will have its own.

use std::cell::RefCell;
use std::io::{Cursor, Read};
use std::rc::Rc;

use amby_sync_conformance::client::{hex16, unhex, Space};
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::engine::{
    BlobState, ChangeEntry, ChangesPage, CommitAccepted, CommitItem, CommitReply, Remote,
    RemoteError, ServerInfo, VersionConflict,
};
use serde_json::{json, Value};

/// A signed-in device and a space; the handle is shared with the world so that a reset of the
/// server can give the device a new token.
pub type SharedSpace = Rc<RefCell<Space>>;

pub struct HttpRemote {
    pub space: SharedSpace,
}

fn id16(text: &str) -> [u8; 16] {
    unhex(text).try_into().expect("an id of 16 bytes")
}

fn refused(status: u16, body: &Value) -> RemoteError {
    let code = body["error"]["code"].as_str().unwrap_or("").to_string();
    match (status, code.as_str()) {
        (401, "token_revoked") => RemoteError::Revoked,
        (401, _) => RemoteError::Unauthorized,
        _ => RemoteError::Rejected { status, code },
    }
}

fn check(resp: &amby_sync_conformance::Resp, ok: &[u16]) -> Result<Value, RemoteError> {
    if ok.contains(&resp.status) {
        Ok(serde_json::from_slice(&resp.body).unwrap_or(Value::Null))
    } else {
        let body: Value = serde_json::from_slice(&resp.body).unwrap_or(Value::Null);
        Err(refused(resp.status, &body))
    }
}

/// How many times a request was repeated because the transport failed (a refused or reset
/// connection of the in-process server under load, seen a few times in tens of thousands of
/// requests on macOS). Every request of the protocol is safe to repeat: bodies are written by
/// part number, a commit has its `commit_id` (П22, П28).
pub static TRANSPORT_RETRIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn retrying<T>(mut call: impl FnMut() -> T) -> T {
    for attempt in 0..5 {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(&mut call));
        match result {
            Ok(value) => return value,
            Err(payload) => {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_default();
                if !message.contains("transport failure") || attempt == 4 {
                    std::panic::resume_unwind(payload);
                }
                TRANSPORT_RETRIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    unreachable!("the loop returns or resumes the panic")
}

impl HttpRemote {
    pub fn new(space: SharedSpace) -> Self {
        Self { space }
    }

    fn space(&self) -> Space {
        self.space.borrow().clone()
    }
}

impl Remote for HttpRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.api.get("/v1/info", None));
        let body = check(&resp, &[200])?;
        Ok(ServerInfo {
            protocol_min: body["protocol"]["min"].as_u64().unwrap_or(0) as u32,
            protocol_max: body["protocol"]["max"].as_u64().unwrap_or(0) as u32,
            instance_id: id16(body["instance_id"].as_str().unwrap_or("")),
            max_blob_bytes: body["limits"]["max_blob_bytes"].as_u64().unwrap_or(0),
            max_commit_items: body["limits"]["max_commit_items"].as_u64().unwrap_or(0) as u32,
        })
    }

    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.changes(since, limit.map(u64::from)));
        let body = check(&resp, &[200])?;
        let changes = body["changes"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|c| ChangeEntry {
                        seq: c["seq"].as_u64().unwrap_or(0),
                        item_id: ItemId::from_bytes(id16(c["item_id"].as_str().unwrap_or(""))),
                        version: c["version"].as_u64().unwrap_or(0),
                        header: unhex(c["header"].as_str().unwrap_or("")),
                        blob_id: c["blob_id"].as_str().map(|s| BodyId::from_bytes(id16(s))),
                        blob_size: c["blob_size"].as_u64(),
                        deleted: c["deleted"].as_bool().unwrap_or(false),
                        device_id: id16(c["device_id"].as_str().unwrap_or(&"00".repeat(16))),
                        committed_ms: c["committed_ms"].as_i64().unwrap_or(0),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(ChangesPage {
            instance_id: id16(body["instance_id"].as_str().unwrap_or("")),
            seq: body["seq"].as_u64().unwrap_or(0),
            since: body["since"].as_u64().unwrap_or(0),
            next: body["next"].as_u64().unwrap_or(0),
            more: body["more"].as_bool().unwrap_or(false),
            gap: body["gap"].as_bool().unwrap_or(false),
            changes,
        })
    }

    fn blob_start(&mut self, blob: &BodyId, size: u64) -> Result<BlobState, RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.init_blob(blob, size));
        let body = check(&resp, &[200, 201])?;
        Ok(BlobState {
            size: body["size"].as_u64().unwrap_or(size),
            uploaded: body["uploaded"]
                .as_array()
                .map(|l| l.iter().filter_map(Value::as_u64).collect())
                .unwrap_or_default(),
            complete: body["complete"].as_bool().unwrap_or(false),
        })
    }

    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.put_part(blob, part, bytes.to_vec()));
        check(&resp, &[200]).map(|_| ())
    }

    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.complete_blob(blob));
        check(&resp, &[200]).map(|_| ())
    }

    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        let space = self.space();
        let resp = retrying(|| space.download(blob));
        check(&resp, &[200])?;
        Ok(Box::new(Cursor::new(resp.body)))
    }

    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        let body = json!({
            "commit_id": hex16(commit_id),
            "items": items.iter().map(|i| json!({
                "item_id": hex16(i.item_id.as_bytes()),
                "base_version": i.base_version,
                "header": hex_of(&i.header),
                "blob_id": i.blob_id.map(|b| hex16(b.as_bytes())),
                "deleted": i.deleted,
            })).collect::<Vec<_>>(),
        });
        let space = self.space();
        let resp = retrying(|| space.post("/commit", body.clone()));
        if resp.status == 409 && resp.error_code().as_deref() == Some("version_conflict") {
            let details = resp.details();
            let conflicts = details["conflicts"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .map(|c| VersionConflict {
                            item_id: ItemId::from_bytes(id16(c["item_id"].as_str().unwrap_or(""))),
                            base_version: c["base_version"].as_u64().unwrap_or(0),
                            current_version: c["current_version"].as_u64().unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default();
            return Ok(CommitReply::Conflict(conflicts));
        }
        let body = check(&resp, &[200])?;
        Ok(CommitReply::Accepted(CommitAccepted {
            seq: body["seq"].as_u64().unwrap_or(0),
            replayed: body["replayed"].as_bool().unwrap_or(false),
            versions: body["items"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .map(|c| {
                            (
                                ItemId::from_bytes(id16(c["item_id"].as_str().unwrap_or(""))),
                                c["version"].as_u64().unwrap_or(0),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }))
    }
}

fn hex_of(bytes: &[u8]) -> String {
    hex::encode(bytes)
}
