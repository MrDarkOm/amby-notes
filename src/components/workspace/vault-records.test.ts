import { describe, expect, it, vi } from "vitest"
import { deduplicateVaultRecords, reconcileVaultRecord, vaultPathKey } from "./vault-records"

describe("Windows workspace path identity", () => {
  it("matches drive, verbatim and separator/case variants", () => {
    expect(vaultPathKey("\\\\?\\D:\\Vault\\Notes\\")).toBe("d:/vault/notes")
    expect(vaultPathKey("d:/vault/NOTES")).toBe("d:/vault/notes")
    expect(vaultPathKey("\\\\?\\UNC\\Server\\Share\\Vault")).toBe("//server/share/vault")
  })

  it("updates an existing record to the backend path instead of duplicating it", () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "new") })
    const records = [{ id: "kept", name: "Custom label", path: "D:\\Vault" }]
    expect(reconcileVaultRecord(records, "\\\\?\\d:\\vault")).toEqual([
      { id: "kept", name: "Custom label", path: "\\\\?\\d:\\vault" },
    ])
    expect(crypto.randomUUID).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("repairs already persisted duplicates and preserves POSIX case", () => {
    const records = [
      { id: "old", name: "Old", path: "D:\\Vault" },
      { id: "canonical", name: "Canonical", path: "\\\\?\\D:\\Vault" },
      { id: "upper", name: "Upper", path: "/Vault" },
      { id: "lower", name: "Lower", path: "/vault" },
    ]
    expect(deduplicateVaultRecords(records).map((record) => record.id)).toEqual([
      "canonical",
      "upper",
      "lower",
    ])
  })
})
