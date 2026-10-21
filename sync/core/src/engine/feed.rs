//! Reading the change feed (Д14): pages from the cursor, every header opened, forged and
//! contradicting records told apart from records of a newer format.

use std::collections::BTreeMap;

use crate::crypto::error::CryptoError;
use crate::crypto::header::{open_header, Header};

use super::consistency::{check_entry, check_header, check_kind_unchanged};
use super::flow::{Flow, Res};
use super::model::{ItemError, ItemErrorKind, ReadOnlyItem, StopReason, SyncState};
use super::plan::Srv;
use super::ports::ChangeEntry;
use super::sync::Engine;

/// The feed after reading and checking.
pub(super) struct Feed {
    /// Consistent records, ascending by `seq`.
    pub items: Vec<Srv>,
    /// Records that did not pass: reported, skipped, the cursor stays before them (Д5).
    pub bad: Vec<(ItemError, u64)>,
    /// Records of a newer format (Д66).
    pub read_only: Vec<(ReadOnlyItem, [u8; 16])>,
    /// The largest `seq` the server named.
    pub head: u64,
    /// The cursor for the next request.
    pub next: u64,
    /// The feed was read from the start: a gap, or the user's `resync` (Д8, Д58).
    pub full: bool,
}

/// Errors worth asking for the page once more (Д14).
fn retriable(error: &CryptoError) -> bool {
    matches!(
        error,
        CryptoError::Authentication
            | CryptoError::VersionMismatch
            | CryptoError::EpochMismatch
            | CryptoError::Malformed(_)
            | CryptoError::BadPadding
            | CryptoError::InvalidPath
            | CryptoError::PathNotNfc
    )
}

impl Engine {
    /// Reads the feed from `cursor`. `full` when it is already known to be a full reconcile.
    pub(super) fn read_feed(
        &mut self,
        state: &SyncState,
        mut cursor: u64,
        mut full: bool,
    ) -> Res<Feed> {
        let mut entries: BTreeMap<[u8; 16], (ChangeEntry, Result<Header, CryptoError>)> =
            BTreeMap::new();
        let mut head = 0u64;
        let mut first = true;
        let next;
        loop {
            let mut page = self.ports.remote.changes(cursor, None)?;
            if let Some(known) = state.instance_id {
                if page.instance_id != known {
                    return Err(Flow::Stop(StopReason::ServerReset {
                        old: known,
                        new: page.instance_id,
                    }));
                }
            }
            if first {
                first = false;
                if page.gap && !full {
                    // Д58: the server forgot part of the history; start again from nothing.
                    full = true;
                    cursor = 0;
                    first = true;
                    entries.clear();
                    head = 0;
                    continue;
                }
                if !full && page.seq < state.cursor {
                    return Err(Flow::Stop(StopReason::ServerBehind {
                        head: page.seq,
                        cursor: state.cursor,
                    }));
                }
            }
            let mut opened = self.open_page(&page.changes);
            if opened
                .iter()
                .any(|(_, result)| matches!(result, Err(error) if retriable(error)))
            {
                // Once more, in this pass (Д14): a bad read is not a forgery yet.
                page = self.ports.remote.changes(cursor, None)?;
                opened = self.open_page(&page.changes);
            }
            head = head.max(page.seq);
            for (entry, result) in opened {
                entries.insert(*entry.item_id.as_bytes(), (entry, result));
            }
            if !page.more {
                next = page.next;
                break;
            }
            cursor = page.next;
        }

        let mut items = Vec::new();
        let mut bad = Vec::new();
        let mut read_only = Vec::new();
        for (key, (entry, result)) in entries {
            let known = state.items.get(&key);
            match result {
                Ok(header) => {
                    let consistent = check_header(&header).is_ok()
                        && known.is_none_or(|b| check_kind_unchanged(b.kind, &header).is_ok())
                        && check_entry(&entry, &header).is_ok();
                    if consistent {
                        items.push(Srv::from_feed(&entry, &header));
                    } else {
                        bad.push((
                            ItemError {
                                item_id: entry.item_id,
                                kind: ItemErrorKind::Inconsistent,
                            },
                            entry.seq,
                        ));
                    }
                }
                Err(CryptoError::UnsupportedFormat(_) | CryptoError::UnsupportedVersion(_)) => {
                    read_only.push((
                        ReadOnlyItem {
                            item_id: entry.item_id,
                            path: known.map(|b| b.path.clone()),
                        },
                        key,
                    ));
                }
                Err(error) => bad.push((
                    ItemError {
                        item_id: entry.item_id,
                        kind: ItemErrorKind::Invalid(error),
                    },
                    entry.seq,
                )),
            }
        }
        items.sort_by_key(|srv| srv.seq);
        Ok(Feed {
            items,
            bad,
            read_only,
            head,
            next,
            full,
        })
    }

    fn open_page(
        &self,
        changes: &[ChangeEntry],
    ) -> Vec<(ChangeEntry, Result<Header, CryptoError>)> {
        changes
            .iter()
            .map(|entry| {
                let result = open_header(
                    &self.config.vk,
                    &self.config.space_id,
                    &entry.item_id,
                    entry.version,
                    &entry.header,
                );
                (entry.clone(), result)
            })
            .collect()
    }
}
