"""Generates sync/vectors/format-v1.json with the reference implementation (amby_ref.py).

Run `npm run sync:reference:vectors`. The output is deterministic: every "random" byte comes from
a seeded hash stream, and the stream is written into the vector so that the Rust tests can feed
it back in the same order (appendix А, Ф31). CI regenerates the file and fails on any difference.
"""

import json
import os
import unicodedata

import amby_ref as ref

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vectors", "format-v1.json")


def det(label, count):
    return ref.sha256(b"amby-sync/vectors/bytes/" + label.encode())[:count] if count <= 32 else b"".join(
        ref.sha256(b"amby-sync/vectors/bytes/" + label.encode() + bytes([i])) for i in range(-(-count // 32))
    )[:count]


def hx(data):
    return data.hex()


def pattern(length):
    return bytes((i * 31 + 7) % 256 for i in range(length))


def header(version, kind, path, size, mtime_ms, content_hash, body_id, deleted=False, extra=None):
    obj = {
        "format": 1,
        "version": version,
        "kind": kind,
        "path": path,
        "size": size,
        "mtime_ms": mtime_ms,
        "content_hash": hx(content_hash) if content_hash is not None else None,
        "body_id": hx(body_id) if body_id is not None else None,
        "deleted": deleted,
    }
    obj.update(extra or {})
    return obj


# --- password keys ---------------------------------------------------------------------------

PASSWORDS = [
    ("ascii", "correct horse battery staple"),
    ("unicode_nfc", "pässwörd éè ☃ 日本語"),
    ("long", "x" * 200 + " — end"),
]


def password_keys_vectors():
    cases = []
    for name, password in PASSWORDS:
        salt = det("salt/" + name, 16)
        keys = ref.password_keys(password, salt, ref.DEFAULT_PARAMS)
        cases.append(
            {
                "name": name,
                "password": password,
                "salt": hx(salt),
                **ref.DEFAULT_PARAMS,
                "master_key": hx(keys["master_key"]),
                "auth_key": hx(keys["auth_key"]),
                "kek": hx(keys["kek"]),
                "auth_key_hash": hx(ref.sha256(keys["auth_key"])),
            }
        )
    # Ф6: the same password in NFD gives the same key as in NFC.
    nfd = unicodedata.normalize("NFD", PASSWORDS[1][1])
    assert nfd != PASSWORDS[1][1]
    cases.append({**cases[1], "name": "unicode_nfd_same_as_nfc", "password": nfd})
    # Ф7: parameters above the defaults are valid and change the key.
    params = {"memory_kib": 65536, "iterations": 4, "parallelism": 4}
    salt = det("salt/more_passes", 16)
    keys = ref.password_keys("correct horse battery staple", salt, params)
    cases.append(
        {
            "name": "more_passes",
            "password": "correct horse battery staple",
            "salt": hx(salt),
            **params,
            "master_key": hx(keys["master_key"]),
            "auth_key": hx(keys["auth_key"]),
            "kek": hx(keys["kek"]),
            "auth_key_hash": hx(ref.sha256(keys["auth_key"])),
        }
    )
    return cases


# --- recovery code ---------------------------------------------------------------------------


def recovery_vectors():
    codes = [bytes(32), bytes([0xFF] * 32), det("code/a", 32), det("code/b", 32)]
    keys = []
    for code in codes:
        rk = ref.recovery_keys(code)
        keys.append(
            {
                "code": hx(code),
                "display": ref.recovery_display(code),
                "recovery_auth_key": hx(rk["auth_key"]),
                "recovery_kek": hx(rk["kek"]),
            }
        )
    valid = []
    for code in codes:
        shown = ref.recovery_display(code)
        valid.append({"text": shown, "code": hx(code)})
    shown = ref.recovery_display(codes[2])
    flat = shown.replace("-", "")
    # Tolerant forms (Ф30): lower case, no separators, spaces, Crockford look-alikes.
    valid.append({"text": shown.lower(), "code": hx(codes[2])})
    valid.append({"text": flat, "code": hx(codes[2])})
    valid.append({"text": " ".join(shown.split("-")), "code": hx(codes[2])})
    valid.append({"text": "\n" + shown + "\n", "code": hx(codes[2])})
    zero_shown = ref.recovery_display(bytes(32))
    valid.append({"text": zero_shown.replace("0", "O"), "code": hx(bytes(32))})
    invalid = []

    def bad(text, error):
        parsed, got = ref.recovery_parse(text)
        assert parsed is None and got == error, (text, got, error)
        invalid.append({"text": text, "error": error})

    last = flat[-1]
    wrong_last = ALPHA_NEXT(last)
    bad(flat[:-1] + wrong_last, "BadChecksum")  # one typo in the checksum
    first = flat[0]
    bad(ALPHA_NEXT(first) + flat[1:], "BadChecksum")  # one typo in the data
    bad(flat[:-1], "BadLength")
    bad(flat + "0", "BadLength")
    bad(flat[:10] + "U" + flat[11:], "BadSymbol")
    bad(flat[:10] + "!" + flat[11:], "BadSymbol")
    bad("", "BadLength")
    # Ф28: the four padding bits of the 52nd symbol must be zero, the checksum is then still
    # consistent with the code, so this is rejected for the padding, not the checksum.
    bits = "".join(f"{b:08b}" for b in codes[2]) + "0001"
    sym = ref._bits_to_symbols(bits)
    check = ref._bits_to_symbols("".join(f"{b:08b}" for b in ref.sha256(ref.CHECK_PREFIX + codes[2])[:3])[:20])
    bad(sym + check, "BadPadding")
    return {"keys": keys, "valid": valid, "invalid": invalid}


def ALPHA_NEXT(ch):
    """Another symbol that is not a Crockford look-alike of `ch`."""
    return ref.ALPHABET[(ref.ALPHABET.index(ch) + 1) % 32]


# --- wrapping --------------------------------------------------------------------------------


def wrap_vectors():
    ak_cases, vk_cases = [], []
    for i in range(2):
        kek, ak, nonce = det(f"wrapak/kek{i}", 32), det(f"wrapak/ak{i}", 32), det(f"wrapak/nonce{i}", 24)
        ak_cases.append(
            {"kek": hx(kek), "account_key": hx(ak), "random": hx(nonce), "wrapped": hx(ref.wrap_account_key(kek, ak, nonce))}
        )
    for i, epoch in enumerate((1, 2)):
        ak, space, vk, nonce = (det(f"wrapvk/{n}{i}", c) for n, c in (("ak", 32), ("space", 16), ("vk", 32), ("nonce", 24)))
        vk_cases.append(
            {
                "account_key": hx(ak),
                "space_id": hx(space),
                "epoch": epoch,
                "space_key": hx(vk),
                "random": hx(nonce),
                "wrapped": hx(ref.wrap_space_key(ak, space, epoch, vk, nonce)),
            }
        )
    return ak_cases, vk_cases


def account_vectors():
    cases = []
    for name, password in PASSWORDS[:2]:
        draw = ref.Draw("account/" + name)
        out = ref.create_account(password, ref.DEFAULT_PARAMS, draw)
        cases.append(
            {
                "name": name,
                "password": password,
                **ref.DEFAULT_PARAMS,
                "random": hx(draw.stream),
                "salt": hx(out["salt"]),
                "auth_key": hx(out["auth_key"]),
                "wrapped_account_key": hx(out["wrapped_account_key"]),
                "account_key": hx(out["account_key"]),
                "recovery_code": hx(out["recovery_code"]),
                "recovery_display": ref.recovery_display(out["recovery_code"]),
                "recovery_auth_key": hx(out["recovery_auth_key"]),
                "wrapped_account_key_recovery": hx(out["wrapped_account_key_recovery"]),
            }
        )
    # Reset with the recovery code (Р5): new salt and nonce, the same AK.
    first = cases[0]
    ak = bytes.fromhex(first["account_key"])
    draw = ref.Draw("reset/ascii")
    env = ref.password_envelope("a brand new passphrase", ak, ref.DEFAULT_PARAMS, draw)
    reset = {
        "recovery_code": first["recovery_code"],
        "wrapped_by_recovery": first["wrapped_account_key_recovery"],
        "new_password": "a brand new passphrase",
        **ref.DEFAULT_PARAMS,
        "random": hx(draw.stream),
        "account_key": first["account_key"],
        "salt": hx(env["salt"]),
        "auth_key": hx(env["auth_key"]),
        "wrapped_account_key": hx(env["wrapped_account_key"]),
    }
    return cases, reset


# --- headers ---------------------------------------------------------------------------------


def sample_headers():
    body = det("hdr/body", 16)
    content_hash = ref.blake3_hash(b"hello")
    return [
        (
            "file",
            header(3, "file", "Notes/Идея.md", 5, 1760000000000, content_hash, body),
        ),
        ("folder", header(1, "folder", "Notes/Empty", 0, 1760000000001, None, None)),
        (
            "escapes_and_unknown_fields",
            header(
                12,
                "file",
                'a "q" \\ b\tc\u0001d \u007f   \U0001f600.md',
                0,
                -5,
                ref.blake3_hash(b""),
                body,
                False,
                {
                    "zeta": {"b": [1, 2, {"y": None, "x": True}], "a": -7},
                    "\U0001f600": 1,
                    "￿": 2,
                    "é": 3,
                    "alpha": "text",
                },
            ),
        ),
        ("deleted", header(9, "file", "gone.md", 0, 0, None, None, True)),
        (
            "long_path_second_block",
            header(2, "file", "/".join(["segment-%02d" % i for i in range(20)]) + "/note.md", 10, 1, ref.blake3_hash(b"x"), body),
        ),
    ]


def header_json_vectors():
    out = []
    for name, obj in sample_headers():
        raw = ref.canonical_json(obj)
        out.append({"name": name, "header": obj, "canonical_hex": hx(raw), "padded_len": len(ref.pad_header(raw))})
    return out


def header_envelope_vectors():
    out = []
    space, item = det("env/space", 16), det("env/item", 16)
    for i, (name, obj) in enumerate(sample_headers()):
        epoch = 2 if name == "folder" else 1
        vk, nonce = det(f"env/vk{epoch}", 32), det(f"env/nonce{i}", 24)
        out.append(
            {
                "name": name,
                "space_key": hx(vk),
                "epoch": epoch,
                "space_id": hx(space),
                "item_id": hx(item),
                "version": obj["version"],
                "header": obj,
                "random": hx(nonce),
                "envelope": hx(ref.seal_header(vk, epoch, space, item, obj, nonce)),
            }
        )
    return out


def header_negative_vectors():
    space, item = det("neg/space", 16), det("neg/item", 16)
    vk = det("neg/vk", 32)
    nonce = det("neg/nonce", 24)
    body = det("neg/body", 16)
    base = header(5, "file", "Notes/a.md", 5, 1, ref.blake3_hash(b"hello"), body)
    raw = ref.canonical_json(base)
    out = []

    def add(name, plaintext, error, version=5, envelope_version=ref.VERSION):
        env = ref.header_envelope(vk, 1, space, item, version, plaintext, nonce, envelope_version)
        out.append(
            {
                "name": name,
                "space_key": hx(vk),
                "epoch": 1,
                "space_id": hx(space),
                "item_id": hx(item),
                "version": version,
                "envelope": hx(env),
                "error": error,
            }
        )

    padded = ref.pad_header(raw)
    # Ф17: the padding must be a multiple of 256 and consist of zeros only.
    add("not_multiple_of_256", raw, "BadPadding")
    add("empty_plaintext", b"", "BadPadding")
    add("nonzero_padding_byte", padded[:-1] + b"\x01", "Malformed")
    # Ф19: version inside the JSON differs from the version the envelope is opened for.
    add("inner_version_differs", ref.pad_header(ref.canonical_json({**base, "version": 4})), "VersionMismatch")
    # Ф19, Р13: a newer format is not understood and not rewritten.
    add("format_newer", ref.pad_header(ref.canonical_json({**base, "format": 2})), "UnsupportedFormat")
    # Ф19: a path in NFD is rejected.
    add(
        "path_not_nfc",
        ref.pad_header(ref.canonical_json({**base, "path": unicodedata.normalize("NFD", "Notes/é.md")})),
        "PathNotNfc",
    )
    # Ф4: another envelope version.
    add("envelope_version_2", padded, "UnsupportedVersion", envelope_version=b"\x02")
    # Ф14, Ф15: malformed contents.
    add("not_json", ref.pad_header(b"{"), "Malformed")
    add("missing_path", ref.pad_header(ref.canonical_json({k: v for k, v in base.items() if k != "path"})), "Malformed")
    add("unknown_kind", ref.pad_header(ref.canonical_json({**base, "kind": "symlink"})), "Malformed")
    add("negative_size", ref.pad_header(ref.canonical_json({**base, "size": -1})), "Malformed")
    add("uppercase_hash", ref.pad_header(ref.canonical_json({**base, "content_hash": base["content_hash"].upper()})), "Malformed")
    add("short_body_id", ref.pad_header(ref.canonical_json({**base, "body_id": base["body_id"][:30]})), "Malformed")
    add("fractional_number", ref.pad_header(raw[:-1] + b',"fraction":1.5}'), "Malformed")
    add("not_an_object", ref.pad_header(b"[1,2]"), "Malformed")
    return out


# --- body ------------------------------------------------------------------------------------

BOM_CRLF = b"\xef\xbb\xbf# Title\r\n\r\nLine with trailing space \r\nlast line without newline"


def body_content(spec):
    if spec["kind"] == "hex":
        return bytes.fromhex(spec["hex"])
    return pattern(spec["len"])


def body_vectors():
    vk, epoch = det("body/vk", 32), 1
    specs = [
        ("empty", {"kind": "pattern", "len": 0}),
        ("one_byte", {"kind": "pattern", "len": 1}),
        ("bom_crlf", {"kind": "hex", "hex": hx(BOM_CRLF)}),
        ("thousand", {"kind": "pattern", "len": 1000}),
        ("just_below_chunk", {"kind": "pattern", "len": 65535}),
        ("exact_chunk", {"kind": "pattern", "len": 65536}),
        ("two_chunks", {"kind": "pattern", "len": 65537}),
        ("three_chunks", {"kind": "pattern", "len": 140000}),
    ]
    out = []
    for name, spec in specs:
        content = body_content(spec)
        body_id, prefix = det("body/id/" + name, 16), det("body/prefix/" + name, 19)
        sealed = ref.seal_body(vk, epoch, body_id, content, prefix)
        assert len(sealed) == ref.sealed_body_len(len(content))
        item = {
            "name": name,
            "space_key": hx(vk),
            "epoch": epoch,
            "body_id": hx(body_id),
            "content": spec,
            "size": len(content),
            "content_hash": hx(ref.blake3_hash(content)),
            "random": hx(prefix),
            "sealed_len": len(sealed),
            "sealed_sha256": hx(ref.sha256(sealed)),
        }
        if len(sealed) <= 70000:
            item["sealed"] = hx(sealed)
        out.append(item)
    return out


def body_negative_vectors():
    vk = det("bodyneg/vk", 32)
    content = pattern(1000)
    size = len(content)
    content_hash = ref.blake3_hash(content)
    body_id, prefix = det("bodyneg/id", 16), det("bodyneg/prefix", 19)
    out = []

    def add(name, sealed, error, epoch=1, size=size, content_hash=content_hash):
        out.append(
            {
                "name": name,
                "space_key": hx(vk),
                "epoch": epoch,
                "body_id": hx(body_id),
                "size": size,
                "content_hash": hx(content_hash),
                "sealed": hx(sealed),
                "error": error,
            }
        )

    padlen = ref.padme(size) - size
    assert padlen > 0
    # Ф22: padding must be zeros.
    add("padding_not_zero", ref.seal_body(vk, 1, body_id, content, prefix, padding=bytes(padlen - 1) + b"\x01"), "PaddingNotZero")
    # Ф22: the decrypted length must be padme(size).
    add("length_is_not_padme", ref.seal_body(vk, 1, body_id, content, prefix, padding=b""), "LengthMismatch")
    add("padding_too_long", ref.seal_body(vk, 1, body_id, content, prefix, padding=bytes(padlen + 64)), "LengthMismatch")
    # Ф22: the last chunk must carry the last flag (a truncated stream looks like this).
    add("last_chunk_not_flagged", ref.seal_body(vk, 1, body_id, content, prefix, last_flag=False), "Authentication")
    # Ф25: the epoch of the preamble differs from the epoch of the key.
    add("epoch_in_body_differs", ref.seal_body(vk, 2, body_id, content, prefix), "EpochMismatch", epoch=1)
    # Ф4, Ф23: version and magic are checked before decryption.
    add("body_version_2", ref.seal_body(vk, 1, body_id, content, prefix, version=b"\x02"), "UnsupportedVersion")
    add("bad_magic", ref.seal_body(vk, 1, body_id, content, prefix, magic=b"AMBYBOD2"), "Malformed")
    # Ф22: the header may claim other values than the body holds.
    good = ref.seal_body(vk, 1, body_id, content, prefix)
    add("claimed_size_in_same_block", good, "HashMismatch", size=size + 1)
    add("claimed_hash_differs", good, "HashMismatch", content_hash=ref.blake3_hash(b"other"))
    add("claimed_size_other_block", good, "LengthMismatch", size=size + 100)
    return out


def main():
    wrap_ak, wrap_vk = wrap_vectors()
    accounts, reset = account_vectors()
    doc = {
        "format": 1,
        "generator": "sync/reference/generate_vectors.py (independent reference, docs/sync-plan.md appendix А)",
        "password_keys": password_keys_vectors(),
        "recovery": recovery_vectors(),
        "wrap_account_key": wrap_ak,
        "wrap_space_key": wrap_vk,
        "create_account": accounts,
        "reset_password": reset,
        "header_json": header_json_vectors(),
        "header_envelope": header_envelope_vectors(),
        "header_negative": header_negative_vectors(),
        "body": body_vectors(),
        "body_negative": body_negative_vectors(),
    }
    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(doc, handle, indent=1, ensure_ascii=True)
        handle.write("\n")
    print("wrote", os.path.relpath(OUT))


if __name__ == "__main__":
    main()
