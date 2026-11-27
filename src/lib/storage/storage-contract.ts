import type { StoragePort } from "./port"
import type { TreeItem } from "./types"
import { joinStoragePath } from "./storage-path"
import { StorageOperationError, type StorageOperationErrorCode } from "./operation-error"

export interface StorageContractContext {
  adapter: StoragePort
  vaultPath: string
  cleanup?: () => Promise<void>
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function path(value: string): string {
  return value.replace(/\\/g, "/")
}

function flatten(items: TreeItem[]): TreeItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])])
}

async function rejects(
  operation: Promise<unknown>,
  code?: StorageOperationErrorCode,
): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (code)
      check(
        error instanceof StorageOperationError && error.code === code,
        `Expected ${code}, received ${String(error)}`,
      )
    return
  }
  throw new Error("Expected storage operation to fail")
}

/** Identical operations for Vitest and a real native WebView; no mocked IPC. */
export const storageContractCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "create/read/write/overwrite nested Unicode notes",
    async run({ adapter, vaultPath }) {
      const folder = await adapter.createFolder(vaultPath, "folder with spaces")
      for (const name of ["Заметка", "Нотатка", "日本語", "emoji🔥"]) {
        const note = await adapter.createNote(vaultPath, folder, name)
        check(note.primaryPath, "Created note has a path")
        await adapter.readFile(note.primaryPath)
        await adapter.writeFile(note.primaryPath, `first ${name}`)
        await adapter.writeFile(note.primaryPath, `second ${name}`)
        check(
          (await adapter.readFile(note.primaryPath)) === `second ${name}`,
          "Latest bytes persist",
        )
      }
      const listed = flatten(await adapter.listFiles(vaultPath)).map((item) => path(item.path))
      for (const name of ["Заметка", "Нотатка", "日本語", "emoji🔥"]) {
        check(listed.includes(`${path(folder)}/${name}.md`), `Listed: ${name}`)
      }
    },
  },
  {
    name: "rename/delete preserve data and remove old paths",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Original")
      await adapter.writeFile(note.primaryPath!, "saved content")
      const renamed = await adapter.renameItem(vaultPath, note.primaryPath!, "Переименовано")
      check(path(renamed.primaryPath!) === `${path(vaultPath)}/Переименовано.md`, "Rename path")
      check((await adapter.readFile(renamed.primaryPath!)) === "saved content", "Rename bytes")
      await rejects(adapter.readFile(note.primaryPath!))
      await adapter.deleteItem(vaultPath, renamed.primaryPath!, "archive")
      await rejects(adapter.readFile(renamed.primaryPath!))
      check(
        !flatten(await adapter.listFiles(vaultPath)).some(
          (item) => path(item.path) === path(renamed.primaryPath!),
        ),
        "Deleted note leaves tree",
      )
    },
  },
  {
    name: "folder rename preserves nested notes",
    async run({ adapter, vaultPath }) {
      const folder = await adapter.createFolder(vaultPath, "Original folder")
      const nested = await adapter.createFolder(folder, "nested")
      const note = await adapter.createNote(vaultPath, nested, "Note")
      await adapter.writeFile(note.primaryPath!, "nested bytes")
      await adapter.renameItem(vaultPath, folder, "Renamed folder")
      check(
        (await adapter.readFile(joinStoragePath(vaultPath, "Renamed folder/nested/Note.md"))) ===
          "nested bytes",
        "Nested bytes after folder rename",
      )
      await rejects(adapter.readFile(note.primaryPath!))
    },
  },
  {
    name: "missing paths fail and collisions preserve both originals",
    async run({ adapter, vaultPath }) {
      await rejects(adapter.readFile(joinStoragePath(vaultPath, "missing.md")), "notFound")
      await rejects(
        adapter.renameItem(vaultPath, joinStoragePath(vaultPath, "missing.md"), "Other"),
      )
      const first = await adapter.createNote(vaultPath, vaultPath, "Taken")
      const second = await adapter.createNote(vaultPath, vaultPath, "Other")
      await adapter.writeFile(first.primaryPath!, "first")
      await adapter.writeFile(second.primaryPath!, "second")
      await rejects(adapter.renameItem(vaultPath, first.primaryPath!, "../escape"), "invalidPath")
      await rejects(adapter.createNote(vaultPath, vaultPath, "Taken"), "alreadyExists")
      await rejects(adapter.renameItem(vaultPath, first.primaryPath!, "Other"), "alreadyExists")
      check((await adapter.readFile(first.primaryPath!)) === "first", "Collision retains source")
      check((await adapter.readFile(second.primaryPath!)) === "second", "Collision retains target")
    },
  },
  {
    name: "move into a folder keeps bytes and rejects a name collision without overwriting",
    async run({ adapter, vaultPath }) {
      const folder = await adapter.createFolder(vaultPath, "Destination")
      const moving = await adapter.createNote(vaultPath, vaultPath, "Moving")
      await adapter.writeFile(moving.primaryPath!, "moving bytes")
      const moved = await adapter.moveItem(vaultPath, moving.primaryPath!, folder)
      check(path(moved.primaryPath!) === `${path(folder)}/Moving.md`, "Move path")
      check((await adapter.readFile(moved.primaryPath!)) === "moving bytes", "Move bytes")
      await rejects(adapter.readFile(moving.primaryPath!))

      const clash = await adapter.createNote(vaultPath, vaultPath, "Moving")
      await adapter.writeFile(clash.primaryPath!, "clashing bytes")
      await rejects(adapter.moveItem(vaultPath, clash.primaryPath!, folder), "alreadyExists")
      check((await adapter.readFile(clash.primaryPath!)) === "clashing bytes", "Source retained")
      check(
        (await adapter.readFile(moved.primaryPath!)) === "moving bytes",
        "Target not overwritten",
      )
    },
  },
  {
    name: "note names are trimmed on create and rename, blank names are refused",
    async run({ adapter, vaultPath }) {
      const created = await adapter.createNote(vaultPath, vaultPath, "  Padded  ")
      check(path(created.primaryPath!) === `${path(vaultPath)}/Padded.md`, "Create trims name")
      const renamed = await adapter.renameItem(vaultPath, created.primaryPath!, "  Trimmed  ")
      check(path(renamed.primaryPath!) === `${path(vaultPath)}/Trimmed.md`, "Rename trims name")
      await rejects(adapter.createNote(vaultPath, vaultPath, "   "), "invalidPath")
      await rejects(adapter.renameItem(vaultPath, renamed.primaryPath!, "   "), "invalidPath")
    },
  },
  {
    name: "archive never deletes permanently: it is restorable or refused",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Archived")
      await adapter.writeFile(note.primaryPath!, "archived bytes")
      let archived = false
      try {
        await adapter.archiveItem(vaultPath, note.primaryPath!)
        archived = true
      } catch (error) {
        check(error instanceof StorageOperationError, `Typed refusal expected: ${String(error)}`)
      }
      if (archived) {
        check((await adapter.listArchive(vaultPath)).length > 0, "Archived item is restorable")
      } else {
        check(
          (await adapter.readFile(note.primaryPath!)) === "archived bytes",
          "Refused archive keeps the file",
        )
      }
    },
  },
]
