import { listen } from "@tauri-apps/api/event"
import { NoteRevisionConflictError } from "../../src/lib/storage/types"
import { StorageOperationError } from "../../src/lib/storage/operation-error"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const nativeNoteCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "native note save emits a real event and survives vault reactivation",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Lifecycle")
      const id = note.primaryId!
      const loaded = await adapter.loadActiveVaultData()
      const before = await adapter.readNote(vaultPath, id)
      let written = false
      const unlisten = await listen<{ noteId: string }>("amby:note-written", (event) => {
        written ||= event.payload.noteId === id
      })
      try {
        const saved = await adapter.writeNote(
          vaultPath,
          id,
          "Latest 日本語 content",
          loaded.generation,
          before.revision,
          "main",
        )
        check(saved.indexState === "healthy", "Save index is healthy")
        const deadline = Date.now() + 5000
        while (!written && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(written, "Rust note-written event reached WebView")
        await adapter.loadVaultData(vaultPath)
        check(
          (await adapter.readNote(vaultPath, id)).content === "Latest 日本語 content",
          "Reactivation reads latest bytes",
        )
      } finally {
        unlisten()
      }
    },
  },
  {
    name: "stale native revision is rejected without overwriting newer content",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Conflict")
      const id = note.primaryId!
      const loaded = await adapter.loadActiveVaultData()
      const before = await adapter.readNote(vaultPath, id)
      await adapter.writeNote(vaultPath, id, "newer", loaded.generation, before.revision, "main")
      let conflict = false
      try {
        await adapter.writeNote(vaultPath, id, "stale", loaded.generation, before.revision, "main")
      } catch (error) {
        conflict = error instanceof NoteRevisionConflictError
      }
      check(conflict, "CAS conflict is structured")
      check(
        (await adapter.readNote(vaultPath, id)).content === "newer",
        "Newer bytes survive stale save",
      )
    },
  },
  {
    name: "history and recycle restore preserve the native note",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Recovery")
      const initial = await adapter.readFile(note.primaryPath!)
      await adapter.writeFile(note.primaryPath!, `${initial}\nbefore`)
      await adapter.writeFile(note.primaryPath!, `${initial}\nafter`)
      const original = await adapter.readFile(note.primaryPath!)
      const snapshots = await adapter.listSnapshots(note.primaryPath!)
      check(snapshots.length > 0, "History recorded pre-write bytes")
      await adapter.readSnapshotText(snapshots[0].id)
      await adapter.deleteItem(vaultPath, note.primaryPath!)
      const trash = await adapter.listTrash()
      check(trash.length === 1, "Delete entered vault-local recycle bin")
      const restored = await adapter.restoreTrash(trash[0].id)
      check(
        (await adapter.readFile(restored.primaryPath!)) === original,
        "Restored bytes are intact",
      )
    },
  },
  {
    name: "native vault boundary rejects read write and delete escapes",
    async run({ adapter, vaultPath }) {
      const outside = joinStoragePath(vaultPath, "../outside.md")
      for (const operation of [
        () => adapter.readFile(outside),
        () => adapter.writeFile(outside, "forbidden"),
        () => adapter.deleteItem(vaultPath, outside),
      ]) {
        let blocked = false
        try {
          await operation()
        } catch (error) {
          blocked = error instanceof StorageOperationError && error.code === "invalidPath"
        }
        check(blocked, "Vault escape is blocked at the real command boundary")
      }
    },
  },
]
