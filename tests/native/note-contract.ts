import { listen } from "@tauri-apps/api/event"
import { NoteRevisionConflictError } from "../../src/lib/storage/types"
import { StorageOperationError } from "../../src/lib/storage/operation-error"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import { settingsRepository } from "../../src/lib/storage"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"
import { AutosaveCoordinator } from "../../src/components/workspace/autosave/autosave-coordinator"
import { isUnchangedNoteRevision } from "../../src/components/workspace/external-note-reconciliation"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const nativeNoteCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "rapid native typing and deletion keep saved revisions distinct from external edits",
    async run({ adapter, vaultPath }) {
      const created = await adapter.createNote(vaultPath, vaultPath, "Rapid Editing")
      const id = created.primaryId!
      const loaded = await adapter.loadActiveVaultData()
      let revision = (await adapter.readNote(vaultPath, id)).revision
      const key = { generation: loaded.generation, kind: "markdown" as const, documentId: id }
      const coordinator = new AutosaveCoordinator<string>({
        delayMs: 500,
        save: async (snapshot) => {
          const saved = await adapter.writeNote(
            vaultPath,
            id,
            snapshot.value,
            loaded.generation,
            revision,
            "main",
          )
          revision = saved.revision
        },
      })
      const text = "# Заметка\n\nБыстрый ввод 日本語"
      for (const length of [4, 10, text.length, 10, 4, 0]) {
        const content = text.slice(0, length)
        coordinator.enqueueImmediate(key, content)
        await coordinator.waitForInFlight(key)
        const disk = await adapter.readNote(vaultPath, id)
        check(disk.content === content, "Native save keeps the latest typed/deleted content")
        check(
          isUnchangedNoteRevision(disk.revision, revision, revision),
          "A delayed watcher read of our own save is unchanged even with a newer editor draft",
        )
        check(!coordinator.inspect(key)?.dirty, "Native save completes without a CAS conflict")
      }
      await adapter.writeFile(
        created.primaryPath!,
        `---\namby-id: ${id}\n---\nChanged in another app\n`,
      )
      const external = await adapter.readNote(vaultPath, id)
      check(
        !isUnchangedNoteRevision(external.revision, revision, revision),
        "A real external edit remains a conflict",
      )
    },
  },
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
      await adapter.deleteItem(vaultPath, note.primaryPath!, "vault")
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
    name: "native permanent delete removes the note and keeps no trash copy",
    async run({ adapter, vaultPath }) {
      const keep = await adapter.createNote(vaultPath, vaultPath, "Keep Permanent")
      const keepBytes = await adapter.readFile(keep.primaryPath!)
      const note = await adapter.createNote(vaultPath, vaultPath, "Gone Permanent")
      const trashBefore = (await adapter.listTrash()).length
      await adapter.deleteItem(vaultPath, note.primaryPath!, "permanent")
      let readable = true
      try {
        await adapter.readFile(note.primaryPath!)
      } catch {
        readable = false
      }
      check(!readable, "Permanently deleted note is gone")
      check((await adapter.listTrash()).length === trashBefore, "No trash copy is kept")
      check((await adapter.readFile(keep.primaryPath!)) === keepBytes, "Other notes stay intact")
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
  {
    name: "native delete failure preserves note bytes and index visibility",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Delete Failure")
      const original = await adapter.readFile(note.primaryPath!)
      await settingsRepository.writeVaultRaw("trash", "blocker")

      let failed = false
      try {
        await adapter.deleteItem(vaultPath, note.primaryPath!, "vault")
      } catch {
        failed = true
      }
      check(failed, "A non-directory trash root rejects deletion")
      check(
        (await adapter.readFile(note.primaryPath!)) === original,
        "Failed deletion leaves original Markdown byte-for-byte intact",
      )
      const refreshed = await adapter.loadActiveVaultData()
      check(
        refreshed.notes.some((indexed) => indexed.id === note.primaryId),
        "Failed deletion leaves the note visible in the index",
      )
    },
  },
]
