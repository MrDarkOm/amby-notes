//! The state store of a simulated device: the whole state in memory, every transaction atomic,
//! one lock (С14). A process that dies leaves the state as the last completed transaction.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{StateError, StateLock, StateOp, StateStore, StateTx, SyncState};

struct Inner {
    state: SyncState,
    locked: Rc<Cell<bool>>,
    transactions: u64,
    /// The bases (appendix Г, Г6): files of the device, not rows of the state; they survive
    /// `wipe` only as long as the test lets them (`wipe` takes them too: the folder `.amby/sync/`
    /// goes as a whole).
    bases: BTreeMap<([u8; 16], [u8; 32]), Vec<u8>>,
}

/// Cloning shares the store.
#[derive(Clone)]
pub struct MemState(Rc<RefCell<Inner>>);

struct LockToken(Rc<Cell<bool>>);

impl Drop for LockToken {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

impl Default for MemState {
    fn default() -> Self {
        Self::new()
    }
}

impl MemState {
    pub fn new() -> Self {
        Self(Rc::new(RefCell::new(Inner {
            state: SyncState::default(),
            locked: Rc::new(Cell::new(false)),
            transactions: 0,
            bases: BTreeMap::new(),
        })))
    }

    /// The state now.
    pub fn snapshot(&self) -> SyncState {
        self.0.borrow().state.clone()
    }

    /// How many transactions were applied.
    pub fn transactions(&self) -> u64 {
        self.0.borrow().transactions
    }

    /// Takes the lock the way another process would (С14).
    pub fn lock_from_outside(&self) -> StateLock {
        let inner = self.0.borrow();
        assert!(!inner.locked.get(), "already locked");
        inner.locked.set(true);
        StateLock(Box::new(LockToken(inner.locked.clone())))
    }

    /// Forgets everything: the state file and the bases are gone (С11, Р10, Г10).
    pub fn wipe(&self) {
        let mut inner = self.0.borrow_mut();
        inner.state = SyncState::default();
        inner.bases.clear();
    }

    /// How many bases are kept (a test of Г9 looks at it).
    pub fn base_count(&self) -> usize {
        self.0.borrow().bases.len()
    }

    /// Damages a stored base without telling anyone (Г7: it must then read as "no base").
    pub fn damage_base(&self, item: &ItemId, hash: &[u8; 32]) {
        if let Some(bytes) = self
            .0
            .borrow_mut()
            .bases
            .get_mut(&(*item.as_bytes(), *hash))
        {
            bytes.push(b'!');
        }
    }

    /// Replaces the state wholesale (a test builds a state by hand).
    pub fn set(&self, state: SyncState) {
        self.0.borrow_mut().state = state;
    }

    /// The reference meaning of a [`StateOp`] (appendix В, Д3, Д56).
    pub fn apply_op(state: &mut SyncState, op: &StateOp) {
        match op {
            StateOp::SetInstance(id) => state.instance_id = Some(*id),
            StateOp::SetCursor { cursor, head } => {
                state.cursor = *cursor;
                state.head = *head;
            }
            StateOp::PutItem(record) => {
                state
                    .items
                    .insert(*record.item_id.as_bytes(), record.clone());
            }
            StateOp::RemoveItem(id) => {
                state.items.remove(id.as_bytes());
            }
            StateOp::PutUpload(upload) => {
                state
                    .uploads
                    .insert(*upload.blob_id.as_bytes(), upload.clone());
            }
            StateOp::RemoveUpload(id) => {
                state.uploads.remove(id.as_bytes());
            }
            StateOp::SetCommit(commit) => state.commit = commit.clone(),
            StateOp::AddConflict(conflict) => {
                if !state.conflicts.iter().any(|c| c.id == conflict.id) {
                    state.conflicts.push(conflict.clone());
                }
            }
            StateOp::RemoveConflict(id) => state.conflicts.retain(|c| c.id != *id),
            StateOp::SetUnsynced(list) => state.unsynced = list.clone(),
            StateOp::ResetServerLink => {
                state.items.clear();
                state.cursor = 0;
                state.head = 0;
                state.uploads.clear();
                state.commit = None;
            }
        }
    }
}

impl StateStore for MemState {
    fn load(&mut self) -> Result<SyncState, StateError> {
        Ok(self.0.borrow().state.clone())
    }

    fn apply(&mut self, tx: &StateTx) -> Result<(), StateError> {
        let mut inner = self.0.borrow_mut();
        let mut next = inner.state.clone();
        for op in tx {
            Self::apply_op(&mut next, op);
        }
        inner.state = next;
        inner.transactions += 1;
        Ok(())
    }

    fn lock(&mut self) -> Result<StateLock, StateError> {
        let inner = self.0.borrow();
        if inner.locked.get() {
            return Err(StateError::Locked);
        }
        inner.locked.set(true);
        Ok(StateLock(Box::new(LockToken(inner.locked.clone()))))
    }

    fn base_put(&mut self, item: &ItemId, hash: &[u8; 32], bytes: &[u8]) -> Result<(), StateError> {
        self.0
            .borrow_mut()
            .bases
            .insert((*item.as_bytes(), *hash), bytes.to_vec());
        Ok(())
    }

    fn base_get(&mut self, item: &ItemId, hash: &[u8; 32]) -> Result<Option<Vec<u8>>, StateError> {
        let inner = self.0.borrow();
        Ok(inner
            .bases
            .get(&(*item.as_bytes(), *hash))
            .filter(|bytes| blake3_hash(bytes) == *hash)
            .cloned())
    }

    fn base_prune(&mut self, keep: &[(ItemId, [u8; 32])]) -> Result<(), StateError> {
        self.0
            .borrow_mut()
            .bases
            .retain(|(item, hash), _| keep.iter().any(|(i, h)| i.as_bytes() == item && h == hash));
        Ok(())
    }
}
