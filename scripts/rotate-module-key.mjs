// Creates the official module-signing key and stores it in the macOS Keychain.
// Prints only the key id, the PUBLIC key and the next step. See docs/security-advisories.md (MOD-01).
//
//   npm run modules:new-key            create (refuses to overwrite an existing key)
//   npm run modules:new-key -- --replace   overwrite the existing key

import console from "node:console"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { createSigningKey } from "./module-signing-key.mjs"

export function run(argv = process.argv.slice(2), options = {}) {
  if (process.platform !== "darwin" && !options.keychain) {
    throw new Error("This script stores the key in the macOS Keychain; run it on the owner's Mac.")
  }
  const replace = argv.includes("--replace")
  const { keyId, publicKeyHex } = createSigningKey({ ...options, replace })
  return [
    `Key id:     ${keyId}`,
    `Public key: ${publicKeyHex}`,
    "",
    "The private key is stored in the Keychain (service amby-module-signing) and was not printed.",
    "Next step: send the key id and the public key above (they are not secret) to the developer, who",
    "puts the public key into OFFICIAL_ED25519_PUBLIC_KEY_HEX in src-tauri/src/package_manager.rs",
    "and src/lib/modules/package-manager/validator.ts (search TODO(MOD-01)).",
  ].join("\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(run())
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Key creation failed.")
    process.exit(1)
  }
}
