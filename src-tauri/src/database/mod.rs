// DB-03 is a pure format boundary; DB-04+ will consume these APIs from
// discovery/projection, so keeping them unused here is intentional.
pub mod assets;
pub mod discovery;
pub mod events;
pub mod failure;
pub mod filter_operators;
#[allow(dead_code)]
pub mod format;
pub mod formula;
pub mod history;
pub mod layout;
pub mod model;
pub mod mutation_state;
pub mod mutations;
pub mod projection;
pub mod query;
pub mod relation_lookup;
pub mod relation_recovery;
pub mod relation_schema_recovery;
pub mod rollup;
pub mod rollup_config;
pub mod rows;
pub mod runtime_state;
#[allow(dead_code)]
pub mod validation;
pub mod value_batch_recovery;
pub mod views;
pub mod yaml_sync;

#[cfg(test)]
mod property_migration_flow_test;
