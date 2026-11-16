use super::*;
use std::fs;

fn temp(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("amby-grants-{label}-{}", ulid::Ulid::generate()));
    fs::create_dir_all(&root).unwrap();
    root.canonicalize().unwrap()
}

fn json_path(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).unwrap()
}

#[test]
fn an_arbitrary_folder_or_file_is_not_granted() {
    let home = temp("home");
    fs::create_dir_all(home.join(".ssh")).unwrap();
    fs::write(home.join(".ssh/id_ed25519"), "secret").unwrap();
    let grants = PathGrants::default();
    assert!(!grants.folder_granted(&home));
    assert!(!grants.source_granted(&home.join(".ssh/id_ed25519")));
}

#[test]
fn what_the_dialog_gave_out_is_granted_and_nothing_next_to_it() {
    let home = temp("dialog");
    let picked = home.join("Notes");
    fs::create_dir_all(&picked).unwrap();
    let grants = PathGrants::default();
    grants.grant_folder(&picked);
    assert!(grants.folder_granted(&picked));
    // The parent and a folder inside are different paths.
    assert!(!grants.folder_granted(&home));
    assert!(!grants.folder_granted(&picked.join("inner")));
    // A path that only looks the same after resolving `..` is the same folder, and is granted.
    assert!(grants.folder_granted(&picked.join("..").join("Notes")));
}

#[test]
fn a_dropped_file_is_granted_as_a_source_only() {
    let home = temp("drop");
    let dropped = home.join("photo.png");
    fs::write(&dropped, "png").unwrap();
    let grants = PathGrants::default();
    grants.grant_sources([&dropped]);
    assert!(grants.source_granted(&dropped));
    assert!(!grants.source_granted(&home.join("other.png")));
    // A file the person dropped is not a vault they picked.
    assert!(!grants.folder_granted(&dropped));
}

#[test]
fn a_picked_folder_is_not_a_source() {
    let home = temp("kinds");
    let grants = PathGrants::default();
    grants.grant_folder(&home);
    assert!(!grants.source_granted(&home));
}

#[test]
fn a_grant_expires() {
    let home = temp("expire");
    let grants = PathGrants::default();
    let start = Instant::now();
    grants.grant(Kind::Source, [&home], start);
    grants.grant(Kind::Folder, [&home], start);
    assert!(grants.granted(Kind::Source, &home, start + Duration::from_secs(60)));
    assert!(!grants.granted(
        Kind::Source,
        &home,
        start + SOURCE_TTL + Duration::from_secs(1)
    ));
    assert!(grants.granted(
        Kind::Folder,
        &home,
        start + SOURCE_TTL + Duration::from_secs(1)
    ));
    assert!(!grants.granted(
        Kind::Folder,
        &home,
        start + FOLDER_TTL + Duration::from_secs(1)
    ));
}

#[test]
fn changing_the_vault_forgets_every_grant() {
    let home = temp("forget");
    let grants = PathGrants::default();
    grants.grant_folder(&home);
    grants.grant_sources([&home]);
    grants.forget_all();
    assert!(!grants.folder_granted(&home));
    assert!(!grants.source_granted(&home));
}

#[test]
fn the_number_of_grants_is_bounded() {
    let home = temp("bound");
    let grants = PathGrants::default();
    let many: Vec<PathBuf> = (0..MAX_GRANTS + 10)
        .map(|index| home.join(format!("file-{index}")))
        .collect();
    grants.grant_sources(&many);
    assert!(!grants.source_granted(&many[0]));
    assert!(grants.source_granted(many.last().unwrap()));
}

#[test]
fn the_list_of_known_vaults_names_recent_and_last_opened_folders() {
    let home = temp("registry");
    let recent = home.join("recent");
    let last = home.join("last");
    let stranger = home.join("stranger");
    for dir in [&recent, &last, &stranger] {
        fs::create_dir_all(dir).unwrap();
    }
    let registry = format!(
        r#"{{"recent":[{{"id":"a","path":{}}}],"lastOpened":{}}}"#,
        json_path(&recent),
        json_path(&last)
    );
    assert!(registry_lists(&registry, &recent));
    assert!(registry_lists(&registry, &last));
    assert!(!registry_lists(&registry, &stranger));
    assert!(!registry_lists(&registry, &home));
    assert!(!registry_lists("", &recent));
    assert!(!registry_lists("{not json", &recent));
    assert!(!registry_lists(
        r#"{"recent":[{"id":"a","path":""}]}"#,
        Path::new("")
    ));
}

#[test]
fn a_vault_path_is_trusted_when_open_picked_or_known() {
    let home = temp("trusted");
    let open = home.join("open");
    let picked = home.join("picked");
    let known = home.join("known");
    for dir in [&open, &picked, &known] {
        fs::create_dir_all(dir).unwrap();
    }
    let registry = format!(
        r#"{{"recent":[{{"id":"k","path":{}}}]}}"#,
        json_path(&known)
    );
    let grants = PathGrants::default();
    grants.grant_folder(&picked);

    assert!(vault_path_trusted(&open, Some(&open), &grants, &registry));
    assert!(vault_path_trusted(&picked, Some(&open), &grants, &registry));
    assert!(vault_path_trusted(&known, Some(&open), &grants, &registry));
    // The home folder and a folder inside it that nobody handed out.
    assert!(!vault_path_trusted(&home, Some(&open), &grants, &registry));
    assert!(!vault_path_trusted(&home, None, &grants, ""));
    assert!(!vault_path_trusted(
        &home.join(".ssh"),
        None,
        &grants,
        &registry
    ));
}

#[test]
fn after_a_switch_the_old_pick_is_not_trusted_but_the_open_vault_and_known_ones_are() {
    let home = temp("switch");
    let first = home.join("first");
    let second = home.join("second");
    for dir in [&first, &second] {
        fs::create_dir_all(dir).unwrap();
    }
    let grants = PathGrants::default();
    grants.grant_folder(&first);
    assert!(vault_path_trusted(&first, None, &grants, ""));
    // `second` becomes the open vault; the grants of the first pick are dropped.
    grants.forget_all();
    assert!(!vault_path_trusted(&first, Some(&second), &grants, ""));
    assert!(vault_path_trusted(&second, Some(&second), &grants, ""));
}
