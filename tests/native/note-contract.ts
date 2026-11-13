import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { FileRevisionConflictError, NoteRevisionConflictError } from "../../src/lib/storage/types"
import { StorageOperationError } from "../../src/lib/storage/operation-error"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import {
  saveRecoveryDraft,
  scheduleRecoveryDraft,
  remapRecoveryDraft,
  flushRecoveryDraft,
  readRecoveryDraft,
  discardRecoveryDraft,
} from "../../src/lib/recovery-drafts"
import {
  createDatabase,
  listDatabases,
  noteLayers,
  setStorageAdapter,
  settingsRepository,
} from "../../src/lib/storage"
import { createDatabaseLayoutPort } from "../../src/lib/storage/database-layout-repository"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"
import { AutosaveCoordinator } from "../../src/components/workspace/autosave/autosave-coordinator"
import { FileRevisionTracker } from "../../src/components/workspace/autosave/file-revision-tracker"
import { remapLayerAutosave } from "../../src/components/workspace/autosave/remap-layer-autosave"
import { isUnchangedNoteRevision } from "../../src/components/workspace/external-note-reconciliation"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const nativeNoteCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "native attachment imports use unique typed names and preserve the original display name",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Asset names")
      const source = `${vaultPath}/Original Report.pdf`
      await adapter.writeFile(source, "%PDF-test bytes")
      const first = await adapter.importAsset(vaultPath, note.primaryPath!, source)
      const second = await adapter.importAsset(vaultPath, note.primaryPath!, source)
      check(first && second, "Both files were imported")
      check(
        /^assets\/pdf_[0-9A-HJKMNP-TV-Z]{26}\.pdf$/.test(first.relPath),
        "The filename has a type prefix and a random ID",
      )
      check(first.relPath !== second.relPath, "Repeated imports have distinct paths")
      check(first.fileName === "Original Report.pdf", "The original name remains the display name")
      check(
        (await adapter.readFile(first.absPath)) === "%PDF-test bytes",
        "The copied bytes are intact",
      )
      const pasted = await adapter.importAssetBytes(
        vaultPath,
        note.primaryPath!,
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        "png",
      )
      check(pasted?.relPath.startsWith("assets/img_"), "Pasted images use the same naming scheme")
    },
  },
  {
    name: "native database layout upgrade is explicit and preserves embedded templates and asset paths",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      await adapter.setDatabaseModuleEnabled(true, loaded.generation)
      const created = await adapter.createDatabase({
        expectedGeneration: loaded.generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "Layout upgrade",
      })
      const templateId = (await adapter.createNote(vaultPath, vaultPath, "Template identity"))
        .primaryId!
      const manifest = JSON.parse(await adapter.readFile(created.manifestPath))
      manifest.formatVersion = 1
      manifest.templateOrder = [templateId]
      manifest.defaultTemplateId = templateId
      delete manifest.templates
      const oldBytes = JSON.stringify(manifest)
      await adapter.writeFile(created.manifestPath, oldBytes)
      const container = created.manifestPath.replace(/[/\\][^/\\]+$/, "")
      const template = {
        format: "amby-database-template",
        formatVersion: 1,
        databaseId: created.databaseId,
        templateId,
        name: "Preserved template",
        body: "## Preserved body\n",
        values: {},
        unknown: 42,
      }
      await adapter.writeFile(
        `${container}/.ambd/templates/${templateId}.json`,
        JSON.stringify(template),
      )
      await adapter.writeFile(`${container}/.ambd/assets/${templateId}/cover.png`, "image bytes")
      const port = createDatabaseLayoutPort(true)
      check(
        (await port.scan(loaded.generation)).pendingDatabases === 1,
        "Opening only detects the old format",
      )
      check(
        (await adapter.readFile(created.manifestPath)) === oldBytes,
        "Scanning does not change the original manifest",
      )
      check(
        (await port.upgrade(loaded.generation)).pendingDatabases === 0,
        "Explicit action upgrades the database",
      )
      const updated = JSON.parse(await adapter.readFile(created.manifestPath))
      check(
        updated.formatVersion === 2 && updated.templates[0].unknown === 42,
        "Templates and unknown fields are retained in the manifest",
      )
      check(
        (await adapter.readFile(`${container}/assets/${templateId}/cover.png`)) === "image bytes",
        "Existing asset paths retain their bytes",
      )
      const row = await adapter.createDatabaseRow({
        expectedGeneration: loaded.generation,
        databaseId: created.databaseId,
        title: "From migrated template",
        template: { kind: "default" },
      })
      check(
        (await adapter.readFile(row.notePath)).includes("## Preserved body"),
        "The migrated template is used when creating a row",
      )
    },
  },
  {
    name: "native recovery move preserves a newer destination draft",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      const scope = { vault: vaultPath, generation: loaded.generation }
      const oldPath = joinStoragePath(vaultPath, "recovery-old.canvas")
      const newPath = joinStoragePath(vaultPath, "recovery-new.canvas")
      try {
        await saveRecoveryDraft(oldPath, "old", "canvas", oldPath, scope)
        const moving = remapRecoveryDraft(oldPath, newPath, "canvas", newPath, scope)
        scheduleRecoveryDraft(newPath, "new", "canvas", newPath, scope)
        await moving
        await flushRecoveryDraft(newPath, "canvas", scope)
        check(
          (await readRecoveryDraft(newPath, scope))?.content === "new",
          "New recovery content survived",
        )
        check(
          (await readRecoveryDraft(oldPath, scope))?.content === "old",
          "Old recovery remained available",
        )
      } finally {
        await discardRecoveryDraft(oldPath, scope)
        await discardRecoveryDraft(newPath, scope)
      }
    },
  },
  {
    name: "native delayed canvas save follows the renamed file and keeps its revision",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      const oldPath = await adapter.createCanvasFile(vaultPath, vaultPath, "Pending Canvas")
      const draft =
        '{"nodes":[{"id":"draft","type":"text","text":"new","x":0,"y":0,"width":100,"height":100}],"edges":[]}'
      setStorageAdapter(adapter)
      try {
        const revisions = new FileRevisionTracker()
        await revisions.baseline(oldPath)
        const oldKey = {
          generation: loaded.generation,
          kind: "canvas" as const,
          documentId: oldPath,
        }
        const queue = new AutosaveCoordinator({
          delayMs: 60_000,
          save: ({ value }: { value: { path: string; json: string } }) =>
            revisions.save(value.path, value.json, undefined, () => {}),
        })
        queue.schedule(oldKey, { path: oldPath, json: draft })
        const renamed = await adapter.renameItem(vaultPath, oldPath, "Moved Canvas")
        check(renamed.primaryPath, "Renamed canvas has a path")
        const newPath = renamed.primaryPath
        const newKey = { ...oldKey, documentId: newPath }
        remapLayerAutosave(queue, revisions, oldKey, newKey)
        await queue.flush(newKey)
        check((await adapter.readFile(newPath)) === draft, "Draft was saved to the renamed canvas")
        check(!queue.inspect(newKey)?.dirty, "The renamed canvas was marked saved")
      } finally {
        setStorageAdapter(null)
      }
    },
  },
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
    name: "native attached database preserves the open note identity in the tree",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      await adapter.setDatabaseModuleEnabled(true, loaded.generation)
      const note = await adapter.createNote(vaultPath, vaultPath, "Attached identity")
      const id = note.primaryId!
      setStorageAdapter(adapter)
      try {
        const created = await createDatabase({
          expectedGeneration: loaded.generation,
          mode: "attached",
          notePath: note.primaryPath!,
          name: "Attached identity",
        })
        const manifest = JSON.parse(await adapter.readFile(created.manifestPath))
        check(
          manifest.databaseId === created.databaseId,
          "Attachment publishes its manifest before opening the database",
        )
        check(
          (await noteLayers(created.notePath!)).database,
          "The attached layer is discoverable immediately",
        )
        const catalog = await listDatabases()
        check(
          catalog.find((database) => database.databaseId === created.databaseId)?.attachedNoteId ===
            id,
          "The catalog connects the database to the existing note before opening it",
        )
        const refreshed = await adapter.loadActiveVaultData()
        const row = refreshed.tree.find((item) => item.id === id)
        check(row, "The note still has a tree row under its original ID")
        check(row.path === created.notePath, "The row follows the promoted Markdown note")
        check(row.type === "file", "The attached database does not replace the note identity")
        await adapter.readNote(vaultPath, id)
      } finally {
        setStorageAdapter(null)
      }
    },
  },
  {
    name: "native database writes emit the shared window invalidation",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      await adapter.setDatabaseModuleEnabled(true, loaded.generation)
      const seen: Array<{ generation: number; paths: string[] }> = []
      const stop = await listen<{ generation: number; paths: string[] }>(
        "amby:database-written",
        (event) => seen.push(event.payload),
      )
      setStorageAdapter(adapter)
      try {
        const created = await createDatabase({
          expectedGeneration: loaded.generation,
          mode: "standalone",
          parentPath: vaultPath,
          name: "Database event",
        })
        const deadline = Date.now() + 5000
        while (
          !seen.some((event) => event.paths.includes(created.manifestPath)) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(
          seen.some(
            (event) =>
              event.generation === loaded.generation && event.paths.includes(created.manifestPath),
          ),
          "Database write notification reached the WebView",
        )
      } finally {
        setStorageAdapter(null)
        stop()
      }
    },
  },
  {
    name: "native own file changes notify windows after publication",
    async run({ adapter, vaultPath }) {
      const loaded = await adapter.loadActiveVaultData()
      const target = await adapter.createNote(vaultPath, vaultPath, "Target")
      const source = await adapter.createNote(vaultPath, vaultPath, "Source")
      const before = await adapter.readNote(vaultPath, source.primaryId!)
      await adapter.writeNote(
        vaultPath,
        source.primaryId!,
        "See [[Target]]",
        loaded.generation,
        before.revision,
        "main",
      )
      const seen: Array<{ generation: number; paths: string[]; originWindow?: string }> = []
      const stop = await listen<{ generation: number; paths: string[]; originWindow?: string }>(
        "amby:files-changed",
        (event) => seen.push(event.payload),
      )
      const waitForPath = async (path: string) => {
        const deadline = Date.now() + 5000
        while (
          !seen.some(
            (event) => event.generation === loaded.generation && event.paths.includes(path),
          ) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(
          seen.some(
            (event) => event.generation === loaded.generation && event.paths.includes(path),
          ),
          `Published path was not notified: ${path}`,
        )
      }
      const movedEvents: Array<{
        generation: number
        originWindow: string
        pathChanges: Array<{ oldPath: string; newPath: string }>
      }> = []
      const stopMoved = await listen<(typeof movedEvents)[number]>("amby:paths-moved", (event) =>
        movedEvents.push(event.payload),
      )
      try {
        const standalone = await adapter.createNote(vaultPath, vaultPath, "Standalone")
        await waitForPath(standalone.primaryPath!)
        seen.length = 0
        const moved = await adapter.renameItem(
          vaultPath,
          standalone.primaryPath!,
          "Standalone renamed",
        )
        await waitForPath(standalone.primaryPath!)
        await waitForPath(moved.primaryPath!)
        const deadline = Date.now() + 5000
        while (
          !movedEvents.some((event) =>
            event.pathChanges.some(
              (change) =>
                change.oldPath === standalone.primaryPath && change.newPath === moved.primaryPath,
            ),
          ) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(
          movedEvents.some(
            (event) =>
              event.generation === loaded.generation &&
              event.originWindow === getCurrentWindow().label &&
              event.pathChanges.some(
                (change) =>
                  change.oldPath === standalone.primaryPath && change.newPath === moved.primaryPath,
              ),
          ),
          "Move event carries the source window and exact paths",
        )
        seen.length = 0
        await adapter.deleteItem(vaultPath, moved.primaryPath!, "permanent")
        await waitForPath(moved.primaryPath!)
        seen.length = 0
        await adapter.renameItem(vaultPath, target.primaryPath!, "Renamed")
        await waitForPath(source.primaryPath!)
        check(
          (await adapter.readNote(vaultPath, source.primaryId!)).content.includes("Renamed"),
          "The inbound link was rewritten",
        )
        seen.length = 0
        const canvas = await adapter.createCanvasFile(vaultPath, vaultPath, "Board")
        await adapter.writeFile(canvas, '{"nodes":[],"edges":[]}')
        await waitForPath(canvas)
        seen.length = 0
        const copy = await adapter.saveConflictCopy(source.primaryPath!, "local version")
        await waitForPath(copy)
        seen.length = 0
        await adapter.deleteItem(vaultPath, source.primaryPath!, "archive")
        const trash = await adapter.listArchive()
        await adapter.restoreArchive(trash[0].id)
        await waitForPath(source.primaryPath!)
      } finally {
        stopMoved()
        stop()
      }
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
      await adapter.deleteItem(vaultPath, note.primaryPath!, "archive")
      const trash = await adapter.listArchive()
      check(trash.length === 1, "Delete entered the vault archive")
      const rootPreview = await adapter.readArchivePreview(trash[0].id, "")
      const preview = rootPreview.directory
        ? await adapter.readArchivePreview(
            trash[0].id,
            rootPreview.children.find((child) => child.name.endsWith(".md"))!.path,
          )
        : rootPreview
      check(preview.text === original, "Archive preview reads the exact archived bytes")
      check((await adapter.listArchive()).length === 1, "Preview leaves the item in the archive")
      let escaped = false
      try {
        await adapter.readArchivePreview(trash[0].id, "../outside.md")
      } catch {
        escaped = true
      }
      check(escaped, "Archive preview rejects paths outside its payload")
      const restored = await adapter.restoreArchive(trash[0].id)
      check(
        (await adapter.readFile(restored.primaryPath!)) === original,
        "Restored bytes are intact",
      )
    },
  },
  {
    name: "native conditional file write rejects a stale revision and keeps the newer bytes",
    async run({ adapter, vaultPath }) {
      const note = await adapter.createNote(vaultPath, vaultPath, "Conditional File")
      const path = note.primaryPath!
      const baseline = await adapter.getFileRevision(path)
      check(baseline.length === 64, "Revision is a SHA-256 hex digest")
      const first = await adapter.writeFile(path, "first", baseline)
      check(first !== baseline, "A successful write returns the new revision")
      check((await adapter.getFileRevision(path)) === first, "Returned revision matches disk")
      // An external editor changes the file after the buffer was loaded.
      await adapter.writeFile(path, "external edit")
      let conflict: unknown
      try {
        await adapter.writeFile(path, "stale buffer", first)
      } catch (error) {
        conflict = error
      }
      check(conflict instanceof FileRevisionConflictError, "Stale revision is a typed conflict")
      check(
        (await adapter.readFile(path)) === "external edit",
        "A conflicting write leaves the newer bytes untouched",
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
      await settingsRepository.writeVaultRaw("archive", "blocker")

      let failed = false
      try {
        await adapter.deleteItem(vaultPath, note.primaryPath!, "archive")
      } catch {
        failed = true
      }
      check(failed, "A non-directory archive root rejects deletion")
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
