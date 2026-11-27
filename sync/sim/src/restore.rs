//! What the application does when a person restores a version or a deleted file from the server
//! (appendix И, И6, И15), written with the same pure functions of the core and the same remote
//! port, on top of one simulated device. A restore is an ordinary local write (И.0): after it the
//! next pass of the engine is the whole story (И7, И16).

use std::io::Read;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::history::{
    deleted_files, open_version_body, server_history, DeletedFile, HistoryVersion, ItemHistory,
    OpenedVersion,
};
use amby_sync_core::engine::{Remote, RemoteError, StateStore};

use crate::net::HttpRemote;
use crate::vfs::hash_of;
use crate::world::World;

impl World {
    fn remote_of(&self, d: usize) -> HttpRemote {
        HttpRemote::new(self.dev(d).space.clone())
    }

    /// The versions the history panel of device `d` would list for the note `path` (И1–И3): the
    /// item is the one the server has at that path now.
    pub fn history_panel(&self, d: usize, path: &str) -> Vec<HistoryVersion> {
        let (item, _) = self.item_at(path);
        let entries = self
            .remote_of(d)
            .versions(&item)
            .expect("the server lists the versions");
        let current = self.dev(d).fs.content(path).map(|bytes| hash_of(&bytes));
        server_history(
            &self.space_id,
            std::slice::from_ref(&self.vk),
            &entries,
            current,
            &[],
        )
        .versions
    }

    fn download_and_open(&self, d: usize, version: &HistoryVersion) -> Vec<u8> {
        let mut remote = self.remote_of(d);
        let mut sealed = Vec::new();
        remote
            .blob_download(&version.body_id)
            .expect("the body downloads")
            .read_to_end(&mut sealed)
            .expect("the body reads");
        match open_version_body(std::slice::from_ref(&self.vk), version, &sealed) {
            OpenedVersion::Content(bytes) => bytes,
            other => panic!("the version does not open: {other:?}"),
        }
    }

    /// Restore of version `version` of the note `path` on device `d` (И6): its bytes are written
    /// over the current file. The pass is not run: the next pass of the engine sends it (И7).
    pub fn restore_server_version(&self, d: usize, path: &str, version: u64) {
        let shown = self
            .history_panel(d, path)
            .into_iter()
            .find(|v| v.version == version)
            .unwrap_or_else(|| panic!("version {version} is not in the history panel"));
        let bytes = self.download_and_open(d, &shown);
        self.dev(d).fs.user_write(path, &bytes);
    }

    /// The rows of the "on the server" part of the archive of device `d` (И9–И11).
    pub fn deleted_on_server(&self, d: usize) -> Vec<DeletedFile> {
        let state = self.dev(d).state.clone().load().expect("state loads");
        let tombstones: Vec<_> = state
            .items
            .values()
            .filter(|record| record.deleted)
            .cloned()
            .collect();
        let mut remote = self.remote_of(d);
        let histories: Vec<ItemHistory> = tombstones
            .iter()
            .map(|record| ItemHistory {
                item_id: record.item_id,
                entries: match remote.versions(&record.item_id) {
                    Ok(entries) => Some(entries),
                    Err(RemoteError::Rejected { status: 404, .. }) => None,
                    Err(error) => panic!("versions failed: {error}"),
                },
            })
            .collect();
        let on_disk: Vec<(String, [u8; 32])> = self
            .dev(d)
            .fs
            .files()
            .into_iter()
            .map(|(path, bytes)| (path, hash_of(&bytes)))
            .collect();
        deleted_files(
            &self.space_id,
            std::slice::from_ref(&self.vk),
            &tombstones,
            &histories,
            &on_disk,
        )
    }

    /// Restore of the deleted file `item` on device `d` (И15): written to its own path, which
    /// must be free. The pass is not run (И16).
    pub fn restore_deleted_file(&self, d: usize, item: &ItemId) {
        let row = self
            .deleted_on_server(d)
            .into_iter()
            .find(|row| row.item_id == *item)
            .expect("the file is in the archive of the server");
        assert!(
            !self.dev(d).fs.exists(&row.path),
            "the path of a restored file must be free"
        );
        let version = HistoryVersion {
            item_id: row.item_id,
            version: row.version,
            path: row.path.clone(),
            size: row.size,
            content_hash: row.content_hash,
            body_id: row.body_id,
            device_id: row.deleted_by,
            committed_ms: row.deleted_ms,
        };
        let bytes = self.download_and_open(d, &version);
        self.dev(d).fs.user_write(&row.path, &bytes);
    }
}
