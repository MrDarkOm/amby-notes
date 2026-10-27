//! Native update-channel policy. Installer signatures remain owned by Tauri.

use semver::Version;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

pub(crate) fn installed_version(_base: &str, _tag: Option<&str>) -> Result<Version, String> {
    Err("invalid_release_identity".into())
}

pub(crate) fn allowed_update(
    _current: &Version,
    _remote: &Version,
    _channel: UpdateChannel,
) -> bool {
    false
}

pub(crate) fn endpoints(_channel: UpdateChannel) -> Vec<url::Url> {
    vec![]
}

pub(crate) fn is_update_window(_label: &str) -> bool {
    false
}

#[cfg(test)]
mod tests;
