import { describe, expect, it } from "vitest"
import type { StoragePort, TreeItem } from "./index"

export interface StorageContractContext {
  adapter: StoragePort
  vaultPath: string
}

function flatten(items: TreeItem[]): TreeItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])])
}

/**
 * Portable filesystem-level semantics shared by every storage implementation.
 * Platform-specific features such as watchers and dialogs intentionally stay
 * outside this contract.
 */
export function runStorageContract(
  name: string,
  create: () => Promise<StorageContractContext> | StorageContractContext,
): void {
  describe(`${name} storage contract`, () => {
    it("creates, overwrites, renames, lists, and deletes nested Unicode notes", async () => {
      const { adapter, vaultPath } = await create()
      const folder = await adapter.createFolder(vaultPath, "folder with spaces")
      const nested = await adapter.createNote(vaultPath, folder, "Заметка")
      const path = nested.primaryPath!

      await adapter.writeFile(path, "first")
      await adapter.writeFile(path, "second")
      await expect(adapter.readFile(path)).resolves.toBe("second")

      const unicodeNames = ["Нотатка", "日本語", "emoji🔥"]
      for (const noteName of unicodeNames) {
        const created = await adapter.createNote(vaultPath, folder, noteName)
        await adapter.writeFile(created.primaryPath!, `content: ${noteName}`)
      }

      const renamed = await adapter.renameItem(vaultPath, path, "Переименовано")
      expect(renamed.primaryPath).toBe(`${folder}/Переименовано.md`)
      expect(await adapter.readFile(renamed.primaryPath!)).toBe("second")

      const listed = flatten(await adapter.listFiles(vaultPath)).map((item) => item.path)
      expect(listed).toEqual(
        expect.arrayContaining([
          folder,
          `${folder}/Переименовано.md`,
          `${folder}/Нотатка.md`,
          `${folder}/日本語.md`,
          `${folder}/emoji🔥.md`,
        ]),
      )

      const deleted = await adapter.deleteItem(vaultPath, renamed.primaryPath!)
      expect(deleted.deletedPaths).toContain(renamed.primaryPath!)
      await expect(adapter.readFile(renamed.primaryPath!)).rejects.toThrow()
    })

    it("uses stable errors for missing paths and name collisions", async () => {
      const { adapter, vaultPath } = await create()
      await expect(adapter.readFile(`${vaultPath}/missing.md`)).rejects.toThrow()
      await expect(
        adapter.renameItem(vaultPath, `${vaultPath}/missing.md`, "other"),
      ).rejects.toThrow()

      const first = await adapter.createNote(vaultPath, vaultPath, "Taken")
      await expect(adapter.createNote(vaultPath, vaultPath, "Taken")).rejects.toThrow()
      await expect(adapter.renameItem(vaultPath, first.primaryPath!, "Welcome")).rejects.toThrow()
    })
  })
}
