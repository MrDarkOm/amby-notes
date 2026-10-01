import { PACKAGE_FORMAT_VERSION, type PackageManifest } from "./types"
import * as semver from "semver"

/**
 * Package versions use strict SemVer. Dependency strings preserve the legacy
 * meaning of an exact version (the installed version must be at least that
 * version). Explicit ranges use complete versions with ^, ~, =, <, <=, >,
 * >= or a space-separated intersection; partials, OR and hyphens are refused.
 */
function parseStrictVersion(value: string, field: string): string {
  const parsed = strictVersion(value)
  if (!parsed) {
    throw new Error(`Invalid ${field}: ${value}`)
  }
  return parsed
}

function strictVersion(value: string): string | null {
  if (typeof value !== "string") return null
  if (value.length > 128 || value !== value.trim() || !/^\d/.test(value)) return null
  const parsed = semver.parse(value)
  if (!parsed) return null
  if (
    parsed.prerelease.some(
      (part) => /^\d+$/.test(String(part)) && !Number.isSafeInteger(Number(part)),
    )
  )
    return null
  return value
}

function validModuleId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._+-]*$/i.test(value) ||
    value.endsWith(".")
  )
    return false
  const stem = value.split(".")[0]!.toUpperCase()
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

function dependencyRange(value: string): string | null {
  const exact = strictVersion(value)
  if (exact) return `>=${exact}`
  if (value === "*") return "*"
  if (!value || value.length > 1024 || value !== value.trim()) return null
  const parts = value.split(" ")
  if (
    !parts.every((part) => {
      const match = /^(>=|<=|>|<|=|\^|~)(.+)$/.exec(part)
      return match && strictVersion(match[2]!) !== null
    })
  )
    return null
  return semver.validRange(value)
}

function validateVersionField(value: unknown, field: string): string | undefined {
  if (typeof value !== "string" || !strictVersion(value)) {
    return `Manifest must specify a valid ${field} (strict SemVer)`
  }
  return undefined
}

/**
 * Validates package manifest structure and required fields.
 */
export function validateManifest(raw: unknown): {
  valid: boolean
  error?: string
  manifest?: PackageManifest
} {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "Manifest must be an object" }
  }

  const m = raw as Partial<PackageManifest>

  if (m.formatVersion !== PACKAGE_FORMAT_VERSION) {
    return {
      valid: false,
      error: `Unsupported package formatVersion: ${m.formatVersion}, expected ${PACKAGE_FORMAT_VERSION}`,
    }
  }

  if (!validModuleId(m.id)) {
    return { valid: false, error: "Manifest must specify a valid alphanumeric id" }
  }

  if (!m.name || typeof m.name !== "string") {
    return { valid: false, error: "Manifest must specify a name" }
  }

  const versionError = validateVersionField(m.version, "version")
  if (versionError) {
    return { valid: false, error: versionError }
  }

  if (!m.publisher || typeof m.publisher !== "string") {
    return { valid: false, error: "Manifest must specify a publisher" }
  }

  if (m.kind !== "official" && m.kind !== "community") {
    return { valid: false, error: "Manifest kind must be 'official' or 'community'" }
  }

  const minVersionError = validateVersionField(m.minAppVersion, "minAppVersion")
  if (minVersionError) {
    return { valid: false, error: minVersionError }
  }

  if (m.maxAppVersion !== undefined) {
    const maxVersionError = validateVersionField(m.maxAppVersion, "maxAppVersion")
    if (maxVersionError) {
      return { valid: false, error: maxVersionError }
    }
    if (semver.gt(m.minAppVersion!, m.maxAppVersion as string)) {
      return { valid: false, error: "minAppVersion cannot exceed maxAppVersion" }
    }
  }

  if (!m.entry || typeof m.entry !== "string") {
    return { valid: false, error: "Manifest must specify an entry file" }
  }

  if (!Array.isArray(m.permissions)) {
    return { valid: false, error: "Manifest must declare a permissions array" }
  }

  if (!m.checksums || typeof m.checksums !== "object") {
    return { valid: false, error: "Manifest must contain file checksums" }
  }

  if (!m.signature || typeof m.signature !== "object" || !m.signature.keyId || !m.signature.sig) {
    return { valid: false, error: "Manifest must include signature with keyId and sig" }
  }

  if (m.dependencies !== undefined) {
    if (!m.dependencies || typeof m.dependencies !== "object" || Array.isArray(m.dependencies)) {
      return { valid: false, error: "Manifest dependencies must be a module-to-version map" }
    }
    for (const [dependencyId, requirement] of Object.entries(m.dependencies)) {
      if (!validModuleId(dependencyId) || dependencyId === m.id) {
        return { valid: false, error: `Invalid dependency module id: ${dependencyId}` }
      }
      if (typeof requirement !== "string" || !dependencyRange(requirement)) {
        return { valid: false, error: `Invalid dependency version range: ${requirement}` }
      }
    }
  }

  return { valid: true, manifest: m as PackageManifest }
}

/**
 * Compare two semver strings: a < b (-1), a === b (0), a > b (1).
 */
export function compareSemver(a: string, b: string): number {
  return semver.compare(parseStrictVersion(a, "version"), parseStrictVersion(b, "version"))
}

/**
 * Validates API compatibility of the package against current app version.
 */
export function validateApiCompatibility(
  manifest: PackageManifest,
  currentAppVersion: string,
): { compatible: boolean; reason?: string } {
  const current = strictVersion(currentAppVersion)
  const min = strictVersion(manifest.minAppVersion)
  const max = manifest.maxAppVersion !== undefined ? strictVersion(manifest.maxAppVersion) : null
  if (
    !current ||
    !min ||
    (manifest.maxAppVersion !== undefined && !max) ||
    (max && semver.gt(min, max))
  ) {
    return {
      compatible: false,
      reason: "Package or application version is not valid strict SemVer",
    }
  }
  if (semver.lt(current, min)) {
    return {
      compatible: false,
      reason: `Requires Amby ${manifest.minAppVersion} or higher (current: ${currentAppVersion})`,
    }
  }

  if (max && semver.gt(current, max)) {
    return {
      compatible: false,
      reason: `Incompatible with Amby ${currentAppVersion} (maximum supported: ${manifest.maxAppVersion})`,
    }
  }

  return { compatible: true }
}

/**
 * Validates that all files in a package are strictly confined to the package directory.
 * Rejects path traversal (..), absolute paths, and drive letters.
 */
export function validatePathConfinement(paths: string[]): {
  safe: boolean
  offendingPath?: string
} {
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/")
    if (
      normalized.startsWith("/") ||
      normalized.includes("..") ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.includes("\0")
    ) {
      return { safe: false, offendingPath: p }
    }
  }
  return { safe: true }
}

/**
 * Fast string SHA-256 calculation using Web Crypto when available.
 */
export async function sha256Hex(content: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoder = new TextEncoder()
    const data = encoder.encode(content)
    const hashBuffer = await crypto.subtle.digest("SHA-256", data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
  }
  // Fallback deterministic hash for test/node environments without subtle crypto
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) - hash + content.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(16).padStart(64, "0")
}

/**
 * Validates file checksums against manifest declarations.
 */
export async function validateChecksums(
  files: Record<string, string>,
  declaredChecksums: Record<string, string>,
): Promise<{ valid: boolean; mismatchedFile?: string }> {
  for (const [relPath, declaredHash] of Object.entries(declaredChecksums)) {
    const fileContent = files[relPath]
    if (fileContent === undefined) {
      return { valid: false, mismatchedFile: relPath }
    }
    const computedHash = await sha256Hex(fileContent)
    if (computedHash.toLowerCase() !== declaredHash.toLowerCase()) {
      return { valid: false, mismatchedFile: relPath }
    }
  }
  return { valid: true }
}

export const OFFICIAL_ED25519_KEY_ID = "amby-official-2026"
export const OFFICIAL_ED25519_PUBLIC_KEY_HEX =
  "540caa0bdc9a519b774ad2ee4fb3e2278d149ee0ecfaa0d54ba75e6ad66c9dda"

export const TEST_OFFICIAL_PRIVATE_KEY_HEX =
  "302e020100300506032b65700422042044ba75c905cdfce57e79cc502b48efe22d07e78da850a7eb6e99f02769ca10e4"

/**
 * Returns canonical serialized UTF-8 bytes of the manifest for cryptographic signing/verification.
 */
export function canonicalManifestBytes(manifest: PackageManifest): Uint8Array {
  const sortedChecksums: Record<string, string> = {}
  for (const k of Object.keys(manifest.checksums ?? {}).sort()) {
    sortedChecksums[k] = manifest.checksums[k]!
  }

  const payload: Record<string, unknown> = {
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

  return new TextEncoder().encode(JSON.stringify(payload))
}

/**
 * Cryptographically signs a manifest with the test official private key.
 */
export async function signOfficialManifest(
  manifest: Omit<PackageManifest, "signature">,
): Promise<PackageManifest> {
  const bytes = canonicalManifestBytes(manifest as PackageManifest)
  const privBytes = Uint8Array.from(Buffer.from(TEST_OFFICIAL_PRIVATE_KEY_HEX, "hex"))
  const key = await crypto.subtle.importKey("pkcs8", privBytes, { name: "Ed25519" }, false, [
    "sign",
  ])
  const sigBuffer = await crypto.subtle.sign("Ed25519", key, bytes)
  const sigHex = Buffer.from(sigBuffer).toString("hex")
  return {
    ...manifest,
    signature: {
      keyId: OFFICIAL_ED25519_KEY_ID,
      sig: `ed25519:${sigHex}`,
    },
  }
}

/**
 * Cryptographically verifies an Ed25519 signature over a byte message.
 */
export async function verifyEd25519Signature(
  publicKeyHex: string,
  message: Uint8Array,
  signatureStr: string,
): Promise<boolean> {
  try {
    const cleanSig = signatureStr.startsWith("ed25519:")
      ? signatureStr.slice("ed25519:".length)
      : signatureStr

    if (cleanSig.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(cleanSig)) {
      return false
    }

    const pubBytes = Uint8Array.from(Buffer.from(publicKeyHex, "hex"))
    const sigBytes = Uint8Array.from(Buffer.from(cleanSig, "hex"))

    const key = await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, [
      "verify",
    ])
    return await crypto.subtle.verify("Ed25519", key, sigBytes, message)
  } catch {
    return false
  }
}

/**
 * Validates official signature with real Ed25519 cryptography.
 */
export async function validateSignature(manifest: PackageManifest): Promise<boolean> {
  if (manifest.kind !== "official") {
    // Community plugins can have community signatures or be unsigned
    return true
  }
  const { keyId, sig } = manifest.signature
  if (keyId !== OFFICIAL_ED25519_KEY_ID) {
    return false
  }
  if (typeof sig !== "string" || !sig.startsWith("ed25519:")) {
    return false
  }
  const message = canonicalManifestBytes(manifest)
  return verifyEd25519Signature(OFFICIAL_ED25519_PUBLIC_KEY_HEX, message, sig)
}

/**
 * Validates that all package dependencies are satisfied by installed modules.
 */
export function validateDependencies(
  manifest: PackageManifest,
  installedModules: Record<string, { activeVersion: string }>,
): { satisfied: boolean; missing: string[] } {
  if (!manifest.dependencies) return { satisfied: true, missing: [] }

  const missing: string[] = []
  for (const [depId, requiredVersion] of Object.entries(manifest.dependencies)) {
    const installed = Object.prototype.hasOwnProperty.call(installedModules, depId)
      ? installedModules[depId]
      : undefined
    if (!installed) {
      missing.push(`${depId}@${requiredVersion}`)
      continue
    }
    const installedVersion = strictVersion(installed.activeVersion)
    const range = dependencyRange(requiredVersion)
    if (!installedVersion || !range || !semver.satisfies(installedVersion, range)) {
      missing.push(`${depId}@${requiredVersion} (installed: ${installed.activeVersion})`)
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
  }
}
