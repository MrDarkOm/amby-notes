"""Independent reference implementation of the Amby sync byte format v1.

Written only from appendix А of docs/sync-plan.md ("Точный формат v1"); it must not be derived
from the Rust code. Primitives come from other libraries than the Rust ones: libsodium (PyNaCl),
argon2-cffi, blake3 and the standard library (hmac, hashlib). The decision numbers (Ф…) in the
comments refer to the appendix.
"""

import hashlib
import hmac
import json
import unicodedata

import blake3
import nacl.bindings as sodium
from argon2.low_level import Type, hash_secret_raw

VERSION = b"\x01"  # Ф4
MAGIC = b"AMBYBODY"
CHUNK = 65536  # Ф21
TAG = 16
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Ф27

# Ф10
INFO_AUTH = b"amby-sync/auth/1"
INFO_KEK = b"amby-sync/kek/1"
INFO_RECOVERY_AUTH = b"amby-sync/recovery-auth/1"
INFO_RECOVERY_KEK = b"amby-sync/recovery-kek/1"
INFO_HEADER_KEY = b"amby-sync/header-key/1"
INFO_BODY = b"amby-sync/body/1"
AAD_WRAP_AK = b"amby-sync/wrap-ak/1"  # Ф11
AAD_WRAP_VK = b"amby-sync/wrap-vk/1"  # Ф12
AAD_HEADER = b"amby-sync/header/1"  # Ф18
CHECK_PREFIX = b"amby-sync/recovery-check/1"  # Ф29

DEFAULT_PARAMS = {"memory_kib": 65536, "iterations": 3, "parallelism": 4}  # Ф7


def u32(n):
    return n.to_bytes(4, "big")


def u64(n):
    return n.to_bytes(8, "big")


def sha256(data):
    return hashlib.sha256(data).digest()


# --- primitives ------------------------------------------------------------------------------


def hkdf(ikm, info, length=32, salt=b""):
    """RFC 5869, SHA-256; an empty salt is HashLen zeros (Ф9)."""
    prk = hmac.new(salt if salt else bytes(32), ikm, hashlib.sha256).digest()
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def xseal(key, nonce, aad, plaintext):
    return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, nonce, key)


def blake3_hash(data):
    return blake3.blake3(data).digest()


def padme(length):
    """Ф26."""
    if length < 2:
        return length
    e = length.bit_length() - 1  # floor(log2 L)
    s = e.bit_length()  # floor(log2 E) + 1
    mask = (1 << (e - s)) - 1
    return (length + mask) & ~mask


# --- password and recovery code --------------------------------------------------------------


def master_key(password, salt, params):
    """Ф6, Ф7: NFKC, UTF-8, Argon2id v0x13, 32 bytes, no secret, no associated data."""
    return hash_secret_raw(
        secret=unicodedata.normalize("NFKC", password).encode("utf-8"),
        salt=salt,
        time_cost=params["iterations"],
        memory_cost=params["memory_kib"],
        parallelism=params["parallelism"],
        hash_len=32,
        type=Type.ID,
        version=19,
    )


def password_keys(password, salt, params):
    master = master_key(password, salt, params)
    return {
        "master_key": master,
        "auth_key": hkdf(master, INFO_AUTH),
        "kek": hkdf(master, INFO_KEK),
    }


def recovery_keys(code):
    return {
        "auth_key": hkdf(code, INFO_RECOVERY_AUTH),
        "kek": hkdf(code, INFO_RECOVERY_KEK),
    }


def _bits_to_symbols(bits):
    return "".join(ALPHABET[int(bits[i : i + 5], 2)] for i in range(0, len(bits), 5))


def recovery_display(code):
    """Ф28–Ф30."""
    bits = "".join(f"{byte:08b}" for byte in code)  # 256 bits
    bits += "0000"  # 260 bits: 52 symbols, the last holds one data bit
    checksum = "".join(f"{byte:08b}" for byte in sha256(CHECK_PREFIX + code)[:3])[:20]
    symbols = _bits_to_symbols(bits) + _bits_to_symbols(checksum)
    assert len(symbols) == 56
    return "-".join(symbols[i : i + 4] for i in range(0, 56, 4))


def recovery_parse(text):
    """Ф30. Returns (code, None) or (None, error name)."""
    cleaned = "".join(ch for ch in text if not ch.isspace() and ch != "-").upper()
    cleaned = cleaned.replace("O", "0").replace("I", "1").replace("L", "1")
    if any(ch not in ALPHABET for ch in cleaned):
        return None, "BadSymbol"
    if len(cleaned) != 56:
        return None, "BadLength"
    bits = "".join(f"{ALPHABET.index(ch):05b}" for ch in cleaned[:52])
    if bits[256:] != "0000":
        return None, "BadPadding"
    code = int(bits[:256], 2).to_bytes(32, "big")
    if recovery_display(code).replace("-", "")[52:] != cleaned[52:]:
        return None, "BadChecksum"
    return code, None


# --- wrapping of AK and VK -------------------------------------------------------------------


def wrap_account_key(kek, ak, nonce):
    """Ф11, Ф13."""
    return VERSION + nonce + xseal(kek, nonce, AAD_WRAP_AK, ak)


def wrap_space_key(ak, space_id, epoch, vk, nonce):
    """Ф12, Ф13."""
    return VERSION + nonce + xseal(ak, nonce, AAD_WRAP_VK + space_id + u32(epoch), vk)


class Draw:
    """A deterministic source of 'random' bytes that records the stream (Ф31)."""

    def __init__(self, seed):
        self.seed = seed
        self.counter = 0
        self.buffer = b""
        self.stream = b""

    def take(self, count):
        while len(self.buffer) < count:
            block = sha256(b"amby-sync/vectors/" + self.seed.encode() + u32(self.counter))
            self.counter += 1
            self.buffer += block
        out, self.buffer = self.buffer[:count], self.buffer[count:]
        self.stream += out
        return out


def password_envelope(password, ak, params, draw):
    """Ф31: salt (16), then the nonce (24)."""
    salt = draw.take(16)
    keys = password_keys(password, salt, params)
    nonce = draw.take(24)
    return {
        "salt": salt,
        "auth_key": keys["auth_key"],
        "wrapped_account_key": wrap_account_key(keys["kek"], ak, nonce),
    }


def create_account(password, params, draw):
    """Ф31: salt, AK, nonce, recovery code, nonce."""
    salt = draw.take(16)
    ak = draw.take(32)
    keys = password_keys(password, salt, params)
    nonce1 = draw.take(24)
    code = draw.take(32)
    nonce2 = draw.take(24)
    recovery = recovery_keys(code)
    return {
        "salt": salt,
        "auth_key": keys["auth_key"],
        "wrapped_account_key": wrap_account_key(keys["kek"], ak, nonce1),
        "account_key": ak,
        "recovery_code": code,
        "recovery_auth_key": recovery["auth_key"],
        "wrapped_account_key_recovery": wrap_account_key(recovery["kek"], ak, nonce2),
    }


# --- header ----------------------------------------------------------------------------------


def canonical_json(obj):
    """Ф15: sorted keys (code point order = UTF-8 byte order), no spaces, minimal escapes."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def pad_header(raw):
    """Ф17."""
    return raw + bytes(-len(raw) % 256)


def header_aad(space_id, item_id, epoch, version):
    """Ф18."""
    return AAD_HEADER + space_id + item_id + u32(epoch) + u64(version)


def header_envelope(vk, epoch, space_id, item_id, version, plaintext, nonce, envelope_version=VERSION):
    """Ф18. `plaintext` is already padded; negative vectors pass other plaintexts."""
    key = hkdf(vk, INFO_HEADER_KEY)
    aad = header_aad(space_id, item_id, epoch, version)
    return envelope_version + u32(epoch) + nonce + xseal(key, nonce, aad, plaintext)


def seal_header(vk, epoch, space_id, item_id, header, nonce):
    return header_envelope(vk, epoch, space_id, item_id, header["version"], pad_header(canonical_json(header)), nonce)


# --- body ------------------------------------------------------------------------------------


def body_key(vk, body_id):
    """Ф20."""
    return hkdf(vk, INFO_BODY + body_id)


def seal_body(vk, epoch, body_id, content, prefix, *, padding=None, last_flag=True, version=VERSION, magic=MAGIC):
    """Ф20–Ф24. `padding` overrides the zero padding (negative vectors)."""
    padded_len = padme(len(content))
    pad = padding if padding is not None else bytes(padded_len - len(content))
    plain = content + pad
    preamble = magic + version + u32(epoch) + prefix
    key = body_key(vk, body_id)
    count = max(1, -(-len(plain) // CHUNK))
    out = preamble
    for i in range(count):
        chunk = plain[i * CHUNK : (i + 1) * CHUNK]
        last = i == count - 1
        flag = b"\x01" if (last and last_flag) else b"\x00"
        nonce = prefix + u32(i) + flag
        out += xseal(key, nonce, preamble, chunk)
    return out


def sealed_body_len(size):
    """Ф26."""
    padded = padme(size)
    return 32 + padded + TAG * max(1, -(-padded // CHUNK))
