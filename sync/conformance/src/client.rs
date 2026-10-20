//! The client side of the suite. It does what a device does and uses the real cryptography of
//! `sync/core`, so that every request carries real encrypted data (О1, Р6). Everything that is
//! not cryptography is written out by hand from appendix Б, deliberately not shared with the
//! server's own types.

use std::collections::BTreeMap;

use amby_sync_core::crypto::account::{
    create_account, derive_password_keys, generate_space_key, unwrap_account_key, wrap_space_key,
    Argon2Params, NewAccount, PasswordEnvelope,
};
use amby_sync_core::crypto::body::{open_body, seal_body};
use amby_sync_core::crypto::header::{open_header, seal_header, Header, ItemKind};
use amby_sync_core::crypto::keys::{AccountKey, AuthKey, BodyId, ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::primitives::{
    blake3_hash, xchacha20poly1305_open, xchacha20poly1305_seal,
};
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::crypto::recovery_code::RecoveryCode;
use amby_sync_proto::PART_SIZE;
use serde_json::{json, Value};

use crate::http::{Api, Resp};
use crate::target::Target;

/// A password that passes any strength check of the application (Р5: 12 characters and more).
pub const PASSWORD: &str = "correct horse battery staple 42";

pub fn random16() -> [u8; 16] {
    let mut bytes = [0u8; 16];
    OsRandom.fill(&mut bytes);
    bytes
}

pub fn hex16(bytes: &[u8; 16]) -> String {
    hex::encode(bytes)
}

pub fn unhex(text: &str) -> Vec<u8> {
    hex::decode(text).unwrap_or_else(|error| panic!("not hex ({error}): {text}"))
}

pub fn params_json(params: &Argon2Params) -> Value {
    json!({
        "memory_kib": params.memory_kib,
        "iterations": params.iterations,
        "parallelism": params.parallelism,
    })
}

pub fn params_from_json(value: &Value) -> Argon2Params {
    let field = |name: &str| {
        value[name]
            .as_u64()
            .unwrap_or_else(|| panic!("params.{name} is not a number: {value}")) as u32
    };
    Argon2Params {
        memory_kib: field("memory_kib"),
        iterations: field("iterations"),
        parallelism: field("parallelism"),
    }
}

const AAD_DEVICE_NAME: &[u8] = b"amby-sync/device-name/1";

/// The name of a device encrypted with AK: `0x01 ‖ nonce ‖ ciphertext ‖ tag`. The format is not in
/// appendix А yet (open question Б.10-6); the server only keeps these bytes.
pub fn seal_device_name(ak: &AccountKey, name: &str) -> String {
    let mut nonce = [0u8; 24];
    OsRandom.fill(&mut nonce);
    let sealed = xchacha20poly1305_seal(ak.as_bytes(), &nonce, AAD_DEVICE_NAME, name.as_bytes());
    let mut out = vec![1u8];
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    hex::encode(out)
}

pub fn open_device_name(ak: &AccountKey, name_enc: &str) -> String {
    let bytes = unhex(name_enc);
    let nonce: [u8; 24] = bytes[1..25].try_into().expect("device name is too short");
    let plain = xchacha20poly1305_open(ak.as_bytes(), &nonce, AAD_DEVICE_NAME, &bytes[25..])
        .expect("the device name does not open with AK");
    String::from_utf8(plain).expect("device name is not UTF-8")
}

/// The `device` object of an enrol, login or recover request (П12).
pub fn device_json(ak: &AccountKey, name: &str) -> Value {
    json!({ "name_enc": seal_device_name(ak, name) })
}

/// A user with one connected device.
pub struct Account {
    pub api: Api,
    pub username: String,
    pub password: String,
    pub ak: AccountKey,
    pub recovery_code: RecoveryCode,
    pub recovery_auth_key: AuthKey,
    pub salt: [u8; 16],
    pub params: Argon2Params,
    pub token: String,
    pub device_id: String,
}

/// Builds the body of `POST /v1/auth/enroll` (П12).
pub fn enroll_body(
    username: &str,
    enroll_code: &str,
    new: &NewAccount,
    device_name: &str,
) -> Value {
    json!({
        "username": username,
        "enroll_code": enroll_code,
        "salt": hex::encode(new.password.salt),
        "params": params_json(&new.password.params),
        "auth_key": hex::encode(new.password.auth_key.as_bytes()),
        "wrapped_ak": hex::encode(&new.password.wrapped_account_key),
        "recovery_auth_key": hex::encode(new.recovery_auth_key.as_bytes()),
        "wrapped_ak_recovery": hex::encode(&new.wrapped_account_key_recovery),
        "device": device_json(&new.account_key, device_name),
    })
}

/// Creates a user with `user add`, derives the keys, enrols the first device and checks the
/// answer (П12, П17).
pub fn enroll(target: &Target, password: &str) -> Account {
    let ticket = target.new_ticket();
    enroll_with(target, &ticket.username, &ticket.enroll_code, password)
}

/// The same for a given name and code.
pub fn enroll_with(target: &Target, username: &str, code: &str, password: &str) -> Account {
    let new = create_account(password, &Argon2Params::V1_DEFAULT, &mut OsRandom)
        .expect("cannot create the account keys");
    let response = target
        .api
        .post(
            "/v1/auth/enroll",
            None,
            enroll_body(username, code, &new, "first device"),
        )
        .expect(201);
    let body = response.json();
    let token = body["token"]
        .as_str()
        .expect("enroll gave no token")
        .to_string();
    assert_eq!(token.len(), 64, "the token must be 32 bytes in hex (П5)");
    Account {
        api: target.api.clone(),
        username: username.to_string(),
        password: password.to_string(),
        ak: new.account_key.clone(),
        recovery_code: new.recovery_code.clone(),
        recovery_auth_key: new.recovery_auth_key.clone(),
        salt: new.password.salt,
        params: new.password.params,
        token,
        device_id: body["device_id"]
            .as_str()
            .expect("no device_id")
            .to_string(),
    }
}

impl Account {
    /// The `auth_key` of the current password (the "old password" proof of П18).
    pub fn password_auth_key(&self) -> AuthKey {
        derive_password_keys(&self.password, &self.salt, &self.params)
            .expect("cannot derive the password keys")
            .auth_key
    }

    /// Logs in again with the same password: a second device of the same user (П14).
    pub fn another_device(&self, name: &str) -> Account {
        let response = login(&self.api, &self.username, &self.password, &self.ak, name).expect(200);
        let body = response.json();
        Account {
            api: self.api.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            ak: self.ak.clone(),
            recovery_code: self.recovery_code.clone(),
            recovery_auth_key: self.recovery_auth_key.clone(),
            salt: self.salt,
            params: self.params,
            token: body["token"]
                .as_str()
                .expect("login gave no token")
                .to_string(),
            device_id: body["device_id"]
                .as_str()
                .expect("no device_id")
                .to_string(),
        }
    }

    pub fn get(&self, path: &str) -> Resp {
        self.api.get(path, Some(&self.token))
    }

    pub fn post(&self, path: &str, body: Value) -> Resp {
        self.api.post(path, Some(&self.token), body)
    }

    pub fn put(&self, path: &str, body: Value) -> Resp {
        self.api.put(path, Some(&self.token), body)
    }

    pub fn delete(&self, path: &str) -> Resp {
        self.api.delete(path, Some(&self.token))
    }

    /// Creates a space with a new VK of epoch 1 (П20, Р5).
    pub fn create_space(&self) -> Space {
        self.create_space_named("My vault")
    }

    /// The same with a chosen (encrypted) name.
    pub fn create_space_named(&self, name: &str) -> Space {
        let id = SpaceId::from_bytes(random16());
        let vk = generate_space_key(1, &mut OsRandom).expect("cannot make a space key");
        let wrapped = wrap_space_key(&self.ak, &id, &vk, &mut OsRandom);
        self.post(
            "/v1/spaces",
            json!({
                "space_id": hex16(id.as_bytes()),
                "name_enc": seal_device_name(&self.ak, name),
                "key_epoch": 1,
                "wrapped_vk": hex::encode(wrapped),
            }),
        )
        .expect(201);
        Space {
            api: self.api.clone(),
            token: self.token.clone(),
            id,
            vk,
        }
    }
}

/// `POST /v1/auth/prelogin` (П13).
pub fn prelogin(api: &Api, username: &str) -> Resp {
    api.post("/v1/auth/prelogin", None, json!({ "username": username }))
}

/// Prelogin, key derivation and `POST /v1/auth/login`, as a device does (П13, П14). The answer
/// is returned as it came, so that a wrong password can be examined (С12).
pub fn login(
    api: &Api,
    username: &str,
    password: &str,
    ak: &AccountKey,
    device_name: &str,
) -> Resp {
    let pre = prelogin(api, username).expect(200).json();
    let salt: [u8; 16] = unhex(pre["salt"].as_str().expect("prelogin gave no salt"))
        .try_into()
        .expect("the salt must be 16 bytes");
    let params = params_from_json(&pre["params"]);
    let keys = derive_password_keys(password, &salt, &params).expect("cannot derive keys");
    api.post(
        "/v1/auth/login",
        None,
        json!({
            "username": username,
            "auth_key": hex::encode(keys.auth_key.as_bytes()),
            "device": device_json(ak, device_name),
        }),
    )
}

/// `POST /v1/auth/recover` (П15).
pub fn recover(
    api: &Api,
    username: &str,
    code: &RecoveryCode,
    ak: &AccountKey,
    name: &str,
) -> Resp {
    let keys = amby_sync_core::crypto::account::derive_recovery_keys(code);
    api.post(
        "/v1/auth/recover",
        None,
        json!({
            "username": username,
            "recovery_auth_key": hex::encode(keys.auth_key.as_bytes()),
            "device": device_json(ak, name),
        }),
    )
}

/// A body of `PUT /v1/keys` (П18).
pub fn keys_put_body(
    base_keys_version: u64,
    proof_kind: &str,
    proof_auth_key: &AuthKey,
    envelope: &PasswordEnvelope,
) -> Value {
    json!({
        "base_keys_version": base_keys_version,
        "proof": { "kind": proof_kind, "auth_key": hex::encode(proof_auth_key.as_bytes()) },
        "salt": hex::encode(envelope.salt),
        "params": params_json(&envelope.params),
        "auth_key": hex::encode(envelope.auth_key.as_bytes()),
        "wrapped_ak": hex::encode(&envelope.wrapped_account_key),
    })
}

/// A prepared change of one item: the JSON for a commit plus what the test may want to check.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub item: ItemId,
    pub base_version: u64,
    pub header: Header,
    pub body: Option<BodyId>,
    pub json: Value,
}

/// A space that this device can read and write (Р2).
#[derive(Clone)]
pub struct Space {
    pub api: Api,
    pub token: String,
    pub id: SpaceId,
    pub vk: SpaceKey,
}

impl Space {
    pub fn path(&self, suffix: &str) -> String {
        format!("/v1/spaces/{}{}", hex16(self.id.as_bytes()), suffix)
    }

    /// The same space as seen by another device.
    pub fn with_token(&self, token: &str) -> Space {
        Space {
            token: token.to_string(),
            ..self.clone()
        }
    }

    pub fn get(&self, suffix: &str) -> Resp {
        self.api.get(&self.path(suffix), Some(&self.token))
    }

    pub fn post(&self, suffix: &str, body: Value) -> Resp {
        self.api.post(&self.path(suffix), Some(&self.token), body)
    }

    // ----- bodies (П21–П24) -----

    pub fn init_blob(&self, blob: &BodyId, size: u64) -> Resp {
        self.post(
            "/blobs",
            json!({ "blob_id": hex16(blob.as_bytes()), "size": size }),
        )
    }

    pub fn put_part(&self, blob: &BodyId, part: u64, bytes: Vec<u8>) -> Resp {
        self.api.put_bytes(
            &self.path(&format!("/blobs/{}/parts/{part}", hex16(blob.as_bytes()))),
            Some(&self.token),
            bytes,
        )
    }

    pub fn complete_blob(&self, blob: &BodyId) -> Resp {
        self.post(
            &format!("/blobs/{}/complete", hex16(blob.as_bytes())),
            json!({}),
        )
    }

    pub fn download(&self, blob: &BodyId) -> Resp {
        self.get(&format!("/blobs/{}", hex16(blob.as_bytes())))
    }

    /// Uploads a sealed body in parts of 8 MiB and completes it, checking every answer.
    pub fn upload_sealed(&self, blob: &BodyId, sealed: &[u8]) {
        let first = self.init_blob(blob, sealed.len() as u64);
        assert!(
            first.status == 201 || first.status == 200,
            "starting a body: expected 201 or 200, got HTTP {} {}",
            first.status,
            first.text()
        );
        for (index, part) in sealed.chunks(PART_SIZE as usize).enumerate() {
            self.put_part(blob, index as u64, part.to_vec()).expect(200);
        }
        self.complete_blob(blob).expect(200);
    }

    // ----- items (Р2) -----

    fn commit_item_json(
        &self,
        item: &ItemId,
        base_version: u64,
        header: &Header,
        body: Option<&BodyId>,
    ) -> Value {
        let envelope = seal_header(&self.vk, &self.id, item, header, &mut OsRandom)
            .expect("cannot seal the header");
        json!({
            "item_id": hex16(item.as_bytes()),
            "base_version": base_version,
            "header": hex::encode(envelope),
            "blob_id": body.map(|blob| hex16(blob.as_bytes())),
            "deleted": header.deleted,
        })
    }

    /// Seals and uploads a file body, then returns the commit entry for version
    /// `base_version + 1` of `item`.
    pub fn file(&self, item: &ItemId, base_version: u64, path: &str, content: &[u8]) -> Prepared {
        let body = BodyId::random(&mut OsRandom);
        let sealed = seal_body(&self.vk, &body, content, &mut OsRandom).expect("cannot seal");
        self.upload_sealed(&body, &sealed);
        self.file_with_uploaded_body(item, base_version, path, content, &body)
    }

    /// A commit entry for content whose body is already uploaded as `body` (a rename reuses it).
    pub fn file_with_uploaded_body(
        &self,
        item: &ItemId,
        base_version: u64,
        path: &str,
        content: &[u8],
        body: &BodyId,
    ) -> Prepared {
        let header = Header {
            format: 1,
            version: base_version + 1,
            kind: ItemKind::File,
            path: path.to_string(),
            size: content.len() as u64,
            mtime_ms: 1_700_000_000_000,
            content_hash: Some(blake3_hash(content)),
            body_id: Some(*body),
            deleted: false,
            extra: BTreeMap::new(),
        };
        let json = self.commit_item_json(item, base_version, &header, Some(body));
        Prepared {
            item: *item,
            base_version,
            header,
            body: Some(*body),
            json,
        }
    }

    /// A folder entry: no body (Р2).
    pub fn folder(&self, item: &ItemId, base_version: u64, path: &str) -> Prepared {
        let header = Header {
            format: 1,
            version: base_version + 1,
            kind: ItemKind::Folder,
            path: path.to_string(),
            size: 0,
            mtime_ms: 1_700_000_000_000,
            content_hash: None,
            body_id: None,
            deleted: false,
            extra: BTreeMap::new(),
        };
        let json = self.commit_item_json(item, base_version, &header, None);
        Prepared {
            item: *item,
            base_version,
            header,
            body: None,
            json,
        }
    }

    /// A deletion: an encrypted header with `deleted: true` (Р6) and the open mark.
    pub fn deletion(&self, item: &ItemId, base_version: u64, path: &str) -> Prepared {
        let header = Header {
            format: 1,
            version: base_version + 1,
            kind: ItemKind::File,
            path: path.to_string(),
            size: 0,
            mtime_ms: 1_700_000_000_000,
            content_hash: None,
            body_id: None,
            deleted: true,
            extra: BTreeMap::new(),
        };
        let json = self.commit_item_json(item, base_version, &header, None);
        Prepared {
            item: *item,
            base_version,
            header,
            body: None,
            json,
        }
    }

    // ----- commits and the feed (П26–П31) -----

    pub fn commit_body(&self, commit_id: &[u8; 16], items: &[Prepared]) -> Value {
        json!({
            "commit_id": hex16(commit_id),
            "items": items.iter().map(|prepared| prepared.json.clone()).collect::<Vec<_>>(),
        })
    }

    /// Commits with a new random `commit_id`.
    pub fn commit(&self, items: &[Prepared]) -> Resp {
        self.commit_with(&random16(), items)
    }

    pub fn commit_with(&self, commit_id: &[u8; 16], items: &[Prepared]) -> Resp {
        self.post("/commit", self.commit_body(commit_id, items))
    }

    /// Commits and checks that it was accepted; returns the `seq`.
    pub fn commit_ok(&self, items: &[Prepared]) -> u64 {
        let body = self.commit(items).expect(200).json();
        body["seq"].as_u64().expect("commit gave no seq")
    }

    pub fn changes(&self, since: u64, limit: Option<u64>) -> Resp {
        let mut suffix = format!("/changes?since={since}");
        if let Some(limit) = limit {
            suffix.push_str(&format!("&limit={limit}"));
        }
        self.get(&suffix)
    }

    /// The decrypted header of one entry of the feed or of `versions`.
    pub fn open_change(&self, change: &Value) -> Header {
        let item_bytes: [u8; 16] = unhex(change["item_id"].as_str().expect("no item_id"))
            .try_into()
            .expect("item_id must be 16 bytes");
        let item = ItemId::from_bytes(item_bytes);
        let version = change["version"].as_u64().expect("no version");
        let envelope = unhex(change["header"].as_str().expect("no header"));
        open_header(&self.vk, &self.id, &item, version, &envelope)
            .unwrap_or_else(|error| panic!("the header does not open: {error:?}"))
    }

    /// Downloads and opens the body of one entry; the bytes must equal the original (О7).
    pub fn fetch_file(&self, change: &Value) -> Vec<u8> {
        let header = self.open_change(change);
        let body_id = header.body_id.expect("the entry has no body");
        let sealed = self.download(&body_id).expect(200).body;
        let hash = header.content_hash.expect("the entry has no content hash");
        open_body(&self.vk, &body_id, header.size, &hash, &sealed)
            .unwrap_or_else(|error| panic!("the body does not open: {error:?}"))
    }

    /// Every entry of the feed from `since`, following the cursor to the end.
    pub fn all_changes(&self, since: u64) -> Vec<Value> {
        let mut cursor = since;
        let mut out = Vec::new();
        loop {
            let page = self.changes(cursor, None).expect(200).json();
            out.extend(
                page["changes"]
                    .as_array()
                    .expect("no changes array")
                    .iter()
                    .cloned(),
            );
            if page["more"].as_bool() != Some(true) {
                return out;
            }
            cursor = page["next"].as_u64().expect("no next cursor");
        }
    }
}

/// An item id shortcut.
pub fn new_item() -> ItemId {
    ItemId::from_bytes(random16())
}

/// Unwraps the VK that the server returns for a space, as a second device would (Р5).
pub fn unwrap_vk_from_listing(ak: &AccountKey, space: &Value) -> SpaceKey {
    let id: [u8; 16] = unhex(space["space_id"].as_str().expect("no space_id"))
        .try_into()
        .expect("space_id must be 16 bytes");
    let epoch = space["key_epoch"].as_u64().expect("no key_epoch") as u32;
    let wrapped = unhex(space["wrapped_vk"].as_str().expect("no wrapped_vk"));
    amby_sync_core::crypto::account::unwrap_space_key(ak, &SpaceId::from_bytes(id), epoch, &wrapped)
        .unwrap_or_else(|error| panic!("the wrapped VK does not open: {error:?}"))
}

/// Unwraps AK from the `wrapped_ak` of a login or `GET /v1/keys` answer.
pub fn unwrap_ak(
    password: &str,
    salt: &[u8; 16],
    params: &Argon2Params,
    wrapped_hex: &str,
) -> AccountKey {
    let keys = derive_password_keys(password, salt, params).expect("cannot derive keys");
    unwrap_account_key(&keys.kek, &unhex(wrapped_hex))
        .unwrap_or_else(|error| panic!("AK does not open: {error:?}"))
}

/// `GET /v1/info`, checked to be 200 (П9).
pub fn info(api: &Api) -> Value {
    api.get("/v1/info", None).expect(200).json()
}

/// A number from `limits` of `/v1/info`.
pub fn limit(api: &Api, name: &str) -> u64 {
    info(api)["limits"][name]
        .as_u64()
        .unwrap_or_else(|| panic!("limits.{name} of /v1/info is not a number"))
}

/// Fails unless `value` is a string of lower-case hex for exactly `bytes` bytes (П2).
pub fn assert_hex(value: &Value, bytes: usize, what: &str) {
    let text = value
        .as_str()
        .unwrap_or_else(|| panic!("{what} is not a string: {value}"));
    assert!(
        text.len() == bytes * 2
            && text
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
        "{what} must be {bytes} bytes of lower-case hex, got {text}"
    );
}

impl Space {
    /// `GET …/items/{item}/versions` (П33).
    pub fn versions(&self, item: &ItemId) -> Resp {
        self.get(&format!("/items/{}/versions", hex16(item.as_bytes())))
    }
}

/// Byte `i` of the test content: not constant, not periodic at the part boundaries.
pub fn pattern(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + (i >> 8) * 7 + 7) % 256) as u8)
        .collect()
}

/// A new random body id.
pub fn new_body() -> BodyId {
    BodyId::random(&mut OsRandom)
}
