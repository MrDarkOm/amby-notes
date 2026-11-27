use super::{allowed_update, endpoints, installed_version, is_update_window, UpdateChannel};
use semver::Version;

fn v(value: &str) -> Version {
    Version::parse(value).unwrap()
}

#[test]
fn tagged_beta_identity_is_distinct_while_the_installer_base_stays_numeric() {
    assert_eq!(
        installed_version("0.1.9", Some("v0.1.9-beta.2")).unwrap(),
        v("0.1.9-beta.2")
    );
    assert_eq!(
        installed_version("0.1.9", Some("v0.1.9")).unwrap(),
        v("0.1.9")
    );
    assert_eq!(installed_version("0.1.9", None).unwrap(), v("0.1.9"));
    for tag in [
        "v0.1.10-beta.2",
        "v0.1.9-nightly.1",
        "0.1.9-beta.2",
        "v0.1.9-beta.02",
        "v0.1.9+other",
    ] {
        assert!(installed_version("0.1.9", Some(tag)).is_err(), "{tag}");
    }
}

#[test]
fn beta_channel_moves_between_beta_builds_and_then_to_the_final_release() {
    assert!(allowed_update(
        &v("0.1.9-beta.2"),
        &v("0.1.9-beta.10"),
        UpdateChannel::Beta
    ));
    assert!(allowed_update(
        &v("0.1.9-beta.10"),
        &v("0.1.9"),
        UpdateChannel::Beta
    ));
    assert!(allowed_update(
        &v("0.1.9"),
        &v("0.1.10-beta.1"),
        UpdateChannel::Beta
    ));
}

#[test]
fn stable_channel_ignores_previews_and_waits_for_a_suitable_final_release() {
    assert!(!allowed_update(
        &v("0.1.8"),
        &v("0.1.9-beta.2"),
        UpdateChannel::Stable
    ));
    assert!(!allowed_update(
        &v("0.1.9-beta.2"),
        &v("0.1.8"),
        UpdateChannel::Stable
    ));
    assert!(allowed_update(
        &v("0.1.9-beta.2"),
        &v("0.1.9"),
        UpdateChannel::Stable
    ));
    assert!(allowed_update(
        &v("0.1.8"),
        &v("0.1.9"),
        UpdateChannel::Stable
    ));
}

#[test]
fn neither_channel_reinstalls_or_downgrades_or_accepts_unknown_preview_types() {
    for channel in [UpdateChannel::Stable, UpdateChannel::Beta] {
        for (current, remote) in [
            ("0.1.9-beta.2", "0.1.9-beta.2"),
            ("0.1.9-beta.10", "0.1.9-beta.2"),
            ("0.1.9", "0.1.9-beta.99"),
            ("0.1.9", "0.1.8"),
            ("0.1.9", "0.1.10-nightly.1"),
            ("0.1.9", "0.1.10+unrecognised"),
        ] {
            assert!(
                !allowed_update(&v(current), &v(remote), channel),
                "{channel:?}: {current} -> {remote}"
            );
        }
    }
}

#[test]
fn channels_use_only_fixed_https_sources_and_keep_the_stable_fallback() {
    let stable: Vec<String> = endpoints(UpdateChannel::Stable)
        .into_iter()
        .map(Into::into)
        .collect();
    let beta: Vec<String> = endpoints(UpdateChannel::Beta)
        .into_iter()
        .map(Into::into)
        .collect();
    assert_eq!(
        stable,
        [
            "https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/stable.json",
            "https://github.com/MrDarkOm/amby-notes/releases/latest/download/latest.json",
        ]
    );
    assert_eq!(
        beta[0],
        "https://raw.githubusercontent.com/MrDarkOm/amby-notes/update-feed/beta.json"
    );
    assert_eq!(&beta[1..], stable.as_slice());
}

#[test]
fn only_main_and_settings_windows_can_request_an_installable_update() {
    assert!(is_update_window("main"));
    assert!(is_update_window("settings"));
    for label in ["note-1", "native-contract", "settings-other", ""] {
        assert!(!is_update_window(label));
    }
}
