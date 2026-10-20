"""Checks the reference implementation itself against the standards and basic laws.

The reference is only a trustworthy judge for the Rust code if its primitives agree with the
standards (docs/sync-plan.md, раздел 6). Run with `sync/reference/.venv/bin/python -m unittest`
from sync/reference.
"""

import json
import os
import unittest

import amby_ref as ref

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vectors")


def load(name):
    with open(os.path.join(VECTORS, name), encoding="utf-8") as handle:
        return json.load(handle)


class StandardsTest(unittest.TestCase):
    """Р6: the primitives of the reference match RFC 5869, the IRTF draft, BLAKE3 and FIPS 180."""

    @classmethod
    def setUpClass(cls):
        cls.std = load("standards.json")

    def test_hkdf_rfc5869(self):
        # Р5, Р6
        for case in self.std["hkdf_sha256_rfc5869"]["cases"]:
            got = ref.hkdf(bytes.fromhex(case["ikm"]), bytes.fromhex(case["info"]), case["len"], bytes.fromhex(case["salt"]))
            self.assertEqual(got.hex(), case["okm"], case["name"])

    def test_xchacha20poly1305_irtf(self):
        # Р6
        vec = self.std["xchacha20poly1305_irtf"]
        got = ref.xseal(
            bytes.fromhex(vec["key"]), bytes.fromhex(vec["nonce"]), bytes.fromhex(vec["aad"]), bytes.fromhex(vec["plaintext"])
        )
        self.assertEqual(got.hex(), vec["ciphertext"] + vec["tag"])

    def test_blake3_official(self):
        # Р6
        for case in self.std["blake3_official"]["cases"]:
            data = bytes(i % 251 for i in range(case["input_len"]))
            self.assertEqual(ref.blake3_hash(data).hex(), case["hash"], case["input_len"])

    def test_sha256_fips(self):
        # Р5
        for case in self.std["sha256_fips180"]["cases"]:
            self.assertEqual(ref.sha256(bytes.fromhex(case["input_hex"])).hex(), case["hash"])

    def test_padme_values(self):
        # Р6: Padmé of the paper's algorithm and its 12% bound
        for length, expected in self.std["padme"]["cases"]:
            self.assertEqual(ref.padme(length), expected, length)
        for length in range(2, 5000):
            self.assertLessEqual(ref.padme(length) - length, length * 0.12 + 1)


class LawsTest(unittest.TestCase):
    """Р5, Р6, О3: laws the format must obey, independent of any vector."""

    def test_recovery_code_roundtrip(self):
        # О3, Р5
        for seed in range(50):
            code = ref.sha256(bytes([seed]))
            parsed, error = ref.recovery_parse(ref.recovery_display(code))
            self.assertIsNone(error)
            self.assertEqual(parsed, code)

    def test_recovery_code_detects_any_single_typo(self):
        # О3
        code = ref.sha256(b"typo")
        shown = ref.recovery_display(code).replace("-", "")
        for i in range(56):
            other = ref.ALPHABET[(ref.ALPHABET.index(shown[i]) + 1) % 32]
            parsed, error = ref.recovery_parse(shown[:i] + other + shown[i + 1 :])
            self.assertIsNone(parsed, i)
            self.assertIsNotNone(error)

    def test_body_length_formula(self):
        # Р6: sealed length matches the layout of Ф21 and Ф26
        for size in (0, 1, 999, 65535, 65536, 65537, 200000):
            sealed = ref.seal_body(bytes(32), 1, bytes(16), bytes(size), bytes(19))
            self.assertEqual(len(sealed), ref.sealed_body_len(size))

    def test_header_padding_multiple_of_256(self):
        # Р6
        for n in (1, 255, 256, 257, 600):
            self.assertEqual(len(ref.pad_header(b"x" * n)) % 256, 0)


if __name__ == "__main__":
    unittest.main()
