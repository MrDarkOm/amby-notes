# Amby sync: protocol and format v1

This is the public contract of Amby sync, for people who run their own server or write a third-party
client. It describes what the code does today: the server in `sync/server/`, the shared constants in
`sync/proto/`, the cryptography in `sync/core/src/crypto/` and the client in `sync/client/`. The design
history lives in the development plan (`docs/sync-plan.md`, on the development branch only); where the
two differ, this document and the code win.

## 1. Status, versioning, compatibility

| Item                | Value                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| Protocol version    | `1` (`GET /v1/info` → `protocol: {min: 1, max: 1}`; every path starts with `/v1`) |
| Header format       | `1` (`formats.header`; the `format` field inside a header, version byte `0x01`)   |
| Body format         | `1` (`formats.body`; version byte `0x01` after the magic `AMBYBODY`)              |
| Wrapped keys, names | version byte `0x01`                                                               |

Compatibility rules:

- **Unknown fields are ignored.** A server ignores unknown fields of a request, a client ignores unknown
  fields of an answer, and a client keeps unknown fields of a decrypted header as they are (they are
  written back unchanged, but a known key may not be repeated among them).
- **Unknown versions are refused, never guessed.** An envelope with a version byte other than `0x01` is
  an "unsupported version" error, not an authentication error. A header with `format` above `1` is not
  applied and not rewritten (it is reported as "newer format"). A client whose version does not lie in the
  server's `protocol` range must stop (`unsupported_server`).
- A server that lacks a route added later answers `404 not_found` (for example `GET /v1/account`); a
  client then behaves as before and does not show the limits.
- A change of any byte layout below means a new version byte, new test vectors and a new reference
  implementation, in one change.

Test material:

- `sync/vectors/format-v1.json` — generated vectors: password and recovery keys, wrapped keys, names,
  account creation, header JSON and envelopes (with negative cases), paths, bodies (with negative cases).
- `sync/vectors/standards.json` — vectors of the underlying primitives from their standards.
- `sync/reference/` — an independent Python implementation (`amby_ref.py`) written from the byte layouts,
  not from the Rust code, with different primitive libraries. `generate_vectors.py` produces the vectors,
  `test_reference.py` checks them. A third-party client should reproduce these vectors byte for byte.
- `sync/conformance/` — HTTP tests that run against any server address and write the requests by hand;
  a third-party server can be tested with it.

## 2. Cryptography

### 2.1 Conventions

- Integers inside binary structures are big-endian: `epoch` is 4 bytes (u32), `version` is 8 bytes (u64).
  `‖` is concatenation. Strings in `info` and AAD are ASCII without a terminating zero.
- Random 16-byte identifiers (`space_id`, `item_id`, `body_id`, `blob_id`, `commit_id`, `device_id`,
  `instance_id`) are raw bytes in binary structures and 32 lowercase hex characters in JSON.
- All AEAD is XChaCha20-Poly1305 (24-byte nonce, 16-byte tag). All KDF steps are HKDF-SHA-256 with an
  **empty salt** (RFC 5869: `HashLen` zero bytes), 32-byte output. Hashes of content are BLAKE3.
- The epoch of a space key starts at 1; epoch 0 is invalid everywhere. Protocol v1 only creates epoch 1.

### 2.2 Key hierarchy

```text
password ─NFKC, UTF-8─▶ Argon2id ─▶ master key (32) ─HKDF─┬─▶ auth_key  (sent to the server)
                                                          └─▶ KEK       (stays on the device)
recovery code (32 bytes) ─HKDF─┬─▶ recovery_auth_key  (sent to the server)
                               └─▶ recovery_KEK       (stays on the device)
KEK / recovery_KEK ─wrap─▶ AK (account key, 32 random bytes, one per account)
AK ─wrap─▶ VK (space key, 32 random bytes per space, with epoch)
AK ─HKDF "amby-sync/name-key/1"─▶ name key
VK ─HKDF "amby-sync/header-key/1"─▶ header key
VK ─HKDF "amby-sync/body/1" ‖ body_id─▶ body key (one per body)
```

**Password.** The password is normalised to Unicode NFKC and encoded as UTF-8 (so the same password typed
on macOS and Windows gives the same key). It is not trimmed. Argon2id version `0x13`, a 16-byte random
salt, output 32 bytes, no `secret`, no associated data. Defaults: memory 65 536 KiB, 3 passes,
parallelism 4.

**Allowed parameter range** (checked by the client before computing, and by the server on `enroll` and
`PUT /v1/keys`; anything outside is refused, never clamped):

| Parameter     | Minimum | Maximum   |
| ------------- | ------- | --------- |
| `memory_kib`  | 65 536  | 1 048 576 |
| `iterations`  | 3       | 12        |
| `parallelism` | 1       | 16        |

The minimums equal the defaults on purpose: a hostile server could otherwise send weak parameters at
sign-in and collect an `auth_key` that is cheap to guess.

**HKDF `info` strings** (ASCII):

| `info`                                | Input key material | Result              |
| ------------------------------------- | ------------------ | ------------------- |
| `amby-sync/auth/1`                    | master key         | `auth_key`          |
| `amby-sync/kek/1`                     | master key         | `KEK`               |
| `amby-sync/recovery-auth/1`           | recovery code      | `recovery_auth_key` |
| `amby-sync/recovery-kek/1`            | recovery code      | `recovery_KEK`      |
| `amby-sync/name-key/1`                | AK                 | name key            |
| `amby-sync/header-key/1`              | VK                 | header key          |
| `amby-sync/body/1` ‖ `body_id` (16 B) | VK                 | body key            |

**What the server stores.** `SHA-256(auth_key)` and `SHA-256(recovery_auth_key)`, the salt, the
parameters, both wrapped AKs. It never stores `auth_key` itself, the password, AK, any VK or the
recovery code. It stores `SHA-256(token)` for device tokens.

### 2.3 Recovery code

32 random bytes. Display form: Crockford base32, alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.

- The 256 bits are read left to right in groups of 5 bits: 51 full groups and a 52nd made of one bit and
  four zero bits. Then 4 check symbols: the first 20 bits of `SHA-256("amby-sync/recovery-check/1" ‖
code)` written as four symbols. Total 56 symbols, shown uppercase in 14 groups of 4 separated by `-`.
  The checksum catches typos; it is not protection against guessing.
- Parsing ignores whitespace and `-`, is case-insensitive, maps `O → 0` and `I`, `L → 1`; any other
  symbol (including `U`) is an error. Checks, in order: symbols, length (exactly 56), zero bits of the
  52nd symbol, checksum.

### 2.4 Wrapped keys (AK, VK)

```text
wrapped = 0x01 ‖ nonce (24) ‖ ciphertext (32) ‖ tag (16)        73 bytes
```

| What          | Key            | AAD                                                   |
| ------------- | -------------- | ----------------------------------------------------- |
| AK (password) | `KEK`          | `amby-sync/wrap-ak/1`                                 |
| AK (recovery) | `recovery_KEK` | `amby-sync/wrap-ak/1`                                 |
| VK            | AK             | `amby-sync/wrap-vk/1` ‖ `space_id` (16) ‖ `epoch` (4) |

The password and recovery wraps use different keys, so one cannot replace the other. The VK AAD binds a
wrapped VK to its space and epoch: a server cannot hand out the VK of one space or epoch as another. The
`space_id` is chosen by the device before the VK is wrapped.

### 2.5 Names of devices and spaces

Only the owner can read a name; the server stores the bytes as they are and only checks the length.

```text
name envelope = 0x01 ‖ nonce (24) ‖ ciphertext (64) ‖ tag (16)        always 105 bytes
```

Key: the name key (2.2). Plaintext: the UTF-8 name, at most 64 bytes, no zero byte, padded with zeros to
64 bytes (on reading, trailing zeros are stripped; a zero inside the name is an error). AAD: device name —
`amby-sync/device-name/1`; space name — `amby-sync/space-name/1` ‖ `space_id` (16).

A device name sent by a device that has none yet is an empty `name_enc` (0 bytes) — see `login` and
`recover` in 3.5. Apps treat a device name as non-empty, without control characters.

### 2.6 Item header

A header describes one version of one item (a file or a folder). It is sealed on the device; the server
stores it opaquely.

**JSON fields:**

| Field          | Type                | Meaning                                                |
| -------------- | ------------------- | ------------------------------------------------------ |
| `format`       | integer             | `1`                                                    |
| `version`      | integer ≥ 0         | equals the version number the server gives this record |
| `kind`         | `"file"`/`"folder"` |                                                        |
| `path`         | string (NFC)        | path inside the vault, `/`-separated                   |
| `size`         | integer ≥ 0         | size of the real content (0 for a folder)              |
| `mtime_ms`     | integer (signed)    | modification time, Unix ms                             |
| `content_hash` | 64 hex or `null`    | BLAKE3 of the content; `null` for a folder             |
| `body_id`      | 32 hex or `null`    | the body this version refers to; `null` for a folder   |
| `deleted`      | boolean             |                                                        |

Any other key is an unknown field of a newer version: it is kept, never interpreted. A known key among
unknown fields when writing is an error (`ReservedKey`).

**Canonical JSON** (what is encrypted): UTF-8 without BOM; no whitespace; separators `,` and `:`; object
keys sorted by the bytes of their UTF-8 at every level; strings escaped minimally — `\"`, `\\`, and the
control characters U+0000–U+001F as `\b \t \n \f \r` or `\u00XX` in lowercase hex; everything else
(including non-ASCII and U+007F) literally; numbers are integers only, decimal, no plus sign, no leading
zeros, no exponent (fractions and exponents are rejected). A repeated key in any object is a parse error
when reading.

**Path syntax** (rejected on writing and on reading, before the NFC check): empty; starts or ends with `/`;
an empty segment (`a//b`); a segment `.` or `..`; contains `\`; contains U+0000–U+001F or U+007F; longer
than 4096 bytes in UTF-8. A path that is not NFC is an error. Rules of a particular file system (`:`,
`CON`, case) are the client's to enforce.

**Padding.** Zero bytes are appended to the canonical JSON until its length is a multiple of 256 (nothing
is appended if it already is). JSON never ends with a zero, so on reading every trailing zero is padding.
A length that is zero or not a multiple of 256 is an error.

**Envelope:**

```text
header envelope = 0x01 ‖ epoch (4) ‖ nonce (24) ‖ ciphertext (padded JSON length) ‖ tag (16)
```

Key: the header key. AAD (62 bytes): `amby-sync/header/1` ‖ `space_id` (16) ‖ `item_id` (16) ‖ `epoch` (4) ‖
`version` (8). The `epoch` in the envelope is in clear so the reader can pick the right VK; it must equal
the epoch of that VK (any mismatch, including 0, is an error). The `version` in the AAD must equal the
`version` inside the JSON after decryption. The shortest possible envelope is 301 bytes
(1 + 4 + 24 + 256 + 16), which is what the server enforces as a minimum.

Because the item, space and version are in the AAD, a server cannot move a header to another item,
space or version without detection.

### 2.7 Body

A body is the encrypted content of one file version, in the STREAM construction (`EncryptorBE32` of
RustCrypto over XChaCha20-Poly1305).

```text
body     = preamble ‖ chunk 0 ‖ … ‖ last chunk
preamble = "AMBYBODY" (8) ‖ 0x01 ‖ epoch (4) ‖ nonce prefix (19)            32 bytes
nonce of chunk i = nonce prefix (19) ‖ i (4, big-endian) ‖ flag (1)          flag 0x01 only on the last chunk
```

- Key: the body key (2.2), derived from VK and `body_id`. A new `body_id` is used for every upload, so one
  key never encrypts two different bodies. `blob_id` in the protocol equals `body_id` in the header.
- AAD of every chunk: the whole 32-byte preamble.
- Plaintext chunk: exactly 65 536 bytes, except the last (0–65 536 bytes). Each ciphertext chunk is 16
  bytes longer. Number of chunks: `max(1, ⌈P / 65 536⌉)`, with `P` the padded content length. An empty file
  is one last chunk of a bare tag (16 bytes). There is no extra empty chunk after a full last chunk.
- **Padded content** = content ‖ zero bytes up to `P = padme(size)`, `size` taken from the verified header.
- **Padmé** (Nikitin et al., PETS 2019): for `L < 2` the result is `L`; otherwise `E = ⌊log₂ L⌋`,
  `S = ⌊log₂ E⌋ + 1`, `z = E − S`, `m = 2^z − 1`, result `(L + m) & ~m`. Examples: `9 → 10`, `17 → 18`,
  `257 → 272`, `1000 → 1024`, `65 537 → 67 584`. Overhead is at most 12 %. `L` above `2^62` is an error.
- **Sealed size** (what the server sees and what `size` of `POST /blobs` must be):
  `32 + P + 16 · max(1, ⌈P / 65 536⌉)`.
- **Reading.** Check the magic (`AMBYBODY`), then the version byte, then the epoch, all before decrypting.
  Read full chunks of 65 552 bytes while more than 65 552 bytes remain; the remainder (16…65 552 bytes) is
  the last chunk. Then verify, in this order: every chunk authenticates; the padded length equals
  `padme(size)`; the bytes after `size` are all zero; `BLAKE3(content) == content_hash`. If any check fails,
  return nothing. A streaming reader must write to a temporary file next to the target and publish it only
  after all of these checks pass.

### 2.8 What the server sees and what it does not

| The server sees                                                                                                 | The server cannot see                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Account name (login), when and from where devices connect, device ids, `last_seen_ms`                           | Password, `auth_key`, AK, any VK, the recovery code          |
| The number of spaces, items, versions, commits, and when they happen                                            | Paths, file names, folder structure, content, content hashes |
| Sealed body sizes (padded with Padmé, so only roughly the file size)                                            | File sizes, `mtime`, the kind of an item                     |
| The `deleted` flag of a version (kept clear so cleanup can work; clients must not trust it, the header decides) | Space and device names                                       |
| Which items a commit changes together, and how many                                                             | Which body belongs to which item (it only knows `blob_id`)   |

The server does not link a body to the item that uses it; a client must verify that a downloaded body
matches the header it belongs to (key from `body_id`, size and hash in the header). The password and the
keys never leave the device in the clear.

## 3. Protocol

### 3.1 Conventions

- Transport: HTTPS (HTTP is allowed by the server for `localhost`, `127.0.0.1`, `[::1]` or when the operator
  sets `AMBY_SYNC_ALLOW_HTTP=1`). A client must require `https://` by the same rule and must not follow
  redirects. A path prefix in the server address (a reverse proxy) is kept; query, fragment and credentials
  in the address are not accepted.
- Requests and answers with a body are JSON in UTF-8, `Content-Type: application/json` (parameters after
  `;` are allowed). A request body must be a JSON object. Another content type is `400 bad_request`. Bodies
  of file parts are `application/octet-stream`.
- Binary values in JSON are **lowercase hex**. Upper case, an odd length, a non-hex character or a wrong
  length is `400 bad_request` (the message never names the value). `hexN` below means `N` bytes.
- Times named `*_ms` are Unix milliseconds, UTC, for display and cleanup only; they never decide versions.
- **Errors**: every 4xx and 5xx answer is JSON
  `{"error": {"code": "<machine code>", "message": "<text for people>", "details": {…}}}`; `details` is
  present only where stated. A client looks at the HTTP status and `code` and never parses `message`.
  Unknown paths and wrong methods also answer in this shape (`404 not_found`, `405 method_not_allowed`).
- **Authentication**: the device token is 32 random bytes as 64 hex characters, sent as
  `Authorization: Bearer <token>` (the word `Bearer` with a capital B and one space). Never in the URL.
  No header, an unknown token, or a token of the wrong form is `401 unauthorized`; the token of a
  disconnected device is `401 token_revoked`. Only `/v1/info` and the four `/v1/auth/*` routes need no
  token. Authentication is checked before anything else on a route, except that a malformed id on a path
  that needs a token comes after it.
- **Ownership**: a space has one owner. Somebody else's space, an unknown or malformed `space_id`, an
  unknown item, a foreign device and an unknown body all answer the same `404 not_found`; the server never
  reveals that an object exists.
- **Request size**: JSON requests are at most `limits.max_json_bytes` (`413 payload_too_large`); the four
  `/v1/auth/*` requests at most 64 KiB whatever that setting says (and such a refusal does not count as a
  sign-in failure). A JSON body above 1 MiB is read only while fewer than `AMBY_SYNC_MAX_LARGE_BODIES`
  such bodies are being read; otherwise `503 server_busy` with `Retry-After: 5`.
- Routes below are relative to the server root. In the list, "token" means the Bearer token is required.

### 3.2 Routes

| Method and path                                        | Auth  | Section |
| ------------------------------------------------------ | ----- | ------- |
| `GET /v1/info`                                         | no    | 3.4     |
| `POST /v1/auth/prelogin`                               | no    | 3.5     |
| `POST /v1/auth/enroll`                                 | no    | 3.5     |
| `POST /v1/auth/login`                                  | no    | 3.5     |
| `POST /v1/auth/recover`                                | no    | 3.5     |
| `GET /v1/keys`, `PUT /v1/keys`                         | token | 3.6     |
| `GET /v1/devices`                                      | token | 3.7     |
| `PUT /v1/devices/{device_id}`, `DELETE …`              | token | 3.7     |
| `GET /v1/account`                                      | token | 3.9     |
| `GET /v1/account/username`, `PUT /v1/account/username` | token | 3.8     |
| `GET /v1/spaces`, `POST /v1/spaces`                    | token | 3.10    |
| `DELETE /v1/spaces/{space_id}`                         | token | 3.10    |
| `GET /v1/spaces/{space_id}/changes`                    | token | 3.12    |
| `GET /v1/spaces/{space_id}/events`                     | token | 3.13    |
| `POST /v1/spaces/{space_id}/blobs`                     | token | 3.11    |
| `GET`, `DELETE /v1/spaces/{space_id}/blobs/{blob_id}`  | token | 3.11    |
| `PUT /v1/spaces/{space_id}/blobs/{blob_id}/parts/{n}`  | token | 3.11    |
| `POST /v1/spaces/{space_id}/blobs/{blob_id}/complete`  | token | 3.11    |
| `POST /v1/spaces/{space_id}/commit`                    | token | 3.12    |
| `GET /v1/spaces/{space_id}/items/{item_id}/versions`   | token | 3.14    |

### 3.3 Account names

A login is ASCII: 1–64 characters from `a-z 0-9 . _ -`, the first and last a letter or digit. ASCII capitals
are folded to lower case before every check, storage, lookup and counter (`Alice`, `ALICE`, `alice` are one
login). The server stores and returns the lowercase name. Unicode is not folded and not accepted. For
`prelogin`, `login` and `recover` an invalid name behaves exactly like an unknown name (never `400`).

### 3.4 `GET /v1/info`

Answer `200`:

```json
{
  "server": "amby-sync-server",
  "server_version": "0.2.0",
  "protocol": { "min": 1, "max": 1 },
  "formats": { "header": 1, "body": 1 },
  "instance_id": "<hex16>",
  "registration": { "open": false },
  "time_ms": 0,
  "limits": {
    "max_blob_bytes": 536870912,
    "part_size": 8388608,
    "max_commit_items": 10000,
    "max_header_bytes": 16384,
    "max_json_bytes": 67108864,
    "changes_page_default": 500,
    "changes_page_max": 1000,
    "login_max_failures": 5,
    "login_window_secs": 900,
    "login_max_failures_per_user": 50,
    "login_window_per_user_secs": 3600,
    "sse_keepalive_secs": 15,
    "quota_bytes_per_user": null
  },
  "retention": { "version_days": 30, "orphan_blob_hours": 24, "enroll_code_hours": 24 }
}
```

`instance_id` is 16 random bytes the server creates with its database. A restart on the same data keeps
it; an empty data directory (reset, lost volume) gives a new one. A client stores it and **stops** when it
changes (the server may have lost data), and every feed answer and the `hello` event repeat it. It is not
a secret. `registration.open` is true when anyone may create an account (an older server omits the
object: treat as closed). `part_size` is always 8 388 608. `limits` are server ceilings; the limits of a
particular user (plan) are in `GET /v1/account`. `quota_bytes_per_user` is `null` while no server-wide
quota is set. `max_blob_bytes` and the quota apply to the **sealed** size, so compare `sealed_body_len`,
not the file size.

### 3.5 Sign-up, sign-in, recovery

**`POST /v1/auth/prelogin`** `{"username"}` → `200 {"salt": hex16, "params": {"memory_kib", "iterations",
"parallelism"}}`. Any string name of up to 256 characters gets an answer of this shape (a longer one or a
non-string is `400`). A real user with a password gets their own salt and parameters. Everyone else
(unknown, invalid, still waiting for the first enrolment) gets a **fake but stable salt** — the first 16
bytes of `HMAC-SHA256(prelogin_secret, "amby-sync/prelogin/1" ‖ canonical name)`, with a secret the server
keeps — and the default parameters. Prelogin is not counted as a sign-in attempt. Known limitation: the
real salt changes when the password changes, the fake one does not.

**`POST /v1/auth/enroll`** creates the account and its first device in one transaction:

```json
{
  "username": "alice",
  "enroll_code": "XXXX-XXXX-XXXX-XXXX-XXXX",
  "salt": "<hex16>",
  "params": { "memory_kib": 65536, "iterations": 3, "parallelism": 4 },
  "auth_key": "<hex32>",
  "wrapped_ak": "<hex73>",
  "recovery_auth_key": "<hex32>",
  "wrapped_ak_recovery": "<hex73>",
  "device": { "name_enc": "<hex105>" }
}
```

→ `201 {"device_id", "token", "keys_version": 1}`. The device name is required here and must be exactly
105 bytes.

- **Invitation:** an administrator creates the name and a one-time code (`user add`). The code is 100
  random bits in Crockford base32, 20 symbols, shown as `XXXX-XXXX-XXXX-XXXX-XXXX`. The server stores
  `SHA-256` of the normalised code (upper case, no `-`, spaces or tabs) and its expiry (24 hours by
  default). A wrong, used or unknown-name code is `401 invalid_enroll_code`; a right code that expired is
  `401 enroll_code_expired`. The code is burned by a successful enrolment.
- **Open registration** (`AMBY_SYNC_OPEN_REGISTRATION=1`): an absent or empty `enroll_code` creates an
  account for a new, valid name. An existing account, a name reserved by an invitation, or a full server
  (`AMBY_SYNC_MAX_USERS`) is `409 registration_unavailable`. A non-empty code is always checked as an
  invitation, even on an open server. A closed server with no `enroll_code` is `400 bad_request`.
  On a server short of disk space (3.16) open registration is `507 server_storage_full`.
- `params` outside the range of 2.2 is `400 bad_request`.

**`POST /v1/auth/login`** `{"username", "auth_key": hex32, "device"?: {"name_enc"?: hex105}}` →
`200 {"device_id", "token", "salt", "params", "wrapped_ak", "keys_version"}`. Every successful sign-in
creates a **new** device and a new token. The `device` object and `name_enc` are optional (`null` counts
as absent); without a name the device is created with an empty name, to be set later by renaming. A
`name_enc` that is present must be exactly 105 bytes.

**`POST /v1/auth/recover`** `{"username", "recovery_auth_key": hex32, "device"?}` →
`200 {"device_id", "token", "wrapped_ak_recovery", "keys_version"}`. The client unwraps AK with the key
derived from the recovery code, then sets a new password with `PUT /v1/keys` (proof kind `recovery`).

For wrong credentials of `login` and `recover` (unknown name, invalid name, name without a password, wrong
key) the answer is identical in status, `code` and `message`; comparison is constant time.

### 3.6 Keys

**`GET /v1/keys`** → `200 {"keys_version", "salt", "params", "wrapped_ak", "wrapped_ak_recovery"}`.

**`PUT /v1/keys`** replaces the password envelope (change of password) and optionally the recovery pair:

```json
{"base_keys_version": 1,
 "proof": {"kind": "password" | "recovery", "auth_key": "<hex32>"},
 "salt": "<hex16>", "params": {…}, "auth_key": "<hex32>", "wrapped_ak": "<hex73>",
 "recovery_auth_key": "<hex32>", "wrapped_ak_recovery": "<hex73>"}
```

`recovery_auth_key` and `wrapped_ak_recovery` come together or not at all. `proof.auth_key` is the current
`auth_key` (kind `password`) or `recovery_auth_key` (kind `recovery`). Check order: token; field shapes and
parameter range; throttle; proof (`403 invalid_proof`, counted as a failure); version (`409 keys_conflict`
with `details: {"keys_version": N}`). Accepted → `200 {"keys_version": N+1}` in one transaction. Other
devices keep their tokens.

### 3.7 Devices

- `GET /v1/devices` → `200 {"devices": [{"device_id", "name_enc", "created_ms", "last_seen_ms", "current"}]}`
  in creation order. `name_enc` is empty (`""`) for a device that has no name yet. `last_seen_ms` is
  updated at most once a minute.
- `PUT /v1/devices/{device_id}` `{"name_enc": hex105}` → `204`. Renames one of the account's own devices;
  the first byte of the envelope must be `0x01`. A foreign or unknown device is `404`. Tokens, ids and
  dates do not change. An empty name cannot be set this way.
- `DELETE /v1/devices/{device_id}` → `204`. The token stops working at once (`401 token_revoked`), its
  open event streams end within the keep-alive interval. A device may disconnect itself. A foreign or
  unknown id, and a repeat, is `404`.

### 3.8 Account name

- `GET /v1/account/username` → `200 {"username"}`.
- `PUT /v1/account/username` `{"username", "base_username", "auth_key": hex32}` → `204`. `auth_key` is the
  current password proof. Wrong proof `403 invalid_proof` (counted); `base_username` different from the
  current login `409 username_conflict`; the new name already used `409 username_taken`; the new name
  invalid `400 bad_request`. A request to rename to the current name succeeds (after the proof). The rename
  changes no key, space, quota or device.

### 3.9 `GET /v1/account`

Plan, effective limits, usage and spaces of the signed-in user. Answer `200`:

```json
{"plan": {"name": "standard" | null, "title": "…" | null, "pinned": false, "sync": true, "until_ms": null},
 "limits": {"max_spaces": null, "max_total_bytes": null, "max_file_bytes": 536870912,
            "history_days": 30, "max_history_bytes": null},
 "usage": {"live_bytes": 0, "pending_bytes": 0, "history_bytes": 0, "spaces": 0},
 "spaces": [{"space_id", "name_enc", "key_epoch", "wrapped_vk", "seq", "created_ms",
             "live_bytes": 0, "history_bytes": 0}]}
```

- `limits` are **effective**: the smaller of the plan's number and the server ceiling. `null` means no
  limit; `history_days` is always a number. `max_file_bytes` is a sealed size.
- `plan.sync` says whether the plan allows sending changes (3.15). `plan.until_ms` is the end of a time-limited
  pin (`null` when there is none; after it passes the default plan acts and `pinned` is false).
- `live_bytes` (the latest, non-deleted version of some item refers to the body), `pending_bytes` (no version
  refers to it yet: started or complete but not committed, by declared size) and `history_bytes` (only
  replaced versions or deleted items refer to it) are sealed sizes. **Quota counts `live + pending`;
  history is shown apart and is not in the quota.**
- A server without this route answers `404 not_found`.

### 3.10 Spaces

- `POST /v1/spaces` `{"space_id": hex16, "name_enc": hex105, "key_epoch": 1, "wrapped_vk": hex73}` →
  `201 {"space_id", "seq": 0, "created_ms"}`. Errors: `409 space_exists` (checked before the limit);
  `403 subscription_required` (3.15); `403 space_limit` with `details: {"max_spaces", "spaces"}`;
  `507 server_storage_full` (3.16). `key_epoch` must be 1.
- `GET /v1/spaces` → `200 {"spaces": [{"space_id", "name_enc", "key_epoch", "wrapped_vk", "seq",
"created_ms"}]}` in creation order. `seq` is the number of the last accepted commit (0 for a new space).
  The client unwraps `wrapped_vk` with AK, the `space_id` and `key_epoch` (2.4).
- `DELETE /v1/spaces/{space_id}` → `200 {"ok": true}`. Removes the space with every item, version, stored
  commit answer, body and unfinished upload; frees the bytes at once; ends the open event streams of the
  space. A repeat is `404`. It works without a subscription and on a full disk.

### 3.11 Bodies in parts

An upload is made of parts so that a broken connection does not lose what was sent. All paths are under
`/v1/spaces/{space_id}`. `PART_SIZE` is 8 388 608 bytes.

**`POST /blobs`** `{"blob_id": hex16, "size": N, "replaces"?: hex16}`. `size` is the **sealed** body size in
bytes, at least 1. `replaces` is an optional hint: the `item_id` whose current live body this upload will
replace; the server credits that body's size against the quota (the hint is checked, a foreign or unknown
item gives no credit and no error). Answer: `201` for a new body, `200` for an existing one with the same
`size` (resume), body of both:

```json
{
  "blob_id": "<hex16>",
  "size": 0,
  "part_size": 8388608,
  "parts": 1,
  "uploaded": [0],
  "complete": false
}
```

`parts = max(1, ⌈size / part_size⌉)`; `uploaded` lists the numbers of the parts already stored, ascending.
Check order: token → ownership → subscription (`403`) → free space (`507 server_storage_full`) → file size
(`413 blob_too_large`, `details: {"size", "max_bytes", "source": "plan"|"server"}`) → existing body (`409
blob_exists` if started with another size) → quota (`507 quota_exceeded`, `details: {"used_bytes",
"limit_bytes", "needed_bytes"}`). The quota check passes when `size` is not larger than the credit of
`replaces`.

**`PUT /blobs/{blob_id}/parts/{n}`**, raw bytes, `n` from 0. Every part is exactly `part_size` bytes except
the last, which is `size − n · part_size`. Any other length or `n ≥ parts` is `400 bad_part`. A part may be
rewritten until `complete` → `200 {"part": n, "size": length}`. No such body `404`; already complete
`409 blob_exists`. Gated by subscription and free space like `POST /blobs`.

**`POST /blobs/{blob_id}/complete`** → `200 {"blob_id", "size", "complete": true}` once every part is there;
the server assembles the parts. Missing parts: `409 parts_missing`, `details: {"missing": [n, …]}`, nothing
changes. A repeat after success is `200`. The server does not decrypt or authenticate; it only checks
lengths. Gated by subscription and free space.

**`GET /blobs/{blob_id}`** → `200` and the bytes (`Content-Type: application/octet-stream`,
`Content-Length`, `Accept-Ranges: bytes`), or `206` with `Content-Range: bytes a-b/size` for
`Range: bytes=a-b`, `bytes=a-` or `bytes=-n`. A range outside the body is `416 range_not_satisfiable`
(with `Content-Range: bytes */size`). Several ranges or a malformed `Range` get the whole body. An
incomplete or unknown body is `404`. Download is not gated by subscription.

**`DELETE /blobs/{blob_id}`** → `204`. Drops one's own body that **no version refers to** (including an
unfinished one) and frees its bytes at once. A body a version refers to is `409 blob_exists`; unknown `404`.

**Orphans.** A body that no version refers to is deleted `orphan_blob_hours` (24 by default) after its last
action (creation, a part, `complete`); the same `blob_id` can then be started again.

### 3.12 Commits and the feed

#### Commit

**`POST /commit`**:

```json
{"commit_id": "<hex16>",
 "items": [{"item_id": "<hex16>", "base_version": 0, "header": "<hex>",
            "blob_id": "<hex16>" | null, "deleted": false}]}
```

- 1 to `max_commit_items` entries (empty is `400 bad_request`; too many `400 too_many_items`); the same
  `item_id` twice is `400 duplicate_item`.
- `base_version` 0 means "create"; the new version is always `base_version + 1`, assigned by the server.
- `header` is the envelope of 2.6: at least 301 and at most `max_header_bytes` bytes; the server does not
  parse it. `deleted` is a clear flag for cleanup (do not trust it on reading; the header decides).
- `blob_id` must be a **complete** body of **this** space, else `422 unknown_blob`. It is `null` for folders
  and for a deletion without a body. Several versions may refer to one body (a rename does not re-upload).
  A body named on a `deleted` entry is still required to exist, but the stored version has no body.
- **Atomic.** The commit is accepted only if **every** `base_version` equals the current version of its
  item (0 for an item that does not exist). Otherwise the whole commit is refused: `409 version_conflict`,
  `details: {"conflicts": [{"item_id", "base_version", "current_version"}]}` listing **all** conflicting
  items. Nothing is applied (no versions, no `seq`, no body references). Commits of one space are applied
  strictly one after another.
- **`commit_id` and replay.** An accepted commit is remembered with its answer. The same `commit_id` with
  the same content (judged by a digest of the item ids, base versions, headers, blob ids and flags) returns
  the earlier answer with `"replayed": true`, unchanged by later changes. The same `commit_id` with other
  content is `409 commit_id_reused`. A refused commit is not remembered, so it can be fixed and sent again
  with the same id.
- **Answer** `200 {"commit_id", "seq", "committed_ms", "replayed": false, "items": [{"item_id", "version"}]}`
  in request order. `seq` of a space starts at 0 and grows by exactly 1 per accepted commit (refusals and
  replays do not spend a number); all items of one commit share the `seq`.

Check order inside the commit's transaction: token and space re-checked; replay (answered even without a
subscription); subscription and deletions-only rule (3.15); free space (3.16); unknown or incomplete body
(`422`); body larger than the file limit (`413 blob_too_large` with `details`, the whole commit refused);
version conflicts (`409`); quota (`507 quota_exceeded`, `details: {"used_bytes", "limit_bytes",
"needed_bytes"}`). The quota is checked against the live bytes **after** the commit and refuses only a
commit that grows live bytes beyond the quota, so a commit that does not grow them (deletions, renames,
replacing with a smaller file) always passes.

#### Feed

**`GET /changes?since=C&limit=L`** returns the **compacted** feed: each item appears once, as its latest
version, at the `seq` of that version. A replaced version leaves the feed; earlier versions are visible
only through `versions` (3.14). So a client works from state, not from a log.

- `since` is a cursor: the `seq` of the last commit already received (default 0). `limit` defaults to 500
  and is capped at 1000 (a bigger number is capped, not an error). `since` that is not a non-negative
  integer, or `limit` that is not an integer ≥ 1, is `400 bad_request`.
- Answer `200`:

```json
{"instance_id": "<hex16>", "seq": 0, "since": 0, "next": 0, "more": false, "gap": false,
 "changes": [{"seq": 1, "item_id": "<hex16>", "version": 1, "header": "<hex>", "blob_id": "<hex16>" | null,
              "blob_size": 0 | null, "deleted": false, "device_id": "<hex16>", "committed_ms": 0}]}
```

- Entries are ordered by `seq`, and inside a commit in request order. **A page holds whole commits**: it
  takes commits while the total stays within `limit`, but always at least one, so a page can exceed `limit`
  by up to one commit (a renamed folder arrives together). `next` is the cursor for the next request;
  `more` says there is more. `seq` is the head of the feed.
- **Gap.** The server remembers `purged_seq`, the largest `seq` of a latest version among items removed
  whole by cleanup. When `since < purged_seq` the answer has `gap: true`: the client may have missed a
  deletion and must do a **full reconcile** (read from 0 and compare against local state). Removing a
  replaced (non-latest) version never causes a gap.
- A client must **verify** every entry: open the header with the right VK, space, item and version, and
  check consistency (for example the header's `version`, `body_id` against `blob_id`). Entries that fail
  are reported and skipped, with the cursor left before them; entries of a newer `format` are not applied.

### 3.13 Events (SSE)

`GET /events` with `Authorization` and `Accept: text/event-stream` answers `200`,
`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, and a stream:

```text
event: hello
data: {"seq": 12, "instance_id": "<hex16>"}

event: commit
id: 13
data: {"seq": 13, "device_id": "<hex16>", "items": 2}

: ping
```

`hello` comes right after connecting. Each accepted commit of the space sends `commit`. Every
`sse_keepalive_secs` (15) a comment line `: ping` is sent. Events carry no headers and no paths: they mean
only "check the feed". Missed events are not replayed (`Last-Event-ID` is ignored): after a break the client
reads the feed from its cursor. The server ends the stream when the device is disconnected (within one
keep-alive interval), when the space is deleted, and at shutdown. A silent connection for longer than a few
keep-alive intervals (the reference client uses 60 s) is dead. No token `401`; foreign space `404`.

### 3.14 Versions

**`GET /items/{item_id}/versions`** → `200 {"item_id", "versions": [{"item_id", "version", "seq", "header",
"blob_id", "blob_size", "deleted", "device_id", "committed_ms", "superseded_ms": N | null}]}`, newest first.
It includes every live version (the latest and earlier ones not yet cleaned up). An unknown item is `404`.
A client can restore an earlier version or a deleted file by downloading its body (`blob_id`) and opening
it with the header.

**Retention.** A replaced version lives until `superseded_ms + history_days` of the plan **in force at the
moment of replacement** (default `AMBY_SYNC_RETAIN_VERSION_DAYS`, 30). Lowering a plan does not shorten
the life of versions already replaced. The latest version of a live item is never removed. When the latest
version of an item is a deletion, the whole item (all versions and bodies) is removed `history_days` after
that commit, and `purged_seq` grows (a gap for readers behind it). A body is deleted when no live version
refers to it. If a plan has `max_history_bytes`, cleanup removes the oldest replaced versions and
deletions early until the user's history fits; latest versions are never touched. Cleanup runs every 10
minutes and before shutdown, and is idempotent.

### 3.15 Plans, quota and subscription

A **plan** (3.18) gives a user limits and a `sync` flag; which plan a user has is read from the database on
every request, so a change applies at once.

| Limit               | Where checked                                           | Refusal                                  |
| ------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `max_spaces`        | `POST /spaces`                                          | `403 space_limit` (+details)             |
| `max_file_bytes`    | `POST /blobs` (size), `POST /commit` (stored body size) | `413 blob_too_large` (+details)          |
| `max_total_bytes`   | `POST /blobs` (pre-check), `POST /commit` (exact)       | `507 quota_exceeded` (+details)          |
| `history_days`      | cleanup (3.14)                                          | none                                     |
| `max_history_bytes` | cleanup                                                 | none                                     |
| `sync: false`       | additions (below)                                       | `403 subscription_required` (no details) |

A reduction of a limit removes nothing: reads, deletions, renames and replacements by a smaller file keep
working; only growth is refused. Quota is the smaller of the plan's `max_total_bytes` and
`AMBY_SYNC_QUOTA_BYTES_PER_USER`; the file limit is the smaller of the plan's `max_file_bytes` and
`AMBY_SYNC_MAX_BLOB_BYTES`. `source` in a `413` says which one applied.

**Subscription.** A user whose effective plan has `sync: false` (no subscription) gets
`403 subscription_required` on the **adding** requests: `POST /spaces`, `POST …/blobs`, `PUT …/parts/{n}`,
`POST …/complete` and any `POST …/commit` with at least one entry that is not a pure deletion. Everything
else works: sign-in, recovery, keys, devices, the account name, `GET /account`, `GET /spaces`, the feed,
events, versions, downloads, `DELETE` of a body and of a space. A commit **of deletions only** is accepted
without a subscription when every entry is `deleted: true`, has no `blob_id` and deletes an **existing live
item**: `base_version` is at least 1 and equals the item's current version, which is not already a
deletion. Any other entry in such a commit (a new item, an already deleted one, a wrong version, any
non-deletion) refuses the whole commit with `403 subscription_required`. A replay of a commit accepted
earlier (same `commit_id`) is answered even without a subscription. Nothing is removed from the server when
a subscription ends; data stays until it is renewed or the user deletes it.

### 3.16 Server resource limits

- **Free disk space.** While the volume of the data directory has less than `AMBY_SYNC_MIN_FREE_BYTES`
  free, adding requests get `507 server_storage_full` (an ordinary error, no details): open registration,
  `POST /spaces`, `POST …/blobs`, `PUT …/parts/{n}`, `POST …/complete`, and a commit that has any
  non-deletion entry. Sign-in, reading, downloads, deletions-only commits, `DELETE` of a body and of a space
  keep working so that space can be freed. Retry later; do not treat it as a permanent plan limit. The free space is measured on Unix
  (Linux, macOS); on other systems the server treats it as enough.
- **Concurrent large bodies**: `503 server_busy` with `Retry-After: 5` (3.1). Retry after the delay.
- **Open registration cap**: `AMBY_SYNC_MAX_USERS` (3.5). Invitations are not limited.

### 3.17 Rate limiting

Sign-in guessing is limited by two counters over one list of failures. Unknown and invalid names are
counted like real ones, so a `429` never tells whether a name exists.

- **Failures**: `invalid_credentials` on `login` and `recover`; `invalid_enroll_code`,
  `enroll_code_expired` and, for open registration, `registration_unavailable` caused by a taken name on `enroll`;
  `invalid_proof` on `PUT /v1/keys` and `PUT /v1/account/username` (counted against the account's login).
- **Strict counter** — per pair (name, client address): `login_max_failures` (5) failures within
  `login_window_secs` (900) make the next attempt from that address for that name `429 rate_limited` with
  `Retry-After` in seconds. A success clears the strict count of that pair.
- **Loose counter** — per name from all addresses together: `login_max_failures_per_user` (50) within
  `login_window_per_user_secs` (3600) lock the name for everyone; a success does not clear it, it only ages
  out. Strict protects a victim from being locked out by an attacker who knows the name; loose stops
  guessing from many addresses.
- **Open registration counter**: attempts of open sign-up, including successful ones, are limited per
  address regardless of the name, with the same numbers as the strict counter. It never blocks invitations.
- **Client address** is the socket address. `X-Forwarded-For` (the last address of the list) is used only
  when `AMBY_SYNC_TRUST_PROXY=1`; behind a proxy without it every client shares one address.
- A refused attempt (`429`) is not itself counted. Counters older than their window are removed by cleanup.

### 3.18 Plans file

`AMBY_SYNC_PLANS_FILE` (default `<data dir>/plans.json`; no file means no plans: every user has an
unlimited virtual plan). The file is read when the server starts and is strict: an unknown field, a wrong
type, a zero, a repeated key, or a `default_plan` that is not among the plans refuses the start. A plan
name is `[a-z0-9_-]{1,32}`. All numbers are whole, in bytes, decimal, at least 1; a missing limit means
"no limit" except `history_days`, which then follows `AMBY_SYNC_RETAIN_VERSION_DAYS`. A user pinned to a
plan that is not in the file also refuses the start (`plans check` lists them).

```json
{
  "default_plan": "standard",
  "plans": {
    "standard": {
      "title": "Standard",
      "sync": true,
      "max_spaces": 1,
      "max_total_bytes": 1000000000,
      "max_file_bytes": 30416160,
      "history_days": 30,
      "max_history_bytes": 1000000000
    },
    "free": { "title": "Free", "sync": false },
    "unlimited": { "title": "No limits" }
  }
}
```

| Field               | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `title`             | label for people                                                           |
| `sync`              | `false` means no subscription (3.15); absent means `true`                  |
| `max_spaces`        | number of spaces                                                           |
| `max_total_bytes`   | sealed bytes of live and pending bodies of the user                        |
| `max_file_bytes`    | largest sealed body                                                        |
| `history_days`      | days replaced and deleted versions are kept                                |
| `max_history_bytes` | ceiling of the user's history; oldest versions are removed early beyond it |

A user without a pin has `default_plan` of the moment. A pin may carry an end (`--until`); after it passes,
the default plan acts, without rewriting the record.

## 4. Error codes

| HTTP | `code`                     | Meaning                                                                                          |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| 400  | `bad_request`              | not JSON, not an object, missing or malformed field, wrong content type, out-of-range parameters |
| 400  | `too_many_items`           | more than `max_commit_items` entries in a commit                                                 |
| 400  | `duplicate_item`           | the same item twice in one commit                                                                |
| 400  | `bad_part`                 | wrong part number or length                                                                      |
| 401  | `unauthorized`             | no token, unknown token                                                                          |
| 401  | `token_revoked`            | the token of a disconnected device                                                               |
| 401  | `invalid_credentials`      | wrong password or recovery code, unknown or invalid name, account without a password             |
| 401  | `invalid_enroll_code`      | wrong, used or unknown-name enrolment code                                                       |
| 401  | `enroll_code_expired`      | right code, older than its lifetime                                                              |
| 403  | `invalid_proof`            | wrong proof when changing keys or the account name                                               |
| 403  | `subscription_required`    | the plan does not allow sending changes (3.15)                                                   |
| 403  | `space_limit`              | the plan allows no more spaces; `details: {max_spaces, spaces}`                                  |
| 404  | `not_found`                | no such object, somebody else's object, malformed id, unknown path                               |
| 405  | `method_not_allowed`       | the path exists, the method does not                                                             |
| 409  | `version_conflict`         | a base version differs; the whole commit is refused; `details.conflicts`                         |
| 409  | `commit_id_reused`         | the same `commit_id` with other content                                                          |
| 409  | `keys_conflict`            | stale `base_keys_version`; `details.keys_version`                                                |
| 409  | `space_exists`             | a space with this id exists                                                                      |
| 409  | `blob_exists`              | body started with another size, already complete (part upload), or still referenced (delete)     |
| 409  | `parts_missing`            | `complete` before every part arrived; `details.missing`                                          |
| 409  | `registration_unavailable` | open sign-up: name taken or reserved, or the server is full                                      |
| 409  | `username_taken`           | the requested account name is in use                                                             |
| 409  | `username_conflict`        | the account name changed since the client read it                                                |
| 413  | `payload_too_large`        | a JSON request over its limit (64 KiB for `/v1/auth/*`, else `max_json_bytes`)                   |
| 413  | `blob_too_large`           | a body over the file limit; `details: {size, max_bytes, source}`                                 |
| 416  | `range_not_satisfiable`    | a byte range outside the body                                                                    |
| 422  | `unknown_blob`             | a commit names a body that is missing, incomplete or from another space                          |
| 429  | `rate_limited`             | too many failed attempts; `Retry-After` in seconds                                               |
| 500  | `internal`                 | server fault; details only in the server log                                                     |
| 501  | `not_implemented`          | reserved; the current server never sends it                                                      |
| 503  | `server_busy`              | too many large request bodies are being read; `Retry-After: 5`                                   |
| 507  | `quota_exceeded`           | the user's quota would be exceeded; `details: {used_bytes, limit_bytes, needed_bytes}`           |
| 507  | `server_storage_full`      | the server's disk is nearly full; adding is refused                                              |

Clients must tolerate codes they do not know (show a generic text) and unknown fields in `details`. The
client crate also uses local codes that never appear on the wire (`network`, `timeout`, `bad_response`,
`unsupported_server`, `cannot_decrypt`, `invalid_url`, `insecure_url`).

## 5. Running a server

The program is `amby-sync-server`. Data lives in `AMBY_SYNC_DATA_DIR`: a SQLite database and a `blobs/`
directory. The server speaks plain HTTP and is meant to sit behind a TLS reverse proxy. Unknown
`AMBY_SYNC_*` variables are ignored; a bad value of a known one (non-numeric, negative, or zero where zero
is not allowed) refuses the start. Flags accept `1`/`0` (also `true`/`false`).

### 5.1 Environment

| Variable                                | Default                 | Meaning                                                                                                               |
| --------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AMBY_SYNC_DATA_DIR`                    | `/data`                 | database and `blobs/`                                                                                                 |
| `AMBY_SYNC_LISTEN`                      | `0.0.0.0:8080`          | address and port                                                                                                      |
| `AMBY_SYNC_PUBLIC_URL`                  | `http://localhost:8080` | external address; must be `https://` unless the host is `localhost`, `127.0.0.1`, `[::1]` or `AMBY_SYNC_ALLOW_HTTP=1` |
| `AMBY_SYNC_ALLOW_HTTP`                  | `0`                     | allow `http://` for a non-local host (trusted network only)                                                           |
| `AMBY_SYNC_OPEN_REGISTRATION`           | `0`                     | allow account creation without an invitation                                                                          |
| `AMBY_SYNC_MAX_USERS`                   | unset                   | with open registration, stop at this many accounts (invitations are not limited)                                      |
| `AMBY_SYNC_MAX_BLOB_BYTES`              | `536870912`             | largest sealed body (ceiling over every plan)                                                                         |
| `AMBY_SYNC_MAX_COMMIT_ITEMS`            | `10000`                 | entries in one commit                                                                                                 |
| `AMBY_SYNC_MAX_HEADER_BYTES`            | `16384`                 | one header envelope                                                                                                   |
| `AMBY_SYNC_MAX_JSON_BYTES`              | `67108864`              | one JSON request (not `/v1/auth/*`, fixed at 64 KiB)                                                                  |
| `AMBY_SYNC_MAX_LARGE_BODIES`            | `4`                     | JSON bodies above 1 MiB read at once; more get `503 server_busy`                                                      |
| `AMBY_SYNC_MIN_FREE_BYTES`              | `1073741824`            | free bytes the data volume must keep; below it adding requests get `507`; `0` turns it off                            |
| `AMBY_SYNC_QUOTA_BYTES_PER_USER`        | unset (no quota)        | per-user ceiling on live + pending sealed bytes                                                                       |
| `AMBY_SYNC_PLANS_FILE`                  | `<data dir>/plans.json` | plans file (3.18)                                                                                                     |
| `AMBY_SYNC_RETAIN_VERSION_DAYS`         | `30`                    | history when a plan has no `history_days`                                                                             |
| `AMBY_SYNC_ORPHAN_BLOB_HOURS`           | `24`                    | life of a body no commit refers to, from its last action                                                              |
| `AMBY_SYNC_ENROLL_CODE_HOURS`           | `24`                    | life of an invitation code                                                                                            |
| `AMBY_SYNC_LOGIN_MAX_FAILURES`          | `5`                     | strict counter: failures per name and address (also the open-registration limit)                                      |
| `AMBY_SYNC_LOGIN_WINDOW_SECS`           | `900`                   | window of the strict counter                                                                                          |
| `AMBY_SYNC_LOGIN_MAX_FAILURES_PER_USER` | `50`                    | loose counter: failures per name from all addresses                                                                   |
| `AMBY_SYNC_LOGIN_WINDOW_PER_USER_SECS`  | `3600`                  | window of the loose counter                                                                                           |
| `AMBY_SYNC_TRUST_PROXY`                 | `0`                     | believe the last address of `X-Forwarded-For`                                                                         |
| `AMBY_SYNC_SSE_KEEPALIVE_SECS`          | `15`                    | seconds between `: ping` lines                                                                                        |

For a product limit of 30 000 000 bytes per file the matching sealed size is
`sealed_body_len(30 000 000) = 30 416 160`: set `AMBY_SYNC_MAX_BLOB_BYTES` (or a plan's `max_file_bytes`)
to at least that, otherwise a file of that size does not fit. The default ceiling is 512 MiB.

### 5.2 Commands

`amby-sync-server` with no command runs the server (`serve`). Commands act on the same data as a running
server. Names are folded to lower case.

| Command                                            | Effect                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serve`                                            | runs the server; cleanup every 10 minutes and before stopping; a broken plans file stops the start                                                                                         |
| `user add <name> [--plan <plan>] [--json]`         | creates the user and a one-time enrolment code; for a name without a password issues a new code and burns the old one. `--json` prints one line `{"username","enroll_code","expires_ms"}`  |
| `user list [--json]`                               | names, whether a password exists, code expiry, plan, pin end, `plan_expired`, used bytes                                                                                                   |
| `user plan set <name> <plan> [--until YYYY-MM-DD]` | pins the user to a plan; with `--until` access lasts through that day inclusive (until 00:00 UTC of the next day); without it the pin has no end; a past or malformed date changes nothing |
| `user plan set <name> --default`                   | removes the pin and its end                                                                                                                                                                |
| `user plan show <name> [--json]`                   | plan, own and effective limits, pin end, usage                                                                                                                                             |
| `user remove <name> --yes`                         | deletes the user, devices, spaces and bodies for good (without `--yes`: refused, exit 2); old tokens then give `401 unauthorized`; the name can be created again                           |
| `plans list [--json]`                              | plans of the file with the number of users on each                                                                                                                                         |
| `plans check [<file>]`                             | validates a plans file and the users pinned to plans it lacks                                                                                                                              |
| `space list <name> [--json]`                       | spaces of a user: `space_id`, creation date, live and history bytes (names stay encrypted)                                                                                                 |
| `space remove <name> <space_id> --yes`             | deletes a space for good; make a `backup` first                                                                                                                                            |
| `maintenance`                                      | one cleanup: bodies without a commit, old versions, deleted items, old codes and counters                                                                                                  |
| `backup <dir>`                                     | online copy of the database and bodies into an empty directory                                                                                                                             |
| `healthcheck`                                      | asks `/v1/info` on this machine; exit 0 when it answers `200`                                                                                                                              |

Exit codes: `0` success; `2` bad user name, unknown plan, bad option or date, or a missing `--yes`;
`3` `user add` for a name that already has a password; `1` anything else (no such user or space, I/O).
The enrolment code is printed only to standard output and is never logged; the database keeps only its
SHA-256. The server never logs tokens, keys, codes, wrapped keys or request bodies.

## 6. Limits and what clients must do

| Limit                      | Value                                                                | Client duty                                                                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entries per commit         | server `max_commit_items` (default 10 000)                           | the reference engine sends at most `min(max_commit_items, 1000)`                                                                                                                                                                                              |
| Size of one commit request | server `max_json_bytes` (default 64 MiB)                             | the reference engine keeps a commit to about 1 MiB of JSON (estimated from header hex and fixed fields); one entry is always sent, however large; for a folder rename the folder's own entry goes first, then the files, and a receiver must accept any order |
| Feed answer                | a page holds whole commits; one commit may be up to `max_json_bytes` | the reference client accepts a feed answer up to 96 MiB and any other answer up to 4 MiB; a larger answer is a bad-response error, not read into memory                                                                                                       |
| Header envelope            | 301 … `max_header_bytes` (default 16 384)                            | paths must keep the sealed header within it                                                                                                                                                                                                                   |
| File size, product limit   | 30 000 000 bytes of source file                                      | a larger file is not synchronised and the local file is kept (shown as "not synchronised")                                                                                                                                                                    |
| File size on the server    | sealed size ≤ `max_blob_bytes` / plan `max_file_bytes`               | compare `sealed_body_len(size)` (2.7), not the file size; 30 000 000 bytes seal to 30 416 160                                                                                                                                                                 |
| Body part                  | 8 388 608 bytes exactly (last one shorter)                           | upload parts, resume with `POST /blobs` (`uploaded`), then `complete`                                                                                                                                                                                         |
| Feed page                  | `limit` default 500, max 1000                                        | follow `next` while `more`                                                                                                                                                                                                                                    |
| Argon2id parameters        | table in 2.2                                                         | refuse out-of-range values before computing                                                                                                                                                                                                                   |
| Name envelopes             | exactly 105 bytes                                                    |                                                                                                                                                                                                                                                               |
| Wrapped keys               | exactly 73 bytes                                                     |                                                                                                                                                                                                                                                               |
| Auth request body          | 64 KiB                                                               |                                                                                                                                                                                                                                                               |

Rules every client must follow:

1. Check `/v1/info` first: `protocol` must contain 1; remember `instance_id` and stop when it changes.
2. Upload every body **before** the commit that names it; use a fresh `body_id`/`blob_id` per upload; send
   the commit with a new random `commit_id` and, after an ambiguous failure (timeout, dropped answer),
   retry with the **same** `commit_id` and content.
3. On `409 version_conflict`, read the feed, resolve against the newer versions, and commit again with the
   new base versions; nothing from the refused commit was applied.
4. Keep the feed cursor only after the page was verified; on `gap: true` do a full reconcile.
5. Never trust the `deleted` flag, `blob_size` or any server field over the decrypted, authenticated
   header; verify bodies against the header before using them (2.7).
6. Treat `403 subscription_required`, `403 space_limit`, `413 blob_too_large`, `507 quota_exceeded` as
   states to show the person, not as errors to retry blindly; treat `429`, `503` and `507
server_storage_full` as "retry later", honouring `Retry-After`.
7. Never put a token in a URL, never log tokens, keys or codes, and never follow a redirect to `http://`.
