//! Creative projects: discovery by `amby-project.json`, one-operation creation
//! of projects and sections, and their recovery. The contract is
//! `docs/creative-format.md`; the map is [MAP.md](MAP.md).

pub mod create;
pub mod discovery;
pub mod events;
pub mod format;
pub mod index;
pub mod journal;
pub mod model;
pub mod names;
pub mod presets;
pub mod props;
pub mod recovery;
pub mod references;
pub mod text;
pub mod text_schema;

#[cfg(test)]
#[path = "create_test.rs"]
mod create_test;
#[cfg(test)]
#[path = "discovery_test.rs"]
mod discovery_test;
#[cfg(test)]
#[path = "preset_test.rs"]
mod preset_test;
#[cfg(test)]
#[path = "text_test.rs"]
mod text_test;
