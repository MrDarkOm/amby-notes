//! Creative projects: discovery by `amby-project.json`, one-operation creation
//! of projects and sections, and their recovery. The contract is
//! `docs/creative-format.md`; the map is [MAP.md](MAP.md).

pub mod complete;
pub mod create;
pub mod discovery;
pub mod events;
pub mod format;
pub mod index;
mod journal;
pub mod links;
pub mod model;
pub mod names;
pub mod notebooks;
mod presets;
mod props;
pub mod recovery;
pub mod references;
pub mod settings;
pub mod text;
mod text_schema;
pub mod text_stats;

#[cfg(test)]
#[path = "contract_test.rs"]
mod contract_test;
#[cfg(test)]
#[path = "create_test.rs"]
mod create_test;
#[cfg(test)]
#[path = "create_test_support.rs"]
mod create_test_support;
#[cfg(test)]
#[path = "discovery_test.rs"]
mod discovery_test;
#[cfg(test)]
#[path = "init_test.rs"]
mod init_test;
#[cfg(test)]
#[path = "links_test.rs"]
mod links_test;
#[cfg(test)]
#[path = "plot_links_test.rs"]
mod plot_links_test;
#[cfg(test)]
#[path = "preset_test.rs"]
mod preset_test;
#[cfg(test)]
#[path = "text_test.rs"]
mod text_test;

/// MCP can inspect completed operations but leaves interrupted work to activation recovery.
pub(crate) fn require_completed_or_new(
    vault: &std::path::Path,
    operation_id: &str,
) -> Result<(), model::ProjectError> {
    for directory in [
        journal::journal_dir(vault),
        journal::legacy_journal_dir(vault),
    ] {
        let path = directory.join(format!("{operation_id}.json"));
        let rel = crate::durable::relative_string(vault, &path, "workshop tool")
            .map_err(|error| model::ProjectError::failed("invalidPath", error))?;
        crate::durable::guarded_path(vault, &rel, "workshop tool")
            .map_err(|error| model::ProjectError::failed("invalidPath", error))?;
    }
    if journal::read_journal(vault, operation_id)?
        .is_some_and(|entry| entry.status != journal::STATUS_COMPLETED)
    {
        return Err(model::ProjectError::RecoveryRequired {
            operation_id: operation_id.into(),
            message: "An interrupted workshop operation requires recovery".into(),
        });
    }
    Ok(())
}
