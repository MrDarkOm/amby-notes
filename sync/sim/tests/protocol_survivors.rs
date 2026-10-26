//! Directed tests for remaining engine survivors in push and feed reporting.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use std::io::Read;

use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::engine::{
    AccountInfo, BlobState, ChangesPage, CommitItem, CommitReply, Engine, EngineConfig,
    EngineError, LimitSource, Ports, Remote, RemoteError, ServerInfo, SyncEngine, UnsyncedReason,
};
use amby_sync_sim::world::{World, WorldOptions};

fn ps_a_new_local_file_is_not_consumed_by_an_unplaced_item_of_the_same_size() {
    let w = World::new(
        Engine::boxed,
        WorldOptions::new(2).with_fs(vec![Vfs::linux(), Vfs::windows()]),
    );
    w.save(0, "Notes/CON.txt", "old");
    w.pass(0);
    w.pass(1);

    assert!(!w.dev(1).fs.exists("Notes/CON.txt"));
    assert_eq!(w.server_files()["Notes/CON.txt"], b"old".to_vec());
    w.dev(1).fs.user_write("Notes/new.md", b"new");
    let report = w.pass(1);

    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(
        w.dev(1).fs.content("Notes/new.md").as_deref(),
        Some(b"new".as_slice())
    );
    assert_eq!(w.server_files()["Notes/new.md"], b"new".to_vec());
    assert_ne!(w.item_at("Notes/new.md").0, w.item_at("Notes/CON.txt").0);
}

#[test]
fn push_does_not_skip_a_same_size_different_content_file() {
    ps_a_new_local_file_is_not_consumed_by_an_unplaced_item_of_the_same_size();
}

fn ps_feed_reports_multiple_corrupt_items(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(0, "a.md", "aaa");
    w.save(0, "b.md", "bbb");
    w.pass(0);
    let (a, _) = w.item_at("a.md");
    let (b, _) = w.item_at("b.md");
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        for change in &mut page.changes {
            if change.item_id == a || change.item_id == b {
                let last = change.header.len() - 1;
                change.header[last] ^= 1;
            }
        }
        page
    }));

    let report = w.pass(1);
    assert_eq!(report.errors.len(), 2, "both bad item IDs are reported");
    assert!(report.errors.iter().any(|error| error.item_id == a));
    assert!(report.errors.iter().any(|error| error.item_id == b));
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RejectAt {
    BlobStart,
    Commit,
    CommitTooLargeWithEqualAccountLimit,
}

struct RejectingRemote {
    inner: Box<dyn Remote>,
    at: RejectAt,
    fired: bool,
    info_max_blob_bytes: Option<u64>,
}

impl RejectingRemote {
    fn reject_once(&mut self, at: RejectAt) -> bool {
        if self.at == at && !self.fired {
            self.fired = true;
            true
        } else {
            false
        }
    }
}

impl Remote for RejectingRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        let info = self.inner.info()?;
        self.info_max_blob_bytes = Some(info.max_blob_bytes);
        Ok(info)
    }

    fn changes(&mut self, since: u64, limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        self.inner.changes(since, limit)
    }

    fn account(&mut self) -> Result<AccountInfo, RemoteError> {
        let mut account = self.inner.account()?;
        if self.at == RejectAt::CommitTooLargeWithEqualAccountLimit {
            account.max_file_bytes = self.info_max_blob_bytes;
        }
        Ok(account)
    }

    fn blob_start(
        &mut self,
        blob: &BodyId,
        size: u64,
        replaces: Option<&ItemId>,
    ) -> Result<BlobState, RemoteError> {
        if self.reject_once(RejectAt::BlobStart) {
            return Err(self.rejection());
        }
        self.inner.blob_start(blob, size, replaces)
    }

    fn blob_delete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        self.inner.blob_delete(blob)
    }

    fn blob_put_part(&mut self, blob: &BodyId, part: u64, bytes: &[u8]) -> Result<(), RemoteError> {
        self.inner.blob_put_part(blob, part, bytes)
    }

    fn blob_complete(&mut self, blob: &BodyId) -> Result<(), RemoteError> {
        self.inner.blob_complete(blob)
    }

    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        self.inner.blob_download(blob)
    }

    fn commit(
        &mut self,
        commit_id: &[u8; 16],
        items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        if self.reject_once(RejectAt::Commit)
            || self.reject_once(RejectAt::CommitTooLargeWithEqualAccountLimit)
        {
            return Err(self.rejection());
        }
        self.inner.commit(commit_id, items)
    }
}

impl RejectingRemote {
    fn rejection(&self) -> RemoteError {
        if self.at == RejectAt::CommitTooLargeWithEqualAccountLimit {
            RemoteError::Rejected {
                status: 413,
                code: "blob_too_large".into(),
            }
        } else {
            RemoteError::Rejected {
                status: 418,
                code: "unsupported_operation".into(),
            }
        }
    }
}

fn rejecting_engine(at: RejectAt) -> EngineBuilder {
    match at {
        RejectAt::BlobStart => reject_blob_start_once,
        RejectAt::Commit => reject_commit_once,
        RejectAt::CommitTooLargeWithEqualAccountLimit => reject_commit_413_equal_limit_once,
    }
}

fn with_rejecting_remote(
    mut ports: Ports,
    config: EngineConfig,
    at: RejectAt,
) -> Box<dyn SyncEngine> {
    ports.remote = Box::new(RejectingRemote {
        inner: ports.remote,
        at,
        fired: false,
        info_max_blob_bytes: None,
    });
    Engine::boxed(ports, config)
}

fn reject_blob_start_once(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    with_rejecting_remote(ports, config, RejectAt::BlobStart)
}

fn reject_commit_once(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    with_rejecting_remote(ports, config, RejectAt::Commit)
}

fn reject_commit_413_equal_limit_once(ports: Ports, config: EngineConfig) -> Box<dyn SyncEngine> {
    with_rejecting_remote(ports, config, RejectAt::CommitTooLargeWithEqualAccountLimit)
}

#[test]
fn push_does_not_turn_a_non_quota_blob_rejection_into_quota_full() {
    let w = World::new(
        rejecting_engine(RejectAt::BlobStart),
        WorldOptions::new(1).isolated(),
    );
    w.save(0, "a.md", "content");

    let result = w.dev(0).sync();
    assert!(matches!(
        result,
        Err(EngineError::Remote(RemoteError::Rejected { .. }))
    ));
}

#[test]
fn commit_does_not_turn_a_non_quota_rejection_into_quota_full() {
    let w = World::new(
        rejecting_engine(RejectAt::Commit),
        WorldOptions::new(1).isolated(),
    );
    w.save(0, "a.md", "content");

    let result = w.dev(0).sync();
    assert!(matches!(
        result,
        Err(EngineError::Remote(RemoteError::Rejected { .. }))
    ));
    assert!(
        w.dev(0).state.snapshot().commit.is_some(),
        "the pending record stays when the server refuses the commit"
    );
}

#[test]
fn a_pending_commit_with_a_non_quota_rejection_is_kept_unchanged() {
    let w = World::new(
        rejecting_engine(RejectAt::Commit),
        WorldOptions::new(1).isolated(),
    );
    w.save(0, "a.md", "content");

    assert!(matches!(
        w.dev(0).sync(),
        Err(EngineError::Remote(RemoteError::Rejected { .. }))
    ));
    let first = w.dev(0).state.snapshot();
    let first_commit = first.commit.expect("the rejected send remains pending");
    let first_uploads: Vec<_> = first.uploads.keys().copied().collect();

    assert!(matches!(
        w.dev(0).sync(),
        Err(EngineError::Remote(RemoteError::Rejected { .. }))
    ));
    let second = w.dev(0).state.snapshot();
    let second_commit = second
        .commit
        .expect("the repeated rejected send remains pending");
    assert_eq!(second_commit.commit_id, first_commit.commit_id);
    assert_eq!(
        second.uploads.keys().copied().collect::<Vec<_>>(),
        first_uploads
    );
    assert!(!w.server_files().contains_key("a.md"));
}

#[test]
fn a_commit_413_at_the_server_ceiling_keeps_server_as_the_limit_source() {
    let w = World::new(
        rejecting_engine(RejectAt::CommitTooLargeWithEqualAccountLimit),
        WorldOptions::new(1).isolated(),
    );
    w.dev(0).fs.user_mkdir("Empty");
    w.save(0, "a.md", "small body fits the original forecast");

    let report = w
        .dev(0)
        .sync()
        .expect("commit 413 is reported as a file limit");
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(report.limits.max_file_source, LimitSource::Server);
    assert!(
        matches!(
            report.unsynced.as_slice(),
            [entry]
                if entry.path == "a.md"
                    && matches!(entry.reason, UnsyncedReason::TooLarge { source: LimitSource::Server, .. })
        ),
        "folder must not be listed as TooLarge: {report:?}"
    );
    assert!(!w.server_files().contains_key("a.md"));
}

real_only!(ps_feed_reports_multiple_corrupt_items,);
