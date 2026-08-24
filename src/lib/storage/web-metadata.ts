import type { CredentialInfo } from "./types"

const GLOBAL_PREFIX = "amby:g:"
const VAULT_PREFIX = "amby:vmeta:"
const CREDENTIAL_PREFIX = "amby:cred:"

export class WebMetadataStorage {
  readGlobal(file: string) {
    return localStorage.getItem(GLOBAL_PREFIX + file)
  }
  writeGlobal(file: string, contents: string) {
    localStorage.setItem(GLOBAL_PREFIX + file, contents)
  }
  readVault(rel: string) {
    return localStorage.getItem(VAULT_PREFIX + rel)
  }
  writeVault(rel: string, contents: string) {
    localStorage.setItem(VAULT_PREFIX + rel, contents)
  }
  deleteVault(rel: string) {
    localStorage.removeItem(VAULT_PREFIX + rel)
  }
  storeCredential(id: string, secret: string) {
    localStorage.setItem(CREDENTIAL_PREFIX + id, secret)
  }
  deleteCredential(id: string) {
    localStorage.removeItem(CREDENTIAL_PREFIX + id)
  }
  inspectCredential(id: string): CredentialInfo {
    const secret = localStorage.getItem(CREDENTIAL_PREFIX + id)
    if (secret === null) return { exists: false, masked: null }
    const trimmed = secret.trim()
    if (trimmed.length === 0) return { exists: true, masked: "" }
    if (trimmed.length <= 8) return { exists: true, masked: "••••••••" }
    return { exists: true, masked: `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}` }
  }
}
