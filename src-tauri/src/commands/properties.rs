//! Properties of notes as the header plus a template plus groups of differences (appendix З):
//! the panel of a note, the sleeping records, the migration from `properties.json`, the
//! edits of an old version, the inspection. The id-based commands of `notes.rs` stay and work
//! on the groups through [`crate::property_groups::upsert_compat`].

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lock_util::LockExt;
use crate::property_groups::{
    self, legacy, migration, ActiveProperty, Panel, PanelWarning, RenameHint, StorageMode,
};
use crate::property_template;
use crate::sync::runtime::SyncRuntime;
use crate::sync::vault_types::SyncPhase;
use crate::vault_context::VaultContext;

// ----- the template -----

/// A name of a basic property in one language of the interface, with its options (З45).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateName {
    pub language: String,
    pub name: String,
    pub settings: String,
}

/// A basic property (З45).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateEntry {
    pub property_type: String,
    pub icon: String,
    pub names: Vec<TemplateName>,
}

/// The template of basic properties and its number (З45, З48).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyTemplate {
    pub version: u32,
    pub properties: Vec<TemplateEntry>,
}

#[tauri::command]
#[specta::specta]
pub fn list_property_template() -> PropertyTemplate {
    PropertyTemplate {
        version: property_template::TEMPLATE_VERSION,
        properties: property_template::all()
            .into_iter()
            .map(|(property, names)| TemplateEntry {
                property_type: property.property_type,
                icon: property.icon,
                names: names
                    .into_iter()
                    .map(|(language, name)| {
                        let settings = property_template::lookup(&name)
                            .map(|found| found.settings)
                            .unwrap_or_default();
                        TemplateName {
                            language,
                            name,
                            settings,
                        }
                    })
                    .collect(),
            })
            .collect(),
    }
}

// ----- the panel -----

/// A property of the panel (З46).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PanelProperty {
    pub name: String,
    pub key: String,
    pub value: String,
    pub property_type: String,
    pub icon: String,
    pub settings: String,
    pub from_template: bool,
    pub has_record: bool,
    pub read_only: bool,
    pub type_mismatch: bool,
    pub outside_options: bool,
}

impl From<ActiveProperty> for PanelProperty {
    fn from(p: ActiveProperty) -> Self {
        Self {
            name: p.name,
            key: p.key,
            value: p.value,
            property_type: p.property_type,
            icon: p.icon,
            settings: p.settings,
            from_template: p.from_template,
            has_record: p.has_record,
            read_only: p.read_only,
            type_mismatch: p.type_mismatch,
            outside_options: p.outside_options,
        }
    }
}

/// A record without a key: grey, «нет в шапке» (З3).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DormantView {
    pub name: String,
    pub icon: String,
    pub property_type: String,
    pub settings: String,
}

/// «Похоже, «Статус» переименовали в «Состояние»» (З3а).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameHintView {
    pub old_name: String,
    pub new_name: String,
}

/// What is wrong with the panel of a note.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PanelWarningView {
    AmbiguousKey { name: String },
    FormatNewer,
    BadLineInGroup,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPanel {
    pub unreadable: bool,
    pub active: Vec<PanelProperty>,
    pub dormant: Vec<DormantView>,
    pub rename_hint: Option<RenameHintView>,
    pub warnings: Vec<PanelWarningView>,
}

fn panel_view(panel: Panel) -> PropertyPanel {
    PropertyPanel {
        unreadable: panel.unreadable,
        active: panel.active.into_iter().map(Into::into).collect(),
        dormant: panel
            .dormant
            .into_iter()
            .map(|d| {
                let look = property_groups::look_for_view(&d.name, &d.diff);
                DormantView {
                    name: d.name,
                    icon: look.0,
                    property_type: look.1,
                    settings: look.2,
                }
            })
            .collect(),
        rename_hint: panel.rename_hint.map(|h| RenameHintView {
            old_name: h.old_name,
            new_name: h.new_name,
        }),
        warnings: panel
            .warnings
            .into_iter()
            .map(|w| match w {
                PanelWarning::AmbiguousKey { name } => PanelWarningView::AmbiguousKey { name },
                PanelWarning::FormatNewer => PanelWarningView::FormatNewer,
                PanelWarning::BadLineInGroup => PanelWarningView::BadLineInGroup,
            })
            .collect(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_property_panel(
    db: State<'_, VaultContext>,
    note_id: String,
) -> Result<PropertyPanel, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    property_groups::panel(conn, &conn.root, &note_id).map(panel_view)
}

macro_rules! with_vault_mutation {
    ($db:expr, |$conn:ident| $body:expr) => {{
        let _mutation_guard = $db.mutation_gate.lock_or_recover();
        let conn_guard = $db.conn.lock_or_recover();
        let $conn = conn_guard.as_ref().ok_or("No vault open")?;
        $body
    }};
}

#[tauri::command]
#[specta::specta]
pub fn restore_dormant_property(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::restore_dormant(
        conn, &conn.root, &note_id, &name
    ))
}

#[tauri::command]
#[specta::specta]
pub fn purge_dormant_property(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::purge_dormant(
        conn, &conn.root, &note_id, &name
    ))
}

#[tauri::command]
#[specta::specta]
pub fn accept_property_rename_hint(
    db: State<'_, VaultContext>,
    note_id: String,
    hint: RenameHintView,
) -> Result<(), String> {
    let hint = RenameHint {
        old_name: hint.old_name,
        new_name: hint.new_name,
    };
    with_vault_mutation!(db, |conn| property_groups::accept_rename_hint(
        conn, &conn.root, &note_id, &hint
    ))
}

#[tauri::command]
#[specta::specta]
pub fn dismiss_property_rename_hint(
    db: State<'_, VaultContext>,
    note_id: String,
    hint: RenameHintView,
) -> Result<(), String> {
    let hint = RenameHint {
        old_name: hint.old_name,
        new_name: hint.new_name,
    };
    with_vault_mutation!(db, |conn| property_groups::dismiss_rename_hint(
        conn, &conn.root, &note_id, &hint
    ))
}

// ----- storage, migration, old versions -----

/// Where the properties of the open vault live (З6, З38) and whether an old version writes.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyStorageStatus {
    /// `legacy`, `groups` or `newer`.
    pub mode: String,
    /// The sentence of З37 while an old version still writes `properties.json`.
    pub old_version_warning: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn property_storage_status(
    db: State<'_, VaultContext>,
) -> Result<PropertyStorageStatus, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let mode = match property_groups::storage_mode(&conn.root)? {
        StorageMode::Legacy => "legacy",
        StorageMode::Groups => "groups",
        StorageMode::Newer => "newer",
    };
    let warning = if mode == "groups" {
        legacy::sync_screen_warning(&conn.root)?
    } else {
        None
    };
    Ok(PropertyStorageStatus {
        mode: mode.to_string(),
        old_version_warning: warning,
    })
}

/// A value of the old file that differs from the header of the note (З58).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MismatchView {
    pub note_id: String,
    pub name: String,
    pub file_value: String,
    pub header_value: String,
}

/// What the opening of the vault did with the properties (З57): `alreadyGroups`, `migrated`,
/// `arrivedFromServer` or `readOnly` (with the reason `unreadableOldFile` or `waitingForSync`).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenPropertiesView {
    pub state: String,
    pub reason: Option<String>,
    pub migration_id: Option<String>,
    /// The notes whose value in the old file differed from the header's (З58).
    pub diverged: Vec<MismatchView>,
}

fn sync_context(runtime: &SyncRuntime) -> migration::Context {
    let status = runtime.status();
    migration::Context {
        sync_enabled: status.enabled,
        last_pass_ok: status.enabled
            && matches!(status.phase, SyncPhase::Idle)
            && status.error_code.is_none()
            && status.last_sync_ms.is_some(),
        layout_came_from_server: false,
        arrived_template: None,
    }
}

/// The first opening of the vault by the new version migrates the properties by itself, with no
/// question; asked again it has nothing to do (З57, З59). Nothing is written when it does not
/// migrate.
#[tauri::command]
#[specta::specta]
pub fn open_vault_properties(
    db: State<'_, VaultContext>,
    runtime: State<'_, SyncRuntime>,
) -> Result<OpenPropertiesView, String> {
    let context = sync_context(&runtime);
    let outcome = with_vault_mutation!(db, |conn| {
        let outcome = migration::open_vault(conn, &conn.root, &context)?;
        if matches!(outcome, migration::OpenOutcome::Migrated(_)) {
            let _ = property_groups::restore_cache_any(conn, &conn.root);
        }
        outcome
    });
    let view = |state: &str, reason: Option<&str>| OpenPropertiesView {
        state: state.to_string(),
        reason: reason.map(str::to_string),
        migration_id: None,
        diverged: Vec::new(),
    };
    Ok(match outcome {
        migration::OpenOutcome::AlreadyGroups => view("alreadyGroups", None),
        migration::OpenOutcome::ArrivedFromServer => view("arrivedFromServer", None),
        migration::OpenOutcome::ReadOnly(reason) => view(
            "readOnly",
            Some(match reason {
                migration::ReadOnlyReason::UnreadableOldFile => "unreadableOldFile",
                migration::ReadOnlyReason::WaitingForSync => "waitingForSync",
            }),
        ),
        migration::OpenOutcome::Migrated(done) => OpenPropertiesView {
            migration_id: Some(done.migration_id),
            diverged: done
                .diverged
                .into_iter()
                .map(|m| MismatchView {
                    note_id: m.note_id,
                    name: m.name,
                    file_value: m.file_value,
                    header_value: m.header_value,
                })
                .collect(),
            ..view("migrated", None)
        },
    })
}

/// «Взять значение из старого файла»: an ordinary edit of the value (З58, З1).
#[tauri::command]
#[specta::specta]
pub fn take_property_file_value(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| migration::take_file_value(
        conn, &conn.root, &note_id, &name
    ))
}

// ----- the edits by the name of the property (З60) -----

/// A new property: the key goes into the header, the look into the record if it differs.
#[tauri::command]
#[specta::specta]
pub fn create_note_property(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
    icon: String,
    property_type: String,
    settings: String,
    value: String,
) -> Result<String, String> {
    with_vault_mutation!(db, |conn| property_groups::create_property(
        conn,
        &conn.root,
        &note_id,
        property_groups::Design {
            name,
            icon,
            property_type,
            settings
        },
        &value
    ))
}

#[tauri::command]
#[specta::specta]
pub fn rename_note_property(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
    new_name: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::rename_property(
        conn, &conn.root, &note_id, &name, &new_name
    ))
}

#[tauri::command]
#[specta::specta]
pub fn change_note_property_type(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
    property_type: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::change_type(
        conn,
        &conn.root,
        &note_id,
        &name,
        &property_type
    ))
}

#[tauri::command]
#[specta::specta]
pub fn set_note_property_appearance(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
    icon: String,
    settings: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::set_appearance(
        conn, &conn.root, &note_id, &name, &icon, &settings
    ))
}

#[tauri::command]
#[specta::specta]
pub fn set_note_property_value(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
    value: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::set_value(
        conn, &conn.root, &note_id, &name, &value
    ))
}

#[tauri::command]
#[specta::specta]
pub fn reorder_note_properties(
    db: State<'_, VaultContext>,
    note_id: String,
    names: Vec<String>,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::reorder(
        conn, &conn.root, &note_id, &names
    ))
}

#[tauri::command]
#[specta::specta]
pub fn delete_note_property(
    db: State<'_, VaultContext>,
    note_id: String,
    name: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::delete_property(
        conn, &conn.root, &note_id, &name
    ))
}

/// What a rollback did (З42).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RollbackView {
    pub headers_restored: Vec<String>,
    pub not_restored: Vec<String>,
    pub groups_removed: u32,
}

#[tauri::command]
#[specta::specta]
pub fn rollback_properties_migration(
    db: State<'_, VaultContext>,
    migration_id: String,
) -> Result<RollbackView, String> {
    let report = with_vault_mutation!(db, |conn| {
        let report = migration::rollback(conn, &conn.root, &migration_id)?;
        let _ = property_groups::restore_cache_any(conn, &conn.root);
        report
    });
    Ok(RollbackView {
        headers_restored: report.headers_restored,
        not_restored: report.not_restored,
        groups_removed: report.groups_removed as u32,
    })
}

/// The edits of an old version that were carried over, and the notes changed on both sides (З22).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OldVersionReport {
    pub transferred: Vec<String>,
    pub conflicts: Vec<String>,
    /// «Свойства, изменённые старой версией Amby на другом устройстве, перенесены: N заметок».
    pub hint_text: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn check_old_version_property_edits(
    db: State<'_, VaultContext>,
) -> Result<OldVersionReport, String> {
    let mut report =
        with_vault_mutation!(db, |conn| legacy::check_old_version_edits(conn, &conn.root))?;
    // What the opening of the vault found is told once, together with a fresh check.
    if let Some(earlier) = property_groups::take_pending_old_version_report() {
        report.transferred.extend(earlier.transferred);
        for conflict in earlier.conflicts {
            if !report.conflicts.contains(&conflict) {
                report.conflicts.push(conflict);
            }
        }
    }
    Ok(OldVersionReport {
        hint_text: report.hint_text(),
        transferred: report.transferred,
        conflicts: report.conflicts.into_iter().map(|c| c.note_id).collect(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn resolve_old_version_property_conflict(
    db: State<'_, VaultContext>,
    note_id: String,
    keep_here: bool,
) -> Result<(), String> {
    let choice = if keep_here {
        legacy::LegacyChoice::KeepHere
    } else {
        legacy::LegacyChoice::TakeOld
    };
    with_vault_mutation!(db, |conn| legacy::resolve_conflict(
        conn, &conn.root, &note_id, choice
    ))
}

// ----- the inspection -----

/// A line of a group that cannot be used (З51).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BadLineView {
    pub file: String,
    pub number: u32,
    pub note_id: Option<String>,
}

/// A property of a note named in the inspection.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePropertyRef {
    pub note_id: String,
    pub name: String,
}

/// The inspection of the properties of the vault (З10).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyInspection {
    pub dormant: Vec<NotePropertyRef>,
    pub orphans: Vec<String>,
    pub ambiguous: Vec<NotePropertyRef>,
    pub reserved_names: Vec<NotePropertyRef>,
    pub unfinished_operations: Vec<String>,
    pub bad_lines: Vec<BadLineView>,
}

#[tauri::command]
#[specta::specta]
pub fn inspect_properties(db: State<'_, VaultContext>) -> Result<PropertyInspection, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    let report = property_groups::inspect(conn, &conn.root)?;
    let refs = |pairs: Vec<(String, String)>| {
        pairs
            .into_iter()
            .map(|(note_id, name)| NotePropertyRef { note_id, name })
            .collect()
    };
    Ok(PropertyInspection {
        dormant: refs(report.dormant),
        orphans: report.orphans,
        ambiguous: refs(report.ambiguous),
        reserved_names: refs(report.reserved_names),
        unfinished_operations: report.unfinished_operations,
        bad_lines: report
            .bad_lines
            .into_iter()
            .map(|b| BadLineView {
                file: b.file,
                number: b.number as u32,
                note_id: b.note_id,
            })
            .collect(),
    })
}

/// «У заметки сменился идентификатор. Привязать к ней её прежние свойства?» (З11, З35).
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RebindOfferView {
    pub old_id: String,
    pub new_id: String,
    pub path: String,
}

#[tauri::command]
#[specta::specta]
pub fn list_property_rebind_offers(
    db: State<'_, VaultContext>,
) -> Result<Vec<RebindOfferView>, String> {
    let conn_guard = db.conn.lock_or_recover();
    let conn = conn_guard.as_ref().ok_or("No vault open")?;
    Ok(property_groups::rebind_offers(conn, &conn.root)?
        .into_iter()
        .map(|o| RebindOfferView {
            old_id: o.old_id,
            new_id: o.new_id,
            path: o.path,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn rebind_note_properties(
    db: State<'_, VaultContext>,
    old_id: String,
    new_id: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::rebind(
        conn, &conn.root, &old_id, &new_id
    ))
}

#[tauri::command]
#[specta::specta]
pub fn delete_orphan_properties(
    db: State<'_, VaultContext>,
    note_id: String,
) -> Result<(), String> {
    with_vault_mutation!(db, |conn| property_groups::delete_orphan(
        conn, &conn.root, &note_id
    ))
}
