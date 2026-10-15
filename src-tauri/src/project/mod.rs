//! Creative projects: discovery by `amby-project.json`, one-operation creation
//! of projects and sections, and their recovery. The contract is
//! `docs/creative-format.md`; the map is [MAP.md](MAP.md).

pub mod complete;
pub mod create;
pub mod discovery;
pub mod events;
pub mod format;
pub mod index;
pub mod journal;
pub mod links;
pub mod model;
pub mod names;
pub mod notebooks;
pub mod presets;
pub mod props;
pub mod recovery;
pub mod references;
pub mod settings;
pub mod text;
pub mod text_schema;
pub mod text_stats;

#[cfg(test)]
#[path = "contract_test.rs"]
mod contract_test;
#[cfg(test)]
#[path = "create_test.rs"]
mod create_test;
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
