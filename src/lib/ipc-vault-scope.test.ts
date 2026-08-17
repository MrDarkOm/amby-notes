import { describe, expect, it } from "vitest"

const bindings = import.meta.glob("./bindings.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

const source = bindings["./bindings.ts"]

describe("vault-scoped IPC bindings", () => {
  it("keeps candidate roots only on activation commands", () => {
    expect(source).toContain("async loadVault(vaultPath: string)")
    expect(source).toContain("async preflightVault(vaultPath: string)")
    expect(source).toContain("async applyIdMigration(vaultPath: string)")

    for (const command of [
      "listFiles",
      "readNote",
      "writeNote",
      "searchNotes",
      "getLinkGraph",
      "createNote",
      "moveItem",
      "renameItem",
      "deleteItem",
      "startVaultWatcher",
      "importAsset",
      "importAssetBytes",
    ]) {
      const signature = source.match(new RegExp(`async ${command}\\(([^)]*)\\)`))?.[1] ?? ""
      expect(signature).not.toContain("vaultPath")
    }
  })
})
