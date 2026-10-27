//! Native update-channel policy. Installer signatures remain owned by Tauri.
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

fn is_beta(version: &Version) -> bool {
    version
        .pre
        .as_str()
        .strip_prefix("beta.")
        .is_some_and(|n| n.parse::<u64>().is_ok_and(|n| n > 0))
}

pub(crate) fn installed_version(base: &str, tag: Option<&str>) -> Result<Version, String> {
    let base = Version::parse(base).map_err(|_| "invalid_release_identity")?;
    let Some(tag) = tag else {
        return Ok(base);
    };
    let release = tag
        .strip_prefix('v')
        .and_then(|tag| Version::parse(tag).ok())
        .ok_or("invalid_release_identity")?;
    if (release.major, release.minor, release.patch) != (base.major, base.minor, base.patch)
        || !release.build.is_empty()
        || (!release.pre.is_empty() && !is_beta(&release))
    {
        return Err("invalid_release_identity".into());
    }
    Ok(release)
}

pub(crate) fn allowed_update(current: &Version, remote: &Version, channel: UpdateChannel) -> bool {
    remote > current
        && remote.build.is_empty()
        && (remote.pre.is_empty() || (channel == UpdateChannel::Beta && is_beta(remote)))
}

pub(crate) fn endpoints(channel: UpdateChannel) -> Vec<url::Url> {
    let mut urls = Vec::new();
    if channel == UpdateChannel::Beta {
        urls.push("https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/beta.json");
    }
    urls.extend([
        "https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/stable.json",
        "https://github.com/MrDarkOm/amby-notes/releases/latest/download/latest.json",
    ]);
    urls.into_iter()
        .map(|url| url.parse().expect("fixed HTTPS updater URL"))
        .collect()
}

pub(crate) fn is_update_window(label: &str) -> bool {
    matches!(label, "main" | "settings")
}

fn current_release() -> Result<Version, String> {
    installed_version(env!("CARGO_PKG_VERSION"), option_env!("AMBY_RELEASE_TAG"))
}

/// Public identity of this build, including the beta number embedded at release build time.
#[tauri::command]
#[specta::specta]
pub fn app_release_version() -> Result<String, String> {
    current_release().map(|version| version.to_string())
}

/// Webview-owned Tauri updater resource; signed download details stay on the native side.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    rid: u32,
    current_version: String,
    version: String,
    body: Option<String>,
}

/// Check one fixed channel. Arbitrary URLs and downgrade flags are not accepted.
#[tauri::command]
#[specta::specta]
pub async fn check_app_update(
    webview: tauri::Webview,
    channel: UpdateChannel,
    timeout_ms: u64,
) -> Result<Option<AppUpdateInfo>, String> {
    if !is_update_window(webview.label()) {
        return Err("unsupported_window".into());
    }
    let budget = Duration::from_millis(timeout_ms.clamp(100, 30_000));
    let installed = current_release()?;
    let current_version = installed.to_string();
    let request = async {
        let updater = webview
            .updater_builder()
            .endpoints(endpoints(channel))
            .map_err(|_| "update_check_failed")?
            .timeout(budget)
            .version_comparator(move |_, remote| {
                allowed_update(&installed, &remote.version, channel)
            })
            .build()
            .map_err(|_| "update_check_failed")?;
        let update = updater.check().await.map_err(|_| "update_check_failed")?;
        Ok(update.map(|update| AppUpdateInfo {
            current_version,
            version: update.version.clone(),
            body: update.body.clone(),
            rid: webview.resources_table().add(update),
        }))
    };
    tokio::time::timeout(budget, request)
        .await
        .map_err(|_| "update_check_failed".to_string())?
}

#[cfg(test)]
mod tests;
