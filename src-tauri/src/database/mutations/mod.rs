//! Database creation and durable, conflict-aware metadata/schema/value mutations.
//!
//! The public surface is flat (`database::mutations::*`); the modules only group the
//! mutations by kind.

mod create;
mod durable_values;
mod property_config;
mod property_create;
mod property_edit;
mod property_options;
mod property_type;
mod relation_schema;
mod relation_value;
mod relation_write;
mod support;
mod types;
mod value_batch;

pub(crate) use super::value_batch_recovery::recover_pending_batches;
pub use create::*;
use durable_values::*;
pub use property_config::*;
pub use property_create::*;
pub use property_edit::*;
pub use property_options::*;
pub use property_type::*;
use relation_schema::*;
pub use relation_value::*;
pub(in crate::database) use relation_write::*;
pub use support::*;
pub use types::*;
pub use value_batch::*;

#[cfg(test)]
mod tests;
