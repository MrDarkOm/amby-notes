pub mod connection;
pub mod identity;
pub mod links;
pub mod note_index;
pub mod query;
pub mod read_only;
pub mod refactor;
pub mod schema;
pub mod snapshot;
pub mod sync;
pub(crate) use sync::load_vault_with_policy;
pub mod sync_paths;
pub mod tags;

pub use connection::*;
pub use identity::*;
pub use links::*;
pub use note_index::*;
pub use query::*;
pub use refactor::*;
pub use schema::*;
pub use sync::*;
pub use sync_paths::*;
pub use tags::*;

#[cfg(test)]
mod compatibility_fixtures_test;

#[cfg(test)]
mod history_follow_tests;

#[cfg(test)]
mod identity_tests;

#[cfg(test)]
mod refactor_scope_tests;

#[cfg(test)]
mod line_ending_tests;

#[cfg(test)]
mod malformed_tests;

#[cfg(test)]
mod read_reason_tests;

#[cfg(test)]
mod unreadable_tests;
