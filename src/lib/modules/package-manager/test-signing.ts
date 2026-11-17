/**
 * Test-only signing support. The key pair is generated when the test process
 * starts and never leaves it; it is NOT in any production trust list. Import
 * this file from tests only.
 */
import { Buffer } from "node:buffer"
import { canonicalManifestBytes, type OfficialTrustAnchor } from "./validator"
import type { PackageManifest } from "./types"

export const TEST_KEY_ID = "amby-test-ephemeral"

const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))

export const TEST_TRUST_ANCHOR: OfficialTrustAnchor = {
  keyId: TEST_KEY_ID,
  publicKeyHex: Buffer.from(publicRaw).toString("hex"),
}

export async function signWithTestKey(
  manifest: Omit<PackageManifest, "signature">,
  keyId: string = TEST_KEY_ID,
): Promise<PackageManifest> {
  const bytes = canonicalManifestBytes(manifest as PackageManifest)
  const sig = await crypto.subtle.sign("Ed25519", keyPair.privateKey, new Uint8Array(bytes))
  return { ...manifest, signature: { keyId, sig: `ed25519:${Buffer.from(sig).toString("hex")}` } }
}
