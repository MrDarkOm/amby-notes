//! The decisions of a pass (Д16, table Р7 in appendix В.3): for every server version that is new
//! to this device, one function of three inputs (base, local, server) gives the actions of Д17.
//! Nothing here touches the disk, the server or the state.

use std::collections::{BTreeMap, BTreeSet};

use crate::crypto::header::ItemKind;
use crate::crypto::keys::ItemId;

use super::classify::Lc;
use super::model::{
    ConflictKind, ItemError, ItemErrorKind, ItemRecord, PlannedChange, PlannedKind, StateOp,
    SyncState, UnsyncedReason, UnsyncedRecord,
};
use super::names::{check_path_for_system, collision_key, conflict_copy_path, conflict_id};
use super::plan::{Act, CopyPlan, Existing, KeepAct, MoveAct, Plan, PutAct, Srv, Undelete};
use super::ports::{FsError, NameRules};
use super::rules::is_excluded_path;
use super::scan::Scan;
use super::util::{is_unmaterialised, UNMATERIALISED};

/// What the decisions look at.
pub(super) struct Inputs<'a> {
    pub state: &'a SyncState,
    pub scan: &'a Scan,
    pub classes: &'a BTreeMap<[u8; 16], Lc>,
    pub rules: NameRules,
    pub max_file_bytes: u64,
    /// A full reconcile: nothing is deleted because of the server (Д8, Д58).
    pub full: bool,
    /// The user said "upload this vault again" (Д56, Д57).
    pub resync: bool,
}

struct Decider<'a> {
    inp: &'a Inputs<'a>,
    plan: Plan,
    /// Live file bases by path (not the unmaterialised ones).
    by_path: BTreeMap<&'a str, &'a ItemRecord>,
    /// Collision key → the path that holds it (Д63).
    claimed: BTreeMap<String, String>,
    /// Paths of conflict copies already planned in this pass.
    copy_paths: BTreeSet<String>,
    /// Live paths on the server with the hashes found there (Д46).
    server_live: BTreeMap<String, Vec<Option<[u8; 32]>>>,
    /// Items with a new server version that is not just our own deletion going on top.
    touched: BTreeSet<[u8; 16]>,
}

/// Decides every server version in `items` (ascending by `seq`), and retries the bases that were
/// never materialised.
pub(super) fn decide(inp: &Inputs<'_>, items: &[Srv]) -> Plan {
    let by_path = inp
        .state
        .items
        .values()
        .filter(|r| !r.deleted && r.kind == ItemKind::File && !is_unmaterialised(r))
        .map(|r| (r.path.as_str(), r))
        .collect();
    let mut claimed = BTreeMap::new();
    for path in inp.scan.files.keys().chain(inp.scan.dirs.keys()) {
        claimed.insert(collision_key(path, &inp.rules), path.clone());
    }
    let mut server_live: BTreeMap<String, Vec<Option<[u8; 32]>>> = BTreeMap::new();
    for record in inp.state.items.values().filter(|r| !r.deleted) {
        server_live
            .entry(record.path.clone())
            .or_default()
            .push(record.content_hash);
    }
    for srv in items.iter().filter(|s| !s.deleted) {
        server_live
            .entry(srv.path.clone())
            .or_default()
            .push(srv.hash);
    }
    let mut decider = Decider {
        inp,
        plan: Plan::default(),
        by_path,
        claimed,
        copy_paths: BTreeSet::new(),
        server_live,
        touched: BTreeSet::new(),
    };
    let in_feed: BTreeSet<[u8; 16]> = items.iter().map(|s| *s.item.as_bytes()).collect();
    for srv in items {
        decider.item(srv);
    }
    // Bases that never reached this disk are tried again (a name that is free now, a file that
    // was removed, a limit that was raised).
    for record in inp.state.items.values() {
        if is_unmaterialised(record)
            && !record.deleted
            && !in_feed.contains(record.item_id.as_bytes())
        {
            decider.item(&Srv::from_record(record));
        }
    }
    // Our own deletions that nothing on the server contradicts (Д24, Д54).
    for (key, lc) in inp.classes {
        let Some(record) = inp.state.items.get(key) else {
            continue;
        };
        if *lc == Lc::Deleted
            && record.kind == ItemKind::File
            && !record.newer_format
            && !decider.touched.contains(key)
        {
            decider.plan.outgoing.push(PlannedChange {
                path: record.path.clone(),
                kind: PlannedKind::SendDelete,
            });
        }
    }
    decider.plan
}

impl<'a> Decider<'a> {
    fn item(&mut self, srv: &Srv) {
        let key = *srv.item.as_bytes();
        match self.inp.state.items.get(&key) {
            None => self.new_item(srv),
            Some(base) if base.deleted || is_unmaterialised(base) => self.new_item(srv),
            Some(base) => {
                if srv.version > base.version {
                    self.known(base, srv);
                }
            }
        }
    }

    // ----- small helpers -----

    fn ops(&mut self, ops: Vec<StateOp>) {
        self.plan.acts.push(Act::Ops(ops));
    }

    /// Writes `record` as the base, unless it already is.
    fn set_base(&mut self, record: ItemRecord) {
        if self.inp.state.items.get(record.item_id.as_bytes()) != Some(&record) {
            self.ops(vec![StateOp::PutItem(record)]);
        }
    }

    fn error(&mut self, srv: &Srv, kind: ItemErrorKind) {
        self.plan.errors.push(ItemError {
            item_id: srv.item,
            kind,
        });
        self.plan.hold_before(srv.seq);
    }

    fn claim(&mut self, path: &str) {
        self.claimed
            .entry(collision_key(path, &self.inp.rules))
            .or_insert_with(|| path.to_string());
    }

    /// Another path with the same collision key (Д63), not counting `own`.
    fn collision(&self, path: &str, own: Option<&str>) -> Option<String> {
        let key = collision_key(path, &self.inp.rules);
        self.claimed
            .get(&key)
            .filter(|other| other.as_str() != path && Some(other.as_str()) != own)
            .cloned()
    }

    /// Why this server path cannot be written here, if it cannot (Д11, Д62, Д63, Д71).
    fn name_block(&self, srv: &Srv, own: Option<&str>) -> Option<UnsyncedReason> {
        if is_excluded_path(&srv.path) {
            return Some(UnsyncedReason::ExcludedPath);
        }
        if srv.kind == ItemKind::File && srv.size > self.inp.max_file_bytes {
            return Some(UnsyncedReason::TooBigForMemory);
        }
        if let Err(problem) = check_path_for_system(&srv.path, &self.inp.rules) {
            return Some(UnsyncedReason::InvalidName(problem));
        }
        self.collision(&srv.path, own)
            .map(|with| UnsyncedReason::CaseCollision { with })
    }

    /// A new item that cannot be materialised here: remembered and listed (Д64).
    fn park(&mut self, srv: &Srv, reason: UnsyncedReason) {
        self.plan.unsynced.push(UnsyncedRecord {
            path: srv.path.clone(),
            reason,
        });
        self.set_base(srv.record(UNMATERIALISED));
    }

    /// A known item that cannot take its new server version here: the base stays, the cursor
    /// stays before the entry, the list names it (the entry comes again next pass).
    fn refuse(&mut self, srv: &Srv, reason: UnsyncedReason) {
        self.plan.unsynced.push(UnsyncedRecord {
            path: srv.path.clone(),
            reason,
        });
        self.plan.hold_before(srv.seq);
    }

    /// The name and the place of a conflict copy (Д46). `None` when no allowed name is free.
    fn copy_for(
        &mut self,
        item: &ItemId,
        original: &str,
        content_hash: [u8; 32],
        version: u64,
        kind: ConflictKind,
    ) -> Option<CopyPlan> {
        for attempt in 0..64u32 {
            let id = conflict_id(item, &content_hash, version, attempt);
            let path = conflict_copy_path(original, &id);
            if check_path_for_system(&path, &self.inp.rules).is_err() {
                return None;
            }
            let plan = |exists, from_server| CopyPlan {
                id: id.clone(),
                path: path.clone(),
                original: original.to_string(),
                kind,
                exists,
                from_server,
            };
            if let Some(file) = self.inp.scan.files.get(&path) {
                if file.hash == content_hash {
                    return Some(plan(true, false));
                }
                continue;
            }
            if self.inp.scan.dirs.contains_key(&path)
                || self.inp.scan.blocked.contains(&path)
                || self.copy_paths.contains(&path)
            {
                continue;
            }
            if let Some(hashes) = self.server_live.get(&path) {
                if hashes.contains(&Some(content_hash)) {
                    return Some(plan(false, true));
                }
                continue;
            }
            if self.collision(&path, None).is_some() {
                continue;
            }
            self.copy_paths.insert(path.clone());
            self.claim(&path);
            return Some(plan(false, false));
        }
        None
    }

    fn no_copy_name(&mut self, srv: &Srv) {
        self.error(
            srv,
            ItemErrorKind::Disk(FsError::Io(
                "no allowed name for the conflict copy".to_string(),
            )),
        );
    }

    fn overwrite(&mut self, path: &str) {
        self.plan.incoming.push(PlannedChange {
            path: path.to_string(),
            kind: PlannedKind::Overwrite,
        });
    }

    // ----- no base (Д41–Д45) -----

    fn new_item(&mut self, srv: &Srv) {
        if srv.deleted {
            // Д44: nothing to create, a local file at that path is unrelated.
            self.set_base(srv.record(0));
            return;
        }
        if srv.kind == ItemKind::Folder {
            return self.new_folder(srv);
        }
        if let Some(reason) = self.name_block(srv, None) {
            return self.park(srv, reason);
        }
        let scan = self.inp.scan;
        if scan.dirs.contains_key(&srv.path) {
            return self.park(srv, UnsyncedReason::PathBusy);
        }
        let target = srv.path.clone();
        match scan.files.get(&target) {
            None => {
                self.claim(&target);
                let rec = srv.record(0);
                self.plan.acts.push(Act::Put(Box::new(PutAct {
                    seq: srv.seq,
                    srv: srv.clone(),
                    target,
                    existing: None,
                    copy: None,
                    rec,
                })));
            }
            Some(_) if self.by_path.contains_key(target.as_str()) => {
                // Another item holds the path now; if it moves away in this pass the write goes
                // through, otherwise it is "busy" (Д49).
                let rec = srv.record(0);
                self.plan.acts.push(Act::Put(Box::new(PutAct {
                    seq: srv.seq,
                    srv: srv.clone(),
                    target,
                    existing: None,
                    copy: None,
                    rec,
                })));
            }
            Some(file) => {
                let local_hash = file.hash;
                if Some(local_hash) == srv.hash {
                    // Д15, Д42: the same content at the same path.
                    let mut rec = srv.record(file.mtime_ns);
                    rec.size = file.size;
                    return self.set_base(rec);
                }
                let existing = Existing {
                    disk: file.disk.clone(),
                    hash: local_hash,
                };
                if self.inp.resync {
                    let Some(server_hash) = srv.hash else {
                        return;
                    };
                    let Some(copy) = self.copy_for(
                        &srv.item,
                        &target,
                        server_hash,
                        srv.version,
                        ConflictKind::BothCreated,
                    ) else {
                        return self.no_copy_name(srv);
                    };
                    // The base is the server's version; the local file differs from it and goes
                    // up as the next version (Д22).
                    let rec = srv.record(0);
                    self.plan.acts.push(Act::Keep(Box::new(KeepAct {
                        seq: srv.seq,
                        srv: srv.clone(),
                        copy,
                        rec,
                    })));
                    return;
                }
                // Д43, Р7 row 5: the one that came later keeps a copy.
                let Some(copy) = self.copy_for(
                    &srv.item,
                    &target,
                    local_hash,
                    srv.version,
                    ConflictKind::BothCreated,
                ) else {
                    return self.no_copy_name(srv);
                };
                self.overwrite(&target);
                let rec = srv.record(0);
                self.plan.acts.push(Act::Put(Box::new(PutAct {
                    seq: srv.seq,
                    srv: srv.clone(),
                    target,
                    existing: Some(existing),
                    copy: Some(copy),
                    rec,
                })));
            }
        }
    }

    fn new_folder(&mut self, srv: &Srv) {
        if let Some(reason) = self.name_block(srv, None) {
            return self.park(srv, reason);
        }
        let scan = self.inp.scan;
        if scan.dirs.contains_key(&srv.path) {
            return self.set_base(srv.record(0));
        }
        if scan.files.contains_key(&srv.path) || scan.blocked.contains(&srv.path) {
            return self.park(srv, UnsyncedReason::PathBusy);
        }
        self.claim(&srv.path);
        self.plan.acts.push(Act::Dir {
            path: srv.path.clone(),
            rec: srv.record(0),
        });
    }

    // ----- a base exists (table Р7) -----

    fn known(&mut self, base: &ItemRecord, srv: &Srv) {
        let key = *srv.item.as_bytes();
        self.touched.insert(key);
        if self.inp.full && srv.deleted {
            // Д58: a deletion seen after a gap is not trusted; the file stays and is new later.
            self.plan.forget.push(srv.item);
            return;
        }
        let lc = self.inp.classes.get(&key).cloned().unwrap_or(Lc::Same);
        if base.kind == ItemKind::Folder {
            return self.known_folder(base, srv, lc);
        }
        let renamed = !srv.deleted && srv.path != base.path;
        let changed = !srv.deleted && srv.hash != base.content_hash;
        if (renamed || changed) && !srv.deleted {
            if let Some(reason) = self.name_block(srv, Some(&base.path)) {
                return self.refuse(srv, reason);
            }
        }
        let scan = self.inp.scan;
        match lc {
            Lc::Blocked => self.error(
                srv,
                ItemErrorKind::Disk(FsError::Io(
                    "the local file is too big to compare".to_string(),
                )),
            ),
            Lc::Same => {
                let Some(file) = scan.files.get(&base.path) else {
                    return;
                };
                if srv.deleted {
                    // Д28: unchanged here, deleted elsewhere: to the trash.
                    self.plan.incoming.push(PlannedChange {
                        path: base.path.clone(),
                        kind: PlannedKind::Trash,
                    });
                    self.plan.acts.push(Act::Trash {
                        seq: srv.seq,
                        disk: file.disk.clone(),
                        expect: file.hash,
                        rec: srv.record(0),
                    });
                    return;
                }
                let existing = Existing {
                    disk: file.disk.clone(),
                    hash: file.hash,
                };
                match (renamed, changed) {
                    (false, false) => self.set_base(srv.record(base.mtime_ns)),
                    (false, true) => {
                        self.overwrite(&base.path);
                        self.plan.acts.push(Act::Put(Box::new(PutAct {
                            seq: srv.seq,
                            srv: srv.clone(),
                            target: base.path.clone(),
                            existing: Some(existing),
                            copy: None,
                            rec: srv.record(0),
                        })));
                    }
                    (true, false) => {
                        let rec = srv.record(base.mtime_ns);
                        self.rename(srv, base, existing, rec, None);
                    }
                    (true, true) => {
                        self.overwrite(&srv.path);
                        let put = self.put_after_move(srv, file.hash, None);
                        let rec = srv.record(0);
                        self.rename(srv, base, existing, rec, Some(put));
                    }
                }
            }
            Lc::Edited => {
                let Some(file) = scan.files.get(&base.path) else {
                    return;
                };
                let existing = Existing {
                    disk: file.disk.clone(),
                    hash: file.hash,
                };
                if srv.deleted {
                    // Д32, Р7 row 4: an edit beats a deletion; the file goes up again.
                    self.plan.undelete.insert(
                        base.path.clone(),
                        Undelete {
                            item: srv.item,
                            version: srv.version,
                            extra: base.extra.clone(),
                        },
                    );
                    return self.set_base(srv.record(0));
                }
                if !changed {
                    // Д30, Р7 row 2: the name from the server, the content ours.
                    let rec = srv.record(base.mtime_ns);
                    if renamed {
                        return self.rename(srv, base, existing, rec, None);
                    }
                    return self.set_base(rec);
                }
                if Some(file.hash) == srv.hash {
                    // Д29, Д15: the same change on both sides.
                    let mut rec = srv.record(file.mtime_ns);
                    rec.size = file.size;
                    if renamed {
                        return self.rename(srv, base, existing, rec, None);
                    }
                    return self.set_base(rec);
                }
                // Д29, Д31, Р7 row 1: both changed the content.
                let Some(copy) = self.copy_for(
                    &srv.item,
                    &srv.path,
                    file.hash,
                    srv.version,
                    ConflictKind::BothEdited,
                ) else {
                    return self.no_copy_name(srv);
                };
                self.overwrite(&srv.path);
                if renamed {
                    let put = self.put_after_move(srv, file.hash, Some(copy));
                    let rec = srv.record(0);
                    self.rename(srv, base, existing, rec, Some(put));
                } else {
                    self.plan.acts.push(Act::Put(Box::new(PutAct {
                        seq: srv.seq,
                        srv: srv.clone(),
                        target: base.path.clone(),
                        existing: Some(existing),
                        copy: Some(copy),
                        rec: srv.record(0),
                    })));
                }
            }
            Lc::Moved { to, edited } => {
                let Some(file) = scan.files.get(&to) else {
                    return;
                };
                let existing = Existing {
                    disk: file.disk.clone(),
                    hash: file.hash,
                };
                if srv.deleted {
                    // Д36: a rename is a change, it beats the deletion; a fresh body goes up.
                    self.plan.undelete.insert(
                        to.clone(),
                        Undelete {
                            item: srv.item,
                            version: srv.version,
                            extra: base.extra.clone(),
                        },
                    );
                    return self.set_base(srv.record(0));
                }
                let same_content = Some(file.hash) == srv.hash;
                match (renamed, changed) {
                    (false, false) => self.set_base(srv.record(base.mtime_ns)),
                    (false, true) if same_content => {
                        let mut rec = srv.record(file.mtime_ns);
                        rec.size = file.size;
                        self.set_base(rec);
                    }
                    (false, true) => {
                        // Д33, Р7 row 2: our name, the server's content.
                        let copy = if edited {
                            let Some(copy) = self.copy_for(
                                &srv.item,
                                &to,
                                file.hash,
                                srv.version,
                                ConflictKind::BothEdited,
                            ) else {
                                return self.no_copy_name(srv);
                            };
                            Some(copy)
                        } else {
                            None
                        };
                        self.overwrite(&to);
                        self.plan.acts.push(Act::Put(Box::new(PutAct {
                            seq: srv.seq,
                            srv: srv.clone(),
                            target: to.clone(),
                            existing: Some(existing),
                            copy,
                            rec: srv.record(0),
                        })));
                    }
                    (true, false) => {
                        // Д34, Р7 row 3: two names for one file, the server's stays.
                        let rec = srv.record(base.mtime_ns);
                        if to == srv.path {
                            self.set_base(rec);
                        } else {
                            self.rename_from(srv, &to, existing, rec, None);
                        }
                    }
                    (true, true) => {
                        // Д35: the server's name and the server's content.
                        if same_content {
                            let mut rec = srv.record(file.mtime_ns);
                            rec.size = file.size;
                            if to == srv.path {
                                self.set_base(rec);
                            } else {
                                self.rename_from(srv, &to, existing, rec, None);
                            }
                        } else {
                            let copy = if edited {
                                let Some(copy) = self.copy_for(
                                    &srv.item,
                                    &srv.path,
                                    file.hash,
                                    srv.version,
                                    ConflictKind::BothEdited,
                                ) else {
                                    return self.no_copy_name(srv);
                                };
                                Some(copy)
                            } else {
                                None
                            };
                            self.overwrite(&srv.path);
                            let put = self.put_after_move(srv, file.hash, copy);
                            let rec = srv.record(0);
                            if to == srv.path {
                                self.plan.acts.push(Act::Put(Box::new(PutAct {
                                    existing: Some(Existing {
                                        disk: file.disk.clone(),
                                        hash: file.hash,
                                    }),
                                    ..put
                                })));
                            } else {
                                self.rename_from(srv, &to, existing, rec, Some(put));
                            }
                        }
                    }
                }
            }
            Lc::Deleted => {
                if srv.deleted {
                    // Д40: both deleted.
                    return self.set_base(srv.record(0));
                }
                if !renamed && !changed {
                    // Nothing new on the server; our deletion goes up on top of this version.
                    self.touched.remove(&key);
                    return self.set_base(srv.record(base.mtime_ns));
                }
                // Д37–Д39: a change beats our deletion; the file comes back.
                self.new_item(srv);
            }
        }
    }

    /// A rename of the file at the base path to the server's path (Д26).
    fn rename(
        &mut self,
        srv: &Srv,
        base: &ItemRecord,
        existing: Existing,
        rec: ItemRecord,
        then: Option<PutAct>,
    ) {
        self.rename_from(srv, &base.path, existing, rec, then);
    }

    /// A rename of the file now at `from` (NFC) to the server's path.
    fn rename_from(
        &mut self,
        srv: &Srv,
        from: &str,
        existing: Existing,
        rec: ItemRecord,
        then: Option<PutAct>,
    ) {
        let to = srv.path.clone();
        let occupant = self.occupant(&to, srv, from);
        let Some(occupant) = occupant else {
            return;
        };
        self.claim(&to);
        self.plan.acts.push(Act::Move(Box::new(MoveAct {
            seq: srv.seq,
            from_disk: existing.disk.clone(),
            from: from.to_string(),
            to,
            expect: existing.hash,
            rec,
            then,
            occupant,
        })));
    }

    /// The content replacement that follows a rename: the file is then at the server's path.
    fn put_after_move(&mut self, srv: &Srv, hash: [u8; 32], copy: Option<CopyPlan>) -> PutAct {
        PutAct {
            seq: srv.seq,
            srv: srv.clone(),
            target: srv.path.clone(),
            existing: Some(Existing {
                disk: srv.path.clone(),
                hash,
            }),
            copy,
            rec: srv.record(0),
        }
    }

    /// A file without a base at the target of a rename becomes a conflict copy (Д49, Д51).
    /// `Some(None)`: the target is free or held by another base (the apply step decides);
    /// `None`: no allowed copy name, the item has been reported.
    #[allow(clippy::type_complexity)]
    fn occupant(
        &mut self,
        to: &str,
        srv: &Srv,
        from: &str,
    ) -> Option<Option<(Existing, CopyPlan)>> {
        if to == from {
            return Some(None);
        }
        let scan = self.inp.scan;
        let Some(file) = scan.files.get(to) else {
            return Some(None);
        };
        if self.by_path.contains_key(to) {
            return Some(None);
        }
        let hash = file.hash;
        let existing = Existing {
            disk: file.disk.clone(),
            hash,
        };
        if Some(hash) == srv.hash {
            // The same content is there already; the rename onto it cannot happen, but the file
            // we move would be a duplicate. Keep both, it is the safe answer.
        }
        let Some(copy) = self.copy_for(&srv.item, to, hash, srv.version, ConflictKind::BothCreated)
        else {
            self.no_copy_name(srv);
            return None;
        };
        Some(Some((existing, copy)))
    }

    // ----- folders -----

    fn known_folder(&mut self, base: &ItemRecord, srv: &Srv, lc: Lc) {
        let renamed = !srv.deleted && srv.path != base.path;
        if srv.deleted {
            // The old folder goes when nothing is left in it (Д17, step 5).
            self.plan.cleanup.insert(base.path.clone());
            return self.set_base(srv.record(0));
        }
        if renamed {
            if let Some(reason) = self.name_block(srv, Some(&base.path)) {
                return self.refuse(srv, reason);
            }
        }
        match lc {
            Lc::Deleted if renamed => {
                // Gone here, moved there: make it where the server has it.
                self.claim(&srv.path);
                self.plan.acts.push(Act::Dir {
                    path: srv.path.clone(),
                    rec: srv.record(0),
                });
            }
            Lc::Deleted => {
                // Only a version bump; our deletion goes up on top.
                self.touched.remove(srv.item.as_bytes());
                self.set_base(srv.record(0));
            }
            Lc::Same if renamed => {
                self.plan.cleanup.insert(base.path.clone());
                self.claim(&srv.path);
                self.plan.acts.push(Act::Dir {
                    path: srv.path.clone(),
                    rec: srv.record(0),
                });
            }
            _ => self.set_base(srv.record(0)),
        }
    }
}
