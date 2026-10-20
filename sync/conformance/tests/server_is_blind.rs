//! The server is blind (О1, О2, Р1, Р5, Р6): after a run with known paths, contents, device and
//! vault names, passwords and keys, none of them is in the database or in the bodies on disk.
//! Only the user name may be there (О2). In-process servers only: the test reads the data
//! directory.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use amby_sync_conformance::client::{enroll, login, new_item, pattern, Account, Space};
use amby_sync_conformance::{in_process_or_skip, Target};

const PATH_ONE: &str = "Secret Plans/Quarterly-Report-ZEBRA.md";
const CONTENT_ONE: &str = "TOP-SECRET-PAYLOAD-QUASAR line one\r\n";
const PATH_TWO: &str = "Люди/Иван Петров — контракт.md";
const CONTENT_TWO: &str = "договор-секретный-МАРС";
const SECOND_VERSION: &str = "SECOND-VERSION-MARKER-ORION";
const DEVICE_NAME: &str = "Alices-Private-Laptop-NEBULA";
const VAULT_NAME: &str = "VAULT-NAME-PHOENIX";
const LONG_PASSWORD: &str = "blind-test-password-GLACIER-47";

fn base64(bytes: &[u8], url: bool, pad: bool) -> String {
    let alphabet: &[u8; 64] = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(alphabet[((n >> (18 - 6 * i)) & 63) as usize]));
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

/// One thing that must not be on the server's disk, in every form it could be written in.
struct Secret {
    label: String,
    forms: Vec<Vec<u8>>,
}

fn secret(label: &str, bytes: &[u8]) -> Secret {
    let hex = hex::encode(bytes);
    let mut forms = vec![
        bytes.to_vec(),
        hex.clone().into_bytes(),
        hex.to_uppercase().into_bytes(),
    ];
    for (url, pad) in [(false, true), (false, false), (true, false)] {
        forms.push(base64(bytes, url, pad).into_bytes());
    }
    // UTF-16 is how some databases store text; look for it too.
    if let Ok(text) = std::str::from_utf8(bytes) {
        forms.push(text.encode_utf16().flat_map(u16::to_le_bytes).collect());
    }
    Secret {
        label: label.to_string(),
        forms,
    }
}

fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("cannot read the data directory") {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files_under(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.len() >= needle.len()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Checks every file under `dir` for every form of every secret.
fn assert_none_on_disk(dir: &Path, secrets: &[Secret]) {
    let mut files = Vec::new();
    files_under(dir, &mut files);
    for file in &files {
        let bytes = std::fs::read(file).unwrap();
        for secret in secrets {
            for form in &secret.forms {
                assert!(
                    !contains(&bytes, form),
                    "{} is on the server's disk in {} (as {:?})",
                    secret.label,
                    file.display(),
                    String::from_utf8_lossy(&form[..form.len().min(40)])
                );
            }
        }
    }
}

/// Sanity: the scan really reads the database (the user name is allowed there, О2), the bodies
/// are on disk under `blobs/` (Р11), and there is enough data for the scan to mean something.
fn assert_the_scan_sees_the_server(dir: &Path, username: &str, sealed_bytes: usize) {
    let mut files = Vec::new();
    files_under(dir, &mut files);
    assert!(
        !files.is_empty(),
        "the data directory is empty: the scenario did not reach the disk"
    );
    let total: u64 = files
        .iter()
        .map(|f| std::fs::metadata(f).unwrap().len())
        .sum();
    assert!(
        total as usize >= sealed_bytes,
        "the bodies are not on disk: {total} bytes in all"
    );
    assert!(
        files.iter().any(|f| f.starts_with(dir.join("blobs"))),
        "bodies go under blobs/ (Р11): {files:?}"
    );
    assert!(
        files.iter().any(|f| contains(&std::fs::read(f).unwrap(), username.as_bytes())),
        "the user name may be stored (О2) and must be found; otherwise the scan reads the wrong files"
    );
}

struct Scenario {
    account: Account,
    second_device: Account,
    space: Space,
    sealed_bytes: usize,
}

fn run_scenario(target: &Target) -> Scenario {
    let account = enroll(target, LONG_PASSWORD);
    let second_device = {
        let answer = login(
            &target.api,
            &account.username,
            LONG_PASSWORD,
            &account.ak,
            DEVICE_NAME,
        )
        .expect(200);
        let body = answer.json();
        Account {
            token: body["token"].as_str().unwrap().to_string(),
            device_id: body["device_id"].as_str().unwrap().to_string(),
            api: account.api.clone(),
            username: account.username.clone(),
            password: account.password.clone(),
            ak: account.ak.clone(),
            recovery_code: account.recovery_code.clone(),
            recovery_auth_key: account.recovery_auth_key.clone(),
            salt: account.salt,
            params: account.params,
        }
    };
    let space = account.create_space_named(VAULT_NAME);
    let big: Vec<u8> = CONTENT_ONE.bytes().chain(pattern(300_000)).collect();
    let (one, two, folder) = (new_item(), new_item(), new_item());
    space.commit_ok(&[
        space.folder(&folder, 0, "Secret Plans"),
        space.file(&one, 0, PATH_ONE, &big),
        space.file(&two, 0, PATH_TWO, CONTENT_TWO.as_bytes()),
    ]);
    space.commit_ok(&[space.file(&two, 1, PATH_TWO, SECOND_VERSION.as_bytes())]);
    space.commit_ok(&[space.deletion(&one, 1, PATH_ONE)]);
    // Reads go through the server as well.
    let _ = space.versions(&two).expect(200);
    let _ = space.all_changes(0);
    let _ = second_device.get("/v1/devices").expect(200);
    Scenario {
        account,
        second_device,
        space,
        sealed_bytes: big.len() + CONTENT_TWO.len(),
    }
}

#[test]
fn no_path_content_or_name_is_on_the_servers_disk() {
    // О1, О2, Р1, Р2, Р6: paths, contents (both versions), the device name and the vault name are
    // in neither the database nor the bodies; the user name may be (О2).
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let scenario = run_scenario(&target);
    let secrets = vec![
        secret("file path", PATH_ONE.as_bytes()),
        secret("file name", b"Quarterly-Report-ZEBRA.md"),
        secret("folder name", b"Secret Plans"),
        secret("second path", PATH_TWO.as_bytes()),
        secret("second file name", "Иван Петров — контракт.md".as_bytes()),
        secret("content marker", b"TOP-SECRET-PAYLOAD-QUASAR"),
        secret("content", CONTENT_ONE.as_bytes()),
        secret("second content", CONTENT_TWO.as_bytes()),
        secret("second version", SECOND_VERSION.as_bytes()),
        secret("device name", DEVICE_NAME.as_bytes()),
        secret("vault name", VAULT_NAME.as_bytes()),
        secret("pattern content", &pattern(300_000)[1000..1400]),
    ];
    assert_the_scan_sees_the_server(
        control.data_dir(),
        &scenario.account.username,
        scenario.sealed_bytes,
    );
    assert_none_on_disk(control.data_dir(), &secrets);
    // Once more after a restart, when the database has been closed and reopened.
    control.restart();
    assert_none_on_disk(control.data_dir(), &secrets);
}

#[test]
fn no_password_key_or_token_is_on_the_servers_disk() {
    // О1, Р5, Ф5: the password, the recovery code, AK, VK, the auth keys and the tokens never
    // reach the disk; the server keeps only hashes of what it must compare.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let scenario = run_scenario(&target);
    let account = &scenario.account;
    let mut secrets = vec![
        secret("password", LONG_PASSWORD.as_bytes()),
        secret(
            "recovery code (shown)",
            account.recovery_code.to_display().as_bytes(),
        ),
        secret(
            "recovery code (without dashes)",
            account
                .recovery_code
                .to_display()
                .replace('-', "")
                .as_bytes(),
        ),
        secret("recovery code bytes", account.recovery_code.as_bytes()),
        secret("account key", account.ak.as_bytes()),
        secret("space key", scenario.space.vk.as_bytes()),
        secret("recovery auth key", account.recovery_auth_key.as_bytes()),
        secret("password auth key", account.password_auth_key().as_bytes()),
        secret("token of the first device", account.token.as_bytes()),
        secret(
            "token of the second device",
            scenario.second_device.token.as_bytes(),
        ),
    ];
    for token in [&account.token, &scenario.second_device.token] {
        secrets.push(secret("token bytes", &hex::decode(token).unwrap()));
    }
    assert_the_scan_sees_the_server(control.data_dir(), &account.username, scenario.sealed_bytes);
    assert_none_on_disk(control.data_dir(), &secrets);
    control.restart();
    assert_none_on_disk(control.data_dir(), &secrets);
}

#[test]
fn the_enrolment_code_is_not_on_the_disk_either() {
    // П17, П39: only a hash of the one-time code is stored.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let ticket = target.new_ticket();
    let normalised = ticket.enroll_code.replace('-', "");
    let secrets = vec![
        secret("enrolment code", ticket.enroll_code.as_bytes()),
        secret("enrolment code without dashes", normalised.as_bytes()),
        secret(
            "enrolment code in lower case",
            normalised.to_lowercase().as_bytes(),
        ),
    ];
    let mut files = Vec::new();
    files_under(control.data_dir(), &mut files);
    assert!(!files.is_empty(), "the user was not written to disk");
    assert_none_on_disk(control.data_dir(), &secrets);
}
