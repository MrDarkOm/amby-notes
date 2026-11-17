import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { INSTALLED_MODULE_EXECUTION_ENABLED } from "../host/execution-policy"
import {
  OFFICIAL_ED25519_KEY_ID,
  OFFICIAL_ED25519_PUBLIC_KEY_HEX,
  OFFICIAL_TRUST_ANCHOR,
  isProvisionedPublicKey,
  validateSignature,
  verifyEd25519Signature,
} from "./validator"
import { TEST_TRUST_ANCHOR, signWithTestKey } from "./test-signing"

// MOD-01: the private half of `amby-official-2026` leaked; only its public half is kept here,
// to prove the key is trusted nowhere.
const REVOKED_PUBLIC_KEY_HEX = "540caa0bdc9a519b774ad2ee4fb3e2278d149ee0ecfaa0d54ba75e6ad66c9dda"
const REVOKED_KEY_ID = "amby-official-2026"

const rustSource = readFileSync(
  resolve(__dirname, "../../../../src-tauri/src/package_manager.rs"),
  "utf8",
)

function rustConstant(name: string): string {
  const match = new RegExp(`pub const ${name}: &str =\\s*"([^"]*)"`).exec(rustSource)
  if (!match) throw new Error(`${name} not found in package_manager.rs`)
  return match[1]!
}

describe("MOD-01: official signing key trust", () => {
  it("keeps the TypeScript and Rust trust anchors identical", () => {
    expect(rustConstant("OFFICIAL_ED25519_KEY_ID")).toBe(OFFICIAL_ED25519_KEY_ID)
    expect(rustConstant("OFFICIAL_ED25519_PUBLIC_KEY_HEX")).toBe(OFFICIAL_ED25519_PUBLIC_KEY_HEX)
  })

  it("does not trust the revoked key anywhere", () => {
    expect(OFFICIAL_ED25519_KEY_ID).not.toBe(REVOKED_KEY_ID)
    expect(OFFICIAL_ED25519_PUBLIC_KEY_HEX).not.toBe(REVOKED_PUBLIC_KEY_HEX)
    expect(rustConstant("OFFICIAL_ED25519_PUBLIC_KEY_HEX")).not.toBe(REVOKED_PUBLIC_KEY_HEX)
  })

  it("does not trust the test key in production", async () => {
    expect(OFFICIAL_ED25519_PUBLIC_KEY_HEX).not.toBe(TEST_TRUST_ANCHOR.publicKeyHex)
    const manifest = await signWithTestKey(
      {
        formatVersion: 1,
        id: "test.pkg",
        name: "Test",
        version: "1.0.0",
        publisher: "Amby",
        kind: "official",
        minAppVersion: "0.1.4",
        entry: "index.js",
        permissions: [],
        checksums: {},
      },
      OFFICIAL_ED25519_KEY_ID,
    )
    expect(await validateSignature(manifest, OFFICIAL_TRUST_ANCHOR)).toBe(false)
  })

  it("never verifies against the all-zero placeholder key", async () => {
    const zero = "0".repeat(64)
    expect(isProvisionedPublicKey(zero)).toBe(false)
    const sig = `ed25519:${"0".repeat(128)}`
    expect(await verifyEd25519Signature(zero, new Uint8Array([1]), sig)).toBe(false)
  })

  it("keeps third-party packages and installed-module execution off until the key is provisioned", () => {
    if (isProvisionedPublicKey(OFFICIAL_ED25519_PUBLIC_KEY_HEX)) return
    expect(INSTALLED_MODULE_EXECUTION_ENABLED).toBe(false)
    expect(rustSource).toMatch(/THIRD_PARTY_PACKAGES_ENABLED: bool = false;/)
  })
})
