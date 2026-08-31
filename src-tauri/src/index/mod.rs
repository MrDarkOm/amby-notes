pub mod connection;
pub mod identity;
pub mod links;
pub mod note_index;
pub mod query;
pub mod refactor;
pub mod schema;
pub mod sync;
pub mod tags;

pub use connection::*;
pub use links::*;
pub use note_index::*;
pub use query::*;
pub use refactor::*;
pub use schema::*;
pub use sync::*;
pub use tags::*;

#[cfg(test)]
mod compatibility_fixtures_test;

#[cfg(test)]
mod identity_tests;

#[cfg(test)]
mod incremental_tests;

#[cfg(test)]
mod malformed_tests;
