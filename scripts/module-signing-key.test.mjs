import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  OFFICIAL_KEY_ID,
  SIGNING_KEY_ENV,
  createSigningKey,
  generateKeyPair,
  isValidPrivateKeyHex,
  loadSigningKeyHex,
  publicKeyHexFromPrivate,
} from "./module-signing-key.mjs"
import { run } from "./rotate-module-key.mjs"

const ROOT = join(fileURLToPath(import.meta.url), "..", "..")

function fakeKeychain(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    exists: (account) => store.has(account),
    read: (account) => store.get(account) ?? null,
    write: (account, secret) => {
      store.set(account, secret)
      return { ok: true, message: "" }
    },
  }
}

test("generated key pair is consistent and well formed", () => {
  const { privateKeyHex, publicKeyHex } = generateKeyPair()
  assert.ok(isValidPrivateKeyHex(privateKeyHex))
  assert.match(publicKeyHex, /^[0-9a-f]{64}$/)
  assert.equal(publicKeyHexFromPrivate(privateKeyHex), publicKeyHex)
})

test("key id matches the Rust and TypeScript trust anchors", () => {
  for (const file of [
    "src-tauri/src/package_manager.rs",
    "src/lib/modules/package-manager/validator.ts",
  ]) {
    assert.ok(readFileSync(join(ROOT, file), "utf8").includes(`"${OFFICIAL_KEY_ID}"`), file)
  }
})

test("createSigningKey stores the key and returns only public data", () => {
  const keychain = fakeKeychain()
  const result = createSigningKey({ keychain })
  assert.deepEqual(Object.keys(result).sort(), ["keyId", "publicKeyHex"])
  const stored = keychain.store.get(OFFICIAL_KEY_ID)
  assert.equal(publicKeyHexFromPrivate(stored), result.publicKeyHex)
  assert.ok(!JSON.stringify(result).includes(stored))
})

test("createSigningKey refuses to overwrite without --replace", () => {
  const keychain = fakeKeychain({ [OFFICIAL_KEY_ID]: "existing" })
  assert.throws(() => createSigningKey({ keychain }), /--replace/)
  assert.equal(keychain.store.get(OFFICIAL_KEY_ID), "existing")
  createSigningKey({ keychain, replace: true })
  assert.notEqual(keychain.store.get(OFFICIAL_KEY_ID), "existing")
})

test("the rotate script output never contains the private key", () => {
  const keychain = fakeKeychain()
  const output = run([], { keychain })
  const stored = keychain.store.get(OFFICIAL_KEY_ID)
  assert.ok(!output.includes(stored))
  assert.ok(!output.includes(stored.slice(32)))
  assert.ok(output.includes(publicKeyHexFromPrivate(stored)))
  assert.ok(output.includes(OFFICIAL_KEY_ID))
})

test("loadSigningKeyHex prefers the environment, then the Keychain, and fails when absent", () => {
  const a = generateKeyPair().privateKeyHex
  const b = generateKeyPair().privateKeyHex
  const keychain = fakeKeychain({ [OFFICIAL_KEY_ID]: b })
  assert.equal(loadSigningKeyHex({ env: { [SIGNING_KEY_ENV]: a }, keychain }), a)
  assert.equal(loadSigningKeyHex({ env: {}, keychain }), b)
  assert.throws(
    () => loadSigningKeyHex({ env: {}, keychain: fakeKeychain() }),
    /No module signing key/,
  )
  assert.throws(
    () => loadSigningKeyHex({ env: { [SIGNING_KEY_ENV]: "nonsense" }, keychain }),
    /not a valid/,
  )
})

test("no private key is committed in the build script or the validator", () => {
  for (const file of [
    "scripts/build-modules.mjs",
    "src/lib/modules/package-manager/validator.ts",
  ]) {
    const text = readFileSync(join(ROOT, file), "utf8")
    assert.ok(!/302e020100300506032b6570/.test(text), `${file} contains a private key`)
  }
})
