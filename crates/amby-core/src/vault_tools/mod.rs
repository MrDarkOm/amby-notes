//! Capability-checked MCP operations shared by the CLI and desktop endpoint.

pub mod attachments;
pub mod database;
pub mod delete;
pub mod hygiene;
pub mod modules;
pub mod properties;
pub mod workshop;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::index::read_only::visible_folder;
use crate::model::PathChange;
use crate::self_write::SelfWriteTracker;
use crate::structural::{self, Operation};

pub const MAX_ITEMS: usize = 100;

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Mutation {
    Rename {
        path: String,
        name: String,
    },
    Move {
        path: String,
        folder: String,
    },
    Archive {
        path: String,
    },
    Restore {
        path: String,
    },
    CreateDatabase {
        parent: String,
        name: String,
    },
    CreateDatabaseRow {
        database_id: String,
        title: String,
    },
    AddDatabaseProperty {
        database_id: String,
        name: String,
        property_type: String,
        expected_revision: String,
        #[serde(default)]
        options: Vec<String>,
    },
    RenameDatabase {
        database_id: String,
        name: String,
        expected_revision: String,
    },
    RenameDatabaseProperty {
        database_id: String,
        property_id: String,
        name: String,
        expected_revision: String,
    },
    SetDatabaseValue(SetDatabaseValue),
    CreateDatabaseRelation(RelationSchema),
    SetDatabaseRelation(RelationValue),
    CreateWorkshop {
        parent: String,
        name: String,
        operation_id: String,
    },
    CreateStory {
        workshop_id: String,
        title: String,
        operation_id: String,
    },
    UpdateWorkshop(WorkshopUpdate),
    CreateTextPage(TextPage),
    CreateWorkshopSection {
        workshop_id: String,
        name: String,
        expected_revision: String,
        operation_id: String,
    },
    SetProperty(properties::SetProperty),
    SetPropertyAppearance(properties::PropertyAppearance),
    RenameProperty {
        path: String,
        name: String,
        new_name: String,
    },
    DeleteProperty {
        path: String,
        name: String,
    },
    ReorderProperties {
        path: String,
        names: Vec<String>,
    },
    Delete {
        path: String,
    },
    DeleteDatabaseRow {
        database_id: String,
        note_id: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDatabaseValue {
    database_id: String,
    note_id: String,
    property_id: String,
    expected_revision: String,
    operation_id: String,
    value: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationSchema {
    database_id: String,
    target_database_id: String,
    name: String,
    inverse_name: String,
    expected_revision: String,
    expected_target_revision: String,
    operation_id: String,
    max_items: Option<u8>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationValue {
    database_id: String,
    note_id: String,
    property_id: String,
    target_note_ids: Vec<String>,
    expected_revision: String,
    operation_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkshopUpdate {
    workshop_id: String,
    expected_revision: String,
    operation_id: String,
    name: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPage {
    story_id: String,
    title: String,
    level_id: String,
    order_key: String,
    parent_note_id: Option<String>,
    format_id: Option<String>,
}

impl Mutation {
    pub fn required_module(&self) -> Option<modules::Module> {
        use modules::Module;
        match self {
            Self::CreateDatabase { .. }
            | Self::CreateDatabaseRow { .. }
            | Self::DeleteDatabaseRow { .. }
            | Self::AddDatabaseProperty { .. }
            | Self::SetDatabaseValue(_)
            | Self::RenameDatabase { .. }
            | Self::RenameDatabaseProperty { .. }
            | Self::CreateDatabaseRelation(_)
            | Self::SetDatabaseRelation(_) => Some(Module::Databases),
            Self::CreateWorkshop { .. }
            | Self::CreateStory { .. }
            | Self::CreateWorkshopSection { .. }
            | Self::UpdateWorkshop(_)
            | Self::CreateTextPage(_) => Some(Module::Creative),
            _ => None,
        }
    }

    pub fn structural(&self) -> Option<Operation<'_>> {
        Some(match self {
            Self::Rename { path, name } => Operation::Rename { path, name },
            Self::Move { path, folder } => Operation::Move { path, folder },
            Self::Archive { path } => Operation::Archive { path },
            Self::Restore { path } => Operation::Restore { path },
            _ => return None,
        })
    }
}

pub struct Published {
    pub output: Value,
    pub changed: Vec<PathBuf>,
    pub archive_changed: bool,
    /// The property groups changed: the desktop refreshes its properties panel.
    pub properties_changed: bool,
}

impl Published {
    fn one(output: Value, path: PathBuf) -> Self {
        Self {
            output,
            changed: vec![path],
            archive_changed: false,
            properties_changed: false,
        }
    }
}

impl Mutation {
    fn is_property(&self) -> bool {
        matches!(
            self,
            Self::SetProperty(_)
                | Self::SetPropertyAppearance(_)
                | Self::RenameProperty { .. }
                | Self::DeleteProperty { .. }
                | Self::ReorderProperties { .. }
        )
    }
}

fn allowed(scope: &Path, path: &Path) -> Result<(), &'static str> {
    if path.starts_with(scope) {
        Ok(())
    } else {
        Err("outsideWriteScope")
    }
}

fn relative(root: &Path, path: &Path) -> Result<String, &'static str> {
    crate::durable::relative_string(root, path, "MCP operation").map_err(|_| "accessDenied")
}

fn root_folder(path: &str) -> &str {
    if path == "." {
        ""
    } else {
        path
    }
}

fn operation_id(
    root: &Path,
    scope: &Path,
    domain: &str,
    input: &str,
) -> Result<String, &'static str> {
    if !crate::durable::valid_operation_id(input) {
        return Err("invalidArguments");
    }
    let grant = relative(root, scope)?;
    // Scope and action are part of replay identity. An operation from a
    // broader grant cannot be resumed by passing its client-supplied key.
    let bytes = serde_json::to_vec(&(grant, domain, input)).map_err(|_| "invalidArguments")?;
    Ok(format!(
        "mcp-{}",
        crate::database::format::raw_revision(&bytes)
    ))
}

pub fn execute_offline(
    root: &Path,
    grant: &str,
    request: &Mutation,
) -> Result<Value, &'static str> {
    if let Some(module) = request.required_module() {
        modules::Modules::require(root, module)?;
    }
    let _lease = structural::try_lease(root)?;
    execute(
        root,
        grant,
        request,
        None,
        &SelfWriteTracker::default(),
        |_| {},
    )
    .map(|result| result.output)
}

/// The caller holds either a closed-vault lease or the active desktop mutation gate. The
/// desktop passes its index connection; without one, property edits use a private in-memory
/// catalog of the vault, which the desktop rebuilds from the files when it opens the vault.
pub fn execute(
    root: &Path,
    grant: &str,
    request: &Mutation,
    index: Option<&rusqlite::Connection>,
    watcher: &SelfWriteTracker,
    on_move: impl FnOnce(&[PathChange]),
) -> Result<Published, &'static str> {
    let scope = visible_folder(root, grant).map_err(|_| "accessDenied")?;
    let Some(operation) = request.structural() else {
        let _text = crate::paths::lock_text_write(root).map_err(|_| "unavailable")?;
        if let Some(module) = request.required_module() {
            modules::Modules::require(root, module)?;
        }
        structural::ensure_clean_for_text_edit(root)?;
        if let Mutation::DeleteDatabaseRow {
            database_id,
            note_id,
        } = request
        {
            let path = database::row_path(root, &scope, database_id, note_id)?;
            return delete::execute(
                root,
                &scope,
                watcher,
                &crate::system_recycle_bin::OsTrash,
                &path,
            );
        }
        if let Mutation::Delete { path } = request {
            return delete::execute(
                root,
                &scope,
                watcher,
                &crate::system_recycle_bin::OsTrash,
                path,
            );
        }
        if request.is_property() {
            let memory;
            let conn = match index {
                Some(conn) => conn,
                None => {
                    memory =
                        crate::index::read_only::disk_catalog(root).map_err(|_| "unavailable")?;
                    // Finish or roll back a property edit an interrupted CLI left behind.
                    crate::property_groups::recover_operations(&memory, root)
                        .map_err(|_| "recoveryRequired")?;
                    &memory
                }
            };
            return match request {
                Mutation::SetProperty(request) => properties::set(conn, root, &scope, request),
                Mutation::SetPropertyAppearance(request) => {
                    properties::appearance(conn, root, &scope, request)
                }
                Mutation::RenameProperty {
                    path,
                    name,
                    new_name,
                } => properties::rename(conn, root, &scope, path, name, new_name),
                Mutation::DeleteProperty { path, name } => {
                    properties::delete(conn, root, &scope, path, name)
                }
                Mutation::ReorderProperties { path, names } => {
                    properties::reorder(conn, root, &scope, path, names)
                }
                _ => Err("invalidArguments"),
            };
        }
        let env = crate::project::create::Env {
            vault: root,
            watcher,
        };
        return match request {
            Mutation::CreateDatabase { parent, name } => {
                database::create(root, &scope, watcher, parent, name)
            }
            Mutation::CreateDatabaseRow { database_id, title } => {
                database::create_row(root, &scope, watcher, database_id, title)
            }
            Mutation::AddDatabaseProperty {
                database_id,
                name,
                property_type,
                expected_revision,
                options,
            } => database::add_property(
                root,
                &scope,
                watcher,
                &crate::database::mutations::CreateDatabasePropertyRequest {
                    database_id: database_id.clone(),
                    expected_manifest_revision: expected_revision.clone(),
                    property_type: property_type.clone(),
                    name: name.clone(),
                    options: options.clone(),
                    ..Default::default()
                },
            ),
            Mutation::RenameDatabase {
                database_id,
                name,
                expected_revision,
            } => database::rename(
                root,
                &scope,
                watcher,
                &crate::database::mutations::RenameDatabaseRequest {
                    expected_generation: 0,
                    database_id: database_id.clone(),
                    name: name.clone(),
                    expected_manifest_revision: expected_revision.clone(),
                },
            ),
            Mutation::RenameDatabaseProperty {
                database_id,
                property_id,
                name,
                expected_revision,
            } => database::rename_property(
                root,
                &scope,
                watcher,
                &crate::database::mutations::RenameDatabasePropertyRequest {
                    expected_generation: 0,
                    database_id: database_id.clone(),
                    property_id: property_id.clone(),
                    name: name.clone(),
                    expected_manifest_revision: expected_revision.clone(),
                },
            ),
            Mutation::UpdateWorkshop(request) => workshop::update(&env, &scope, request),
            Mutation::CreateTextPage(request) => workshop::create_text_page(&env, &scope, request),
            Mutation::SetDatabaseValue(value) => database::set_value(root, &scope, watcher, value),
            Mutation::CreateDatabaseRelation(request) => {
                database::create_relation(root, &scope, watcher, request)
            }
            Mutation::SetDatabaseRelation(request) => {
                database::set_relation(root, &scope, watcher, request, false)
            }
            Mutation::CreateWorkshop {
                parent,
                name,
                operation_id,
            } => workshop::create(&env, &scope, parent, name, operation_id),
            Mutation::CreateStory {
                workshop_id,
                title,
                operation_id,
            } => workshop::story(&env, &scope, workshop_id, title, operation_id),
            Mutation::CreateWorkshopSection {
                workshop_id,
                name,
                expected_revision,
                operation_id,
            } => workshop::section(
                &env,
                &scope,
                workshop_id,
                name,
                expected_revision,
                operation_id,
            ),
            _ => Err("invalidArguments"),
        };
    };
    let outcome = structural::execute_granted(root, operation, &scope, false, on_move)?;
    let mut changed = outcome
        .rewritten_paths
        .iter()
        .map(|path| root.join(path))
        .collect::<Vec<_>>();
    if outcome.source != outcome.destination
        || matches!(
            operation,
            Operation::Archive { .. } | Operation::Restore { .. }
        )
    {
        if !matches!(operation, Operation::Restore { .. }) {
            changed.push(root.join(&outcome.source));
        }
        if !matches!(operation, Operation::Archive { .. }) {
            changed.push(root.join(&outcome.destination));
        }
    }
    Ok(Published {
        output: structural_output(&outcome),
        changed,
        archive_changed: matches!(
            operation,
            Operation::Archive { .. } | Operation::Restore { .. }
        ),
        properties_changed: false,
    })
}

pub fn preview(root: &Path, grant: &str, request: &Mutation) -> Result<Value, &'static str> {
    let scope = visible_folder(root, grant).map_err(|_| "accessDenied")?;
    if let Mutation::Delete { path } = request {
        return delete::preview(root, &scope, path);
    }
    if let Mutation::DeleteDatabaseRow {
        database_id,
        note_id,
    } = request
    {
        modules::Modules::require(root, modules::Module::Databases)?;
        let path = database::row_path(root, &scope, database_id, note_id)?;
        return delete::preview(root, &scope, &path);
    }
    if let Mutation::SetDatabaseRelation(request) = request {
        modules::Modules::require(root, modules::Module::Databases)?;
        structural::ensure_clean_for_text_edit(root)?;
        return database::set_relation(root, &scope, &SelfWriteTracker::default(), request, true)
            .map(|preview| preview.output);
    }
    let operation = request.structural().ok_or("invalidArguments")?;
    let outcome = structural::execute_granted(root, operation, &scope, true, |_| {})?;
    Ok(structural_output(&outcome))
}

fn structural_output(outcome: &structural::Outcome) -> Value {
    let mut affected = vec![outcome.source.as_str(), outcome.destination.as_str()];
    affected.extend(outcome.rewritten_paths.iter().map(String::as_str));
    affected.sort_unstable();
    affected.dedup();
    let mut result = json!(outcome);
    result["affectedPaths"] = json!(affected);
    result
}
