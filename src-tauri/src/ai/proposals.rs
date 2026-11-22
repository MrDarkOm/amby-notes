//! The AI panel's proposal cards (docs/road/ai-panel-tools.md, stage 2). The write tools only
//! create proposals; they wait here, in memory, until the user applies or rejects them. Applying
//! goes through the desktop mutation gate, so it is ordered with editor saves.

use std::collections::HashMap;
use std::sync::Mutex;

use amby_core::ai_proposals::{self, Applied, Proposal, ProposalOp, UndoPlan, WriteScope};
use amby_core::recycle_bin::DeleteMode;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::lock_util::LockExt;
use crate::vault_context::VaultContext;

/// The most proposals kept; the oldest go first.
const MAX_KEPT: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CardState {
    Pending,
    Applied,
    Rejected,
    Undone,
    Outdated,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalCard {
    pub id: String,
    pub path: String,
    /// `new`, `append` or `replace`.
    pub kind: String,
    pub diff: String,
    pub diff_truncated: bool,
    /// Every file a move, rename, archive or deletion touches; empty for other changes.
    pub affected: Vec<String>,
    pub affected_truncated: bool,
    /// An applied change can be undone from the card; a deletion to the system trash cannot.
    pub can_undo: bool,
    pub state: CardState,
}

struct Entry {
    generation: u64,
    order: u64,
    proposal: Proposal,
    state: CardState,
    applied: Option<Applied>,
}

impl Entry {
    fn card(&self) -> ProposalCard {
        ProposalCard {
            id: self.proposal.id.clone(),
            path: self.proposal.path.clone(),
            kind: match self.proposal.op {
                ProposalOp::New { .. } => "new",
                ProposalOp::Append { .. } => "append",
                ProposalOp::Replace { .. } => "replace",
                ProposalOp::SetProperty { .. } => "setProperty",
                ProposalOp::DeleteProperty { .. } => "deleteProperty",
                ProposalOp::RenameProperty { .. } => "renameProperty",
                ProposalOp::CreateDatabaseRow { .. } => "createDatabaseRow",
                ProposalOp::SetDatabaseValue { .. } => "setDatabaseValue",
                ProposalOp::Move { .. } => "move",
                ProposalOp::Rename { .. } => "rename",
                ProposalOp::Archive { .. } => "archive",
                ProposalOp::Delete { .. } => "delete",
            }
            .into(),
            diff: self.proposal.diff.clone(),
            diff_truncated: self.proposal.diff_truncated,
            affected: self.proposal.affected.clone(),
            affected_truncated: self.proposal.affected_truncated,
            can_undo: self.applied.as_ref().is_none_or(|applied| !applied.removed),
            state: self.state,
        }
    }
}

#[derive(Default)]
pub struct ProposalStore {
    entries: Mutex<HashMap<String, Entry>>,
    counter: std::sync::atomic::AtomicU64,
}

impl ProposalStore {
    /// Keeps a proposal for the vault activation `generation` and returns its card.
    pub fn insert(&self, generation: u64, proposal: Proposal) -> ProposalCard {
        let order = self
            .counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let entry = Entry {
            generation,
            order,
            proposal,
            state: CardState::Pending,
            applied: None,
        };
        let card = entry.card();
        let mut entries = self.entries.lock_or_recover();
        if entries.len() >= MAX_KEPT {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.order)
                .map(|(id, _)| id.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(card.id.clone(), entry);
        card
    }

    fn with<T>(
        &self,
        generation: u64,
        id: &str,
        run: impl FnOnce(&mut Entry) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        let mut entries = self.entries.lock_or_recover();
        let entry = entries
            .get_mut(id)
            .filter(|entry| entry.generation == generation)
            .ok_or("proposalNotFound")?;
        run(entry)
    }

    fn pending(&self, generation: u64, id: &str) -> Result<Proposal, &'static str> {
        self.with(generation, id, |entry| {
            if entry.state == CardState::Pending {
                Ok(entry.proposal.clone())
            } else {
                Err("proposalNotPending")
            }
        })
    }

    fn mark_applied(
        &self,
        generation: u64,
        id: &str,
        applied: Applied,
    ) -> Result<ProposalCard, &'static str> {
        self.with(generation, id, |entry| {
            entry.state = CardState::Applied;
            entry.applied = Some(applied);
            Ok(entry.card())
        })
    }

    fn set_state(
        &self,
        generation: u64,
        id: &str,
        state: CardState,
    ) -> Result<ProposalCard, &'static str> {
        self.with(generation, id, |entry| {
            entry.state = state;
            Ok(entry.card())
        })
    }

    fn applied(&self, generation: u64, id: &str) -> Result<Applied, &'static str> {
        self.with(generation, id, |entry| {
            match (&entry.state, &entry.applied) {
                (CardState::Applied, Some(applied)) => Ok(applied.clone()),
                _ => Err("proposalNotApplied"),
            }
        })
    }
}

/// Every proposal was checked against its own write scope when it was made, and the path is part
/// of it, so applying and undoing only need the note itself to be in the vault.
fn whole_vault() -> WriteScope {
    WriteScope {
        vault: true,
        ..WriteScope::default()
    }
}

/// The vault root of the active activation, read under the mutation gate the caller holds.
fn active_root(
    context: &VaultContext,
    generation: u64,
) -> Result<std::path::PathBuf, &'static str> {
    let active = context.conn.lock_or_recover();
    let active = active.as_ref().ok_or("vaultNotActive")?;
    if active.generation != generation {
        return Err("vaultNotActive");
    }
    Ok(active.root.clone())
}

fn apply_blocking(
    app: &tauri::AppHandle,
    generation: u64,
    id: &str,
    unsaved_paths: &[String],
    delete_mode: DeleteMode,
) -> Result<ProposalCard, &'static str> {
    let store = app.state::<ProposalStore>();
    let proposal = store.pending(generation, id)?;
    // A note with unsaved edits is never overwritten; the card waits until it is saved. For a
    // move, rename or deletion that includes the notes inside the item and the notes whose
    // links would be rewritten.
    if proposal.touches(unsaved_paths) {
        return Err("noteHasUnsavedEdits");
    }
    let context = app.state::<VaultContext>();
    let result = if proposal.op.is_engine_change() || proposal.op.is_structural() {
        // The property and structural engines take the mutation gate themselves, through the
        // same path as the MCP tools, and refresh the index.
        let root = active_root(&context, generation)?;
        ai_proposals::apply_deleting(&root, &whole_vault(), &proposal, delete_mode, &|mutation| {
            let request = amby_core::cli_ipc::Request {
                version: amby_core::cli_ipc::VERSION,
                vault: root.clone(),
                action: amby_core::cli_ipc::Action::Tool {
                    grant: String::new(),
                    request: serde_json::to_value(mutation)
                        .and_then(serde_json::from_value)
                        .map_err(|_| "invalidArguments")?,
                },
            };
            match crate::cli_structural::handle(app, request)? {
                amby_core::cli_ipc::Payload::Tool(output) => Ok(output),
                _ => Err("unavailable"),
            }
        })
    } else {
        let _gate = context.mutation_gate.lock_or_recover();
        let root = active_root(&context, generation)?;
        ai_proposals::apply(&root, &whole_vault(), &proposal)
    };
    match result {
        Ok(applied) => store.mark_applied(generation, id, applied),
        Err("outdated") => store.set_state(generation, id, CardState::Outdated),
        Err(code) => Err(code),
    }
}

fn undo_blocking(
    app: &tauri::AppHandle,
    generation: u64,
    id: &str,
    unsaved_paths: &[String],
) -> Result<ProposalCard, &'static str> {
    /// What is left to do once the gate is released.
    enum Then {
        Remove(amby_core::vault_tools::Mutation),
    }
    let store = app.state::<ProposalStore>();
    let applied = store.applied(generation, id)?;
    if unsaved_paths.contains(&applied.path)
        || ai_proposals::touches(&applied.affected, unsaved_paths)
    {
        return Err("noteHasUnsavedEdits");
    }
    let context = app.state::<VaultContext>();
    let (root, then) = {
        let _gate = context.mutation_gate.lock_or_recover();
        let root = active_root(&context, generation)?;
        match ai_proposals::undo_plan(&root, &applied)? {
            UndoPlan::Restore { .. } => {
                ai_proposals::undo(&root, &whole_vault(), &applied)?;
                return store.set_state(generation, id, CardState::Undone);
            }
            UndoPlan::Trash { path } => (
                root,
                Then::Remove(amby_core::vault_tools::Mutation::Delete { path }),
            ),
            UndoPlan::DeleteRow {
                database_id,
                note_id,
            } => (
                root,
                Then::Remove(amby_core::vault_tools::Mutation::DeleteDatabaseRow {
                    database_id,
                    note_id,
                }),
            ),
            UndoPlan::Structural(inverse) => match ai_proposals::inverse_mutation(&inverse) {
                Some(mutation) => (root, Then::Remove(mutation)),
                None => return Err("undoUnavailable"),
            },
        }
    };
    match then {
        // A note or row the apply created goes back to the system trash through the same path as
        // the MCP delete; a structural change goes back by its inverse operation. Both take the
        // mutation gate themselves.
        Then::Remove(mutation) => {
            let request = amby_core::cli_ipc::Request {
                version: amby_core::cli_ipc::VERSION,
                vault: root,
                action: amby_core::cli_ipc::Action::Tool {
                    grant: String::new(),
                    request: mutation,
                },
            };
            crate::cli_structural::handle(app, request)?;
        }
    }
    store.set_state(generation, id, CardState::Undone)
}

async fn run_blocking<F>(app: tauri::AppHandle, work: F) -> Result<ProposalCard, String>
where
    F: FnOnce(&tauri::AppHandle) -> Result<ProposalCard, &'static str> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || work(&app))
        .await
        .map_err(|_| "requestFailed".to_owned())?
        .map_err(str::to_owned)
}

/// Applies a pending proposal. `unsaved_paths` are the notes open with unsaved edits.
#[tauri::command]
#[specta::specta]
pub async fn ai_apply_proposal(
    app: tauri::AppHandle,
    generation: u64,
    id: String,
    unsaved_paths: Vec<String>,
    delete_mode: Option<DeleteMode>,
) -> Result<ProposalCard, String> {
    run_blocking(app, move |app| {
        apply_blocking(
            app,
            generation,
            &id,
            &unsaved_paths,
            delete_mode.unwrap_or_default(),
        )
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn ai_reject_proposal(
    app: tauri::AppHandle,
    generation: u64,
    id: String,
) -> Result<ProposalCard, String> {
    run_blocking(app, move |app| {
        let store = app.state::<ProposalStore>();
        store.pending(generation, &id)?;
        store.set_state(generation, &id, CardState::Rejected)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn ai_undo_proposal(
    app: tauri::AppHandle,
    generation: u64,
    id: String,
    unsaved_paths: Vec<String>,
) -> Result<ProposalCard, String> {
    run_blocking(app, move |app| {
        undo_blocking(app, generation, &id, &unsaved_paths)
    })
    .await
}

/// The JSON of a card for the turn's event stream.
pub fn card_json(card: &ProposalCard) -> Value {
    serde_json::to_value(card).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(path: &str) -> Proposal {
        Proposal {
            id: ulid::Ulid::generate().to_string(),
            op: ProposalOp::Append {
                path: path.into(),
                content: "x".into(),
            },
            path: path.into(),
            base: None,
            diff: "+x".into(),
            diff_truncated: false,
            affected: Vec::new(),
            affected_truncated: false,
        }
    }

    #[test]
    fn a_card_is_pending_until_it_is_decided_and_decided_once() {
        let store = ProposalStore::default();
        let card = store.insert(1, proposal("a.md"));
        assert_eq!(card.state, CardState::Pending);
        assert_eq!(card.kind, "append");
        assert!(store.pending(1, &card.id).is_ok());
        store.set_state(1, &card.id, CardState::Rejected).unwrap();
        assert_eq!(
            store.pending(1, &card.id).unwrap_err(),
            "proposalNotPending"
        );
        assert_eq!(store.applied(1, &card.id), Err("proposalNotApplied"));
    }

    #[test]
    fn a_card_belongs_to_one_vault_activation() {
        let store = ProposalStore::default();
        let card = store.insert(1, proposal("a.md"));
        assert_eq!(store.pending(2, &card.id).unwrap_err(), "proposalNotFound");
        assert_eq!(store.pending(1, "missing").unwrap_err(), "proposalNotFound");
    }

    #[test]
    fn only_an_applied_card_can_be_undone_and_old_cards_are_dropped() {
        let store = ProposalStore::default();
        let card = store.insert(1, proposal("a.md"));
        let applied = Applied {
            path: "a.md".into(),
            snapshot_id: Some("s".into()),
            after: "h".into(),
            created: false,
            row: None,
            inverse: None,
            removed: false,
            affected: Vec::new(),
        };
        store.mark_applied(1, &card.id, applied.clone()).unwrap();
        assert_eq!(store.applied(1, &card.id), Ok(applied));
        for _ in 0..MAX_KEPT {
            store.insert(1, proposal("b.md"));
        }
        assert_eq!(store.applied(1, &card.id), Err("proposalNotFound"));
    }
}
