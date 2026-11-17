// Official module-package signing key: generation, Keychain storage and loading.
//
// The private key is a PKCS8 DER Ed25519 key written as 96 lowercase hex characters.
// It lives ONLY in the macOS Keychain (service `amby-module-signing`, account = key id)
// or, for CI, in the secret environment variable AMBY_MODULE_SIGNING_KEY. It must never
// be printed, logged, committed or passed through chat; nothing in this file prints it.
//
// The public half (raw 32 bytes, 64 hex characters) is what the app trusts:
// OFFICIAL_ED25519_PUBLIC_KEY_HEX in src-tauri/src/package_manager.rs and
// src/lib/modules/package-manager/validator.ts. See docs/security-advisories.md (MOD-01).

import { execFileSync, spawnSync } from "node:child_process"
import { Buffer } from "node:buffer"
import crypto from "node:crypto"
import process from "node:process"

// The single place that names the current official key id. Keep it equal to
// OFFICIAL_ED25519_KEY_ID in package_manager.rs and validator.ts (a test checks it).
export const OFFICIAL_KEY_ID = "amby-official-2026-11"
export const KEYCHAIN_SERVICE = "amby-module-signing"
export const SIGNING_KEY_ENV = "AMBY_MODULE_SIGNING_KEY"

const PKCS8_HEX = /^[0-9a-f]{96}$/
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420"

/** Generates a key pair: `privateKeyHex` (PKCS8 DER) stays secret, `publicKeyHex` is raw. */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const privateKeyHex = privateKey.export({ format: "der", type: "pkcs8" }).toString("hex")
  const publicKeyHex = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex")
  return { privateKeyHex, publicKeyHex }
}

export function isValidPrivateKeyHex(value) {
  return (
    typeof value === "string" && PKCS8_HEX.test(value) && value.startsWith(PKCS8_ED25519_PREFIX)
  )
}

/** Raw public key (hex) matching a PKCS8 private key. */
export function publicKeyHexFromPrivate(privateKeyHex) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  })
  return crypto
    .createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32)
    .toString("hex")
}

/** Removes any occurrence of the secret from text that may be shown. */
export function redact(text, secret) {
  return secret ? String(text).split(secret).join("[redacted]") : String(text)
}

/** Default Keychain access through the `security` tool; replaceable in tests. */
export const macKeychain = {
  exists(account) {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account],
      {
        stdio: "pipe",
      },
    )
    return result.status === 0
  },
  read(account) {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
      ).trim()
    } catch {
      return null
    }
  },
  // `security -i` reads the command from stdin, so the secret never appears in argv.
  write(account, secret) {
    const result = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${secret}\n`,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    })
    const failed = result.status !== 0 || /error|failed|already exists/i.test(result.stderr ?? "")
    return { ok: !failed, message: redact(`${result.stderr ?? ""}`.trim(), secret) }
  },
}

/**
 * Creates and stores a new signing key. Refuses to overwrite an existing entry
 * unless `replace` is set. Returns only public information.
 */
export function createSigningKey({
  keychain = macKeychain,
  keyId = OFFICIAL_KEY_ID,
  replace = false,
} = {}) {
  if (keychain.exists(keyId) && !replace) {
    throw new Error(
      `A signing key "${keyId}" already exists in the Keychain. Pass --replace to overwrite it ` +
        "(packages signed with the old key stop verifying).",
    )
  }
  const { privateKeyHex, publicKeyHex } = generateKeyPair()
  const stored = keychain.write(keyId, privateKeyHex)
  if (!stored.ok) {
    throw new Error(`Could not store the key in the Keychain: ${stored.message || "unknown error"}`)
  }
  if (keychain.read(keyId) !== privateKeyHex) {
    throw new Error(
      "The Keychain entry could not be read back; the new key was not stored reliably.",
    )
  }
  return { keyId, publicKeyHex }
}

/** The signing key for builds: the CI variable first, then the Keychain. */
export function loadSigningKeyHex({
  env = process.env,
  keychain = macKeychain,
  keyId = OFFICIAL_KEY_ID,
} = {}) {
  const fromEnv = (env[SIGNING_KEY_ENV] ?? "").trim()
  const value = fromEnv || keychain.read(keyId)
  if (!value) {
    throw new Error(
      `No module signing key. Set ${SIGNING_KEY_ENV} (CI) or create one in the macOS Keychain with ` +
        "`npm run modules:new-key` (service amby-module-signing, account " +
        `${keyId}).`,
    )
  }
  if (!isValidPrivateKeyHex(value)) {
    throw new Error("The module signing key is not a valid Ed25519 PKCS8 hex key.")
  }
  return value
}
