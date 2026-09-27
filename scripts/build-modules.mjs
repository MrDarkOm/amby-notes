import { Buffer } from "node:buffer"
import console from "node:console"
import crypto from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT_DIR = join(__dirname, "..")
const DIST_DIR = join(ROOT_DIR, "dist-modules")

const OFFICIAL_KEY_ID = "amby-official-2026"
const OFFICIAL_PUBLIC_KEY_HEX = "540caa0bdc9a519b774ad2ee4fb3e2278d149ee0ecfaa0d54ba75e6ad66c9dda"
const OFFICIAL_PRIVATE_KEY_HEX =
  "302e020100300506032b65700422042044ba75c905cdfce57e79cc502b48efe22d07e78da850a7eb6e99f02769ca10e4"

function sha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

function canonicalManifestBytes(manifest) {
  const sortedChecksums = {}
  for (const k of Object.keys(manifest.checksums || {}).sort()) {
    sortedChecksums[k] = manifest.checksums[k]
  }

  const payload = {
    checksums: sortedChecksums,
    entry: manifest.entry,
    formatVersion: manifest.formatVersion,
    id: manifest.id,
    kind: manifest.kind,
  }
  if (manifest.maxAppVersion !== undefined) {
    payload.maxAppVersion = manifest.maxAppVersion
  }
  payload.minAppVersion = manifest.minAppVersion
  payload.name = manifest.name
  payload.permissions = manifest.permissions
  payload.publisher = manifest.publisher
  payload.version = manifest.version

  return Buffer.from(JSON.stringify(payload), "utf8")
}

async function signManifest(unsignedManifest) {
  const bytes = canonicalManifestBytes(unsignedManifest)
  const privBytes = Uint8Array.from(Buffer.from(OFFICIAL_PRIVATE_KEY_HEX, "hex"))
  const key = await crypto.subtle.importKey("pkcs8", privBytes, { name: "Ed25519" }, false, [
    "sign",
  ])
  const sigBuffer = await crypto.subtle.sign("Ed25519", key, bytes)
  const sigHex = Buffer.from(sigBuffer).toString("hex")

  return {
    ...unsignedManifest,
    signature: {
      keyId: OFFICIAL_KEY_ID,
      sig: `ed25519:${sigHex}`,
    },
  }
}

async function verifySignature(signedManifest) {
  const bytes = canonicalManifestBytes(signedManifest)
  const sigHex = signedManifest.signature.sig.replace(/^ed25519:/, "")
  const pubBytes = Uint8Array.from(Buffer.from(OFFICIAL_PUBLIC_KEY_HEX, "hex"))
  const sigBytes = Uint8Array.from(Buffer.from(sigHex, "hex"))

  const key = await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, ["verify"])
  return crypto.subtle.verify("Ed25519", key, sigBytes, bytes)
}

const MODULES_TO_BUILD = [
  {
    manifest: {
      formatVersion: 1,
      id: "amby.tags",
      name: "Tags",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "vault.write", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby Tags Module */
export function activate(api) {
  api.panels.register({ id: "tags", title: "Tags", icon: "Tags" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.favorites",
      name: "Favorites",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "vault.write", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby Favorites Module */
export function activate(api) {
  api.panels.register({ id: "favorites", title: "Favorites", icon: "Star" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.databases",
      name: "Databases",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "vault.write", "read-databases", "write-databases", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby Databases Module */
export function activate(api) {
  api.panels.register({ id: "databases", title: "Databases", icon: "Database" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.history",
      name: "History",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "vault.write", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby History Module */
export function activate(api) {
  api.panels.register({ id: "history", title: "History", icon: "Clock3" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.links",
      name: "Links",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby Links Module */
export function activate(api) {
  api.panels.register({ id: "links", title: "Links", icon: "GitBranch" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.graph",
      name: "Graph",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby Graph Module */
export function activate(api) {
  api.panels.register({ id: "graph", title: "Graph", icon: "GitBranch" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.sync",
      name: "Sync",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "vault.write", "network"],
    },
    files: {
      "index.js": `/** Official Amby Sync Module */
export function activate(api) {
  api.commands.register({ id: "sync:now", name: "Sync Now" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.ai",
      name: "AI Assistant",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["vault.read", "network", "ui-panel"],
    },
    files: {
      "index.js": `/** Official Amby AI Assistant Module */
export function activate(api) {
  api.panels.register({ id: "ai", title: "AI Assistant", icon: "Bot" });
}
export function deactivate() {}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.excalidraw",
      name: "Excalidraw",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["ui-panel", "read-notes", "write-notes", "vault.read", "vault.write"],
    },
    files: {
      "index.js": `/**
 * Official Amby Excalidraw / Sketch Module
 * Autonomous package entry point.
 */
export function activate(api) {
  api.files.register({
    extension: ".excalidraw",
    moduleId: "amby.excalidraw",
    viewKind: "sketch",
  });
  api.files.register({
    extension: ".sketch",
    moduleId: "amby.excalidraw",
    viewKind: "sketch",
  });
}

export function deactivate() {
  // Excalidraw cleanup
}
`,
    },
  },
  {
    manifest: {
      formatVersion: 1,
      id: "amby.canvas",
      name: "Canvas",
      version: "1.0.0",
      publisher: "Amby",
      kind: "official",
      minAppVersion: "0.1.4",
      entry: "index.js",
      permissions: ["ui-panel", "read-notes", "write-notes", "vault.read", "vault.write"],
    },
    files: {
      "index.js": `/**
 * Official Amby Canvas Module
 * Autonomous package entry point.
 */
export function activate(api) {
  api.files.register({
    extension: ".canvas",
    moduleId: "amby.canvas",
    viewKind: "canvas",
  });
}

export function deactivate() {
  // Canvas cleanup
}
`,
    },
  },
]

async function main() {
  mkdirSync(DIST_DIR, { recursive: true })

  console.log("🔨 Building autonomous .amby-pkg module packages...")

  const catalog = {
    revision: new Date().toISOString().split("T")[0],
    generatedAt: new Date().toISOString(),
    packages: {},
  }

  for (const mod of MODULES_TO_BUILD) {
    const checksums = {}
    for (const [path, content] of Object.entries(mod.files)) {
      checksums[path] = sha256Hex(content)
    }

    const unsignedManifest = {
      ...mod.manifest,
      checksums,
    }

    const signedManifest = await signManifest(unsignedManifest)
    const isValid = await verifySignature(signedManifest)
    if (!isValid) {
      throw new Error(`Self-verification failed for ${mod.manifest.id}`)
    }

    const pkgPayload = {
      formatVersion: 1,
      manifest: signedManifest,
      files: mod.files,
    }

    const pkgFilename = `${mod.manifest.id}-${mod.manifest.version}.amby-pkg`
    const pkgPath = join(DIST_DIR, pkgFilename)
    const jsonStr = JSON.stringify(pkgPayload, null, 2)
    writeFileSync(pkgPath, jsonStr, "utf8")

    const pkgHash = sha256Hex(jsonStr)
    const pkgSize = Buffer.byteLength(jsonStr, "utf8")

    catalog.packages[mod.manifest.id] = {
      id: mod.manifest.id,
      name: mod.manifest.name,
      version: mod.manifest.version,
      filename: pkgFilename,
      sha256: pkgHash,
      sizeBytes: pkgSize,
      signature: signedManifest.signature,
    }

    console.log(`✅ Built ${pkgFilename}`)
    console.log(`   SHA-256: ${pkgHash}`)
    console.log(`   Size:    ${pkgSize} bytes`)
  }

  const catalogPath = join(DIST_DIR, "catalog.json")
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8")
  console.log(`\n📋 Catalog generated: ${catalogPath}`)

  console.log("\n🎉 All 10 packages built and cryptographically verified successfully.")
}

main().catch((err) => {
  console.error("❌ Failed to build modules:", err)
  process.exit(1)
})
