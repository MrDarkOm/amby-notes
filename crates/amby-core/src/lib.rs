//! Vault services shared by Amby Notes and headless callers.

pub mod ai_tools;
pub mod archive;
pub mod archive_migration;
pub mod atomic_fs;
pub mod bundle;
pub mod database;
pub mod frontmatter;
pub mod history;
pub mod index;
pub mod lock_util;
pub mod model;
pub mod paths;
pub mod project;
pub mod property_groups;
pub mod property_store;
pub mod property_template;
pub mod recovery;
pub mod recycle_bin;
pub mod self_write;
pub mod storage_error;
pub mod system_recycle_bin;
pub mod vault;
pub mod vault_context;
pub mod vault_index;

pub mod durable;
