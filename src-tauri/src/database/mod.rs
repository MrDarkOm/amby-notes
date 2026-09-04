// DB-03 is a pure format boundary; DB-04+ will consume these APIs from
// discovery/projection, so keeping them unused here is intentional.
pub mod assets;
pub mod discovery;
pub mod events;
#[allow(dead_code)]
pub mod format;
pub mod model;
pub mod mutation_state;
pub mod mutations;
pub mod projection;
pub mod query;
pub mod rows;
pub mod runtime_state;
#[allow(dead_code)]
pub mod validation;
pub mod yaml_sync;
