//! The connection record: a small file in the app data, never a secret (Р5).

use std::fs;

use super::connection::{ConnectionRecord, ConnectionStore, FileConnectionStore, CONNECTION_FILE};

fn record() -> ConnectionRecord {
    ConnectionRecord {
        server_url: "https://sync.example.com".into(),
        allow_http: false,
        username: "alice".into(),
        device_id: "00112233445566778899aabbccddeeff".into(),
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "amby-sync-connection-{name}-{}",
        ulid::Ulid::generate()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_record_is_written_and_read_back() {
    let dir = temp_dir("roundtrip");
    let store = FileConnectionStore::new(dir.join(CONNECTION_FILE));
    assert_eq!(store.load().unwrap(), None);
    store.save(&record()).unwrap();
    assert_eq!(store.load().unwrap(), Some(record()));
    // a new store over the same file is the application after a restart
    assert_eq!(
        FileConnectionStore::new(dir.join(CONNECTION_FILE))
            .load()
            .unwrap(),
        Some(record())
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_file_holds_the_address_and_the_name_only() {
    // Р5: not a password, not a key, not a token; exactly these four fields
    let dir = temp_dir("fields");
    let store = FileConnectionStore::new(dir.join(CONNECTION_FILE));
    store.save(&record()).unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(store.path()).unwrap()).unwrap();
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["allowHttp", "deviceId", "serverUrl", "username"]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn the_directory_is_created_and_no_temporary_file_is_left() {
    // the atomic write of the application
    let dir = temp_dir("atomic");
    let store = FileConnectionStore::new(dir.join("nested").join(CONNECTION_FILE));
    store.save(&record()).unwrap();
    store
        .save(&ConnectionRecord {
            username: "bob".into(),
            ..record()
        })
        .unwrap();
    assert_eq!(store.load().unwrap().unwrap().username, "bob");
    let names: Vec<String> = fs::read_dir(dir.join("nested"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![CONNECTION_FILE.to_string()]);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_damaged_file_counts_as_no_record() {
    // the person signs in again; nothing crashes
    let dir = temp_dir("damaged");
    let path = dir.join(CONNECTION_FILE);
    for garbage in ["", "not json", "{\"serverUrl\": 5}", "[]", "{}"] {
        fs::write(&path, garbage).unwrap();
        assert_eq!(
            FileConnectionStore::new(path.clone()).load().unwrap(),
            None,
            "{garbage:?}"
        );
    }
    // and a new record replaces the damaged file
    let store = FileConnectionStore::new(path);
    store.save(&record()).unwrap();
    assert_eq!(store.load().unwrap(), Some(record()));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn clearing_removes_the_file_and_a_missing_file_is_fine() {
    let dir = temp_dir("clear");
    let store = FileConnectionStore::new(dir.join(CONNECTION_FILE));
    store.clear().unwrap();
    store.save(&record()).unwrap();
    store.clear().unwrap();
    assert!(!store.path().exists());
    assert_eq!(store.load().unwrap(), None);
    let _ = fs::remove_dir_all(dir);
}
