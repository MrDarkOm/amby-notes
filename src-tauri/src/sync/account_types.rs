//! What crosses the IPC border for "the storages of the account" (docs/sync-plan.md, appendix Е,
//! У1–У5): the plan, the limits, the usage and the spaces with their sizes. The names are already
//! decrypted here; the interface never sees a key. Sizes are bytes: the interface shows them in
//! decimal units like Finder (У2).

use serde::{Deserialize, Serialize};

/// The plan of the user. `None` in [`AccountOverview::plan`] means "no plan" (an own server
/// without plans, or a server that does not know the account request).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    /// The key of the plan.
    pub name: String,
    /// The label for people, if the plan has one.
    pub title: Option<String>,
    /// The administrator pinned the user to this plan.
    pub pinned: bool,
}

/// The limits in force; `None` is "no limit".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LimitsView {
    /// The most spaces.
    pub max_spaces: Option<u32>,
    /// The quota of sealed bytes in all spaces.
    pub max_total_bytes: Option<u64>,
    /// The largest file after sealing.
    pub max_file_bytes: Option<u64>,
    /// Days that replaced and deleted versions are kept.
    pub history_days: Option<u32>,
    /// The ceiling of the history in bytes ("history 30 days, up to 1 GB").
    pub max_history_bytes: Option<u64>,
}

/// What the account holds, in sealed bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageView {
    /// The latest versions of the files.
    pub live_bytes: u64,
    /// Started uploads no version refers to yet.
    pub pending_bytes: u64,
    /// Replaced and deleted versions; not in the quota.
    pub history_bytes: u64,
    /// How many spaces.
    pub spaces: u32,
}

/// One storage (space) of the account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    /// The identifier (hex, 32 characters).
    pub space_id: String,
    /// The name; `None` when it cannot be read with this account key.
    pub name: Option<String>,
    /// The latest versions, in sealed bytes.
    pub live_bytes: u64,
    /// The history, in sealed bytes.
    pub history_bytes: u64,
    /// The space of the vault that is open now.
    pub this_vault: bool,
    /// The name of the folder of a vault of this computer that is linked to this space (never the
    /// path); `None` when no known vault is.
    pub bound_folder: Option<String>,
}

/// The answer of `sync_account_overview` (У5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountOverview {
    /// The server told about the account (`false`: an older server; the interface then shows
    /// "no limits" and nothing about the plan, Р13).
    pub limits_known: bool,
    /// The plan, if the server has plans.
    pub plan: Option<PlanView>,
    /// The limits in force.
    pub limits: LimitsView,
    /// What is held.
    pub usage: UsageView,
    /// The storages of the account, in the order of the server.
    pub spaces: Vec<StorageView>,
}

/// A vault of this computer that is linked to a space, as the application knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundVault {
    /// The name of its folder.
    pub folder: String,
    /// The space it is linked to.
    pub space_id: [u8; 16],
}
