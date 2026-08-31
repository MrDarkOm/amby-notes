import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebAdapter, WebStorageError } from "./web-adapter"
import { DesktopAdapter } from "./desktop-adapter"
import {
  notesRepository,
  mutationsRepository,
  settingsRepository,
  setStorageAdapter,
} from "./index"
import { commands } from "@/lib/bindings"
import { NoteRevisionConflictError } from "./types"
import { runStorageContract } from "./storage-contract.test-support"

describe("Storage Modular Architecture & Contract Tests (WP-23)", () => {
  describe("WebAdapter domain contract", () => {
    let adapter: WebAdapter
    let store: Map<string, string>

    beforeEach(() => {
      store = new Map<string, string>()
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      })
      adapter = new WebAdapter()
      setStorageAdapter(adapter)
    })

    runStorageContract("browser", () => ({ adapter, vaultPath: "web-vault" }))

    it("returns the authoritative active vault identity with refresh data", async () => {
      await expect(adapter.loadActiveVaultData()).resolves.toMatchObject({
        vaultPath: "web-vault",
        generation: 0,
      })
    })

    it("restores plain Markdown without writing a browser path into a YAML id", async () => {
      const path = "web-vault/Restored.md"
      await adapter.restoreDeletedNote(
        "web-vault",
        path,
        path,
        "New body",
        "Old body",
        null,
        "main",
      )
      expect(await adapter.readFile(path)).toBe("New body")
    })

    it("normalizes browser quota errors without exposing the storage operation", async () => {
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: () => {
          throw new DOMException("quota reached", "QuotaExceededError")
        },
        removeItem: (k: string) => store.delete(k),
        clear: () => store.clear(),
      })

      await expect(adapter.writeGlobalRaw("settings.json", "{}")).rejects.toBeInstanceOf(
        WebStorageError,
      )
      await expect(adapter.writeGlobalRaw("settings.json", "{}")).rejects.toMatchObject({
        code: "quotaExceeded",
      })
    })

    it("handles note lifecycle (create, read, write, move, delete)", async () => {
      // 1. Create note
      const createRes = await notesRepository.createNote("web-vault", "web-vault", "Project")
      expect(createRes.primaryPath).toBe("web-vault/Project.md")

      // 2. Write note
      const initial = await notesRepository.readNote("web-vault", "web-vault/Project.md")
      await notesRepository.writeNote(
        "web-vault",
        "web-vault/Project.md",
        "Initial text",
        null,
        initial.revision,
        "web",
      )

      // 3. Read note
      const read = await notesRepository.readNote("web-vault", "web-vault/Project.md")
      expect(read.content).toBe("Initial text")

      // 4. Rename item
      const renameRes = await mutationsRepository.renameItem(
        "web-vault",
        "web-vault/Project.md",
        "RenamedProject",
      )
      expect(renameRes.primaryPath).toBe("web-vault/RenamedProject.md")

      // 5. Delete item
      const delRes = await mutationsRepository.deleteItem(
        "web-vault",
        "web-vault/RenamedProject.md",
      )
      expect(delRes.deletedPaths).toContain("web-vault/RenamedProject.md")
    })

    it("rejects a stale second renderer write instead of overwriting the first", async () => {
      const path = "web-vault/Welcome.md"
      const firstRenderer = await notesRepository.readNote("web-vault", path)
      const secondRenderer = await notesRepository.readNote("web-vault", path)

      await notesRepository.writeNote(
        "web-vault",
        path,
        "saved by first renderer",
        null,
        firstRenderer.revision,
        "first",
      )
      await expect(
        notesRepository.writeNote(
          "web-vault",
          path,
          "stale second renderer",
          null,
          secondRenderer.revision,
          "second",
        ),
      ).rejects.toBeInstanceOf(NoteRevisionConflictError)
      await expect(notesRepository.readNote("web-vault", path)).resolves.toMatchObject({
        content: "saved by first renderer",
      })
    })

    it("handles custom properties", async () => {
      const prop = await notesRepository.upsertCustomProperty("web-vault", "note-1", {
        id: "",
        name: "Priority",
        icon: "star",
        propertyType: "text",
        value: "High",
        settings: "{}",
      })
      expect(prop.id).toBeTruthy()
      expect(prop.value).toBe("High")

      const props = await notesRepository.getNoteProperties("web-vault", "note-1")
      expect(props.customProperties).toHaveLength(1)
      expect(props.customProperties[0].name).toBe("Priority")

      await notesRepository.deleteCustomProperty("web-vault", "note-1", prop.id)
      const afterDel = await notesRepository.getNoteProperties("web-vault", "note-1")
      expect(afterDel.customProperties).toHaveLength(0)
    })

    it("handles tiered settings, corrupt backups, and AI credentials", async () => {
      // 1. Settings JSON read/write
      await settingsRepository.saveGlobalJSON("config.json", { theme: "dark" })
      const loaded = await settingsRepository.loadGlobalJSON("config.json", { theme: "light" })
      expect(loaded).toEqual({ theme: "dark" })

      // 2. Corrupt backup
      await settingsRepository.writeGlobalRaw("bad.json", "{ invalid json")
      const fallback = await settingsRepository.loadGlobalJSON("bad.json", { safe: true })
      expect(fallback).toEqual({ safe: true })

      // 3. AI Credentials
      await settingsRepository.storeAiCredential("cred-1", "sk-secret123456789")
      const info = await settingsRepository.inspectAiCredential("cred-1")
      expect(info.exists).toBe(true)
      expect(info.masked).toContain("••••")

      await settingsRepository.deleteAiCredential("cred-1")
      const infoAfter = await settingsRepository.inspectAiCredential("cred-1")
      expect(infoAfter.exists).toBe(false)
    })
  })

  describe("DesktopAdapter delegation (mocked commands, not a live contract)", () => {
    let adapter: DesktopAdapter

    it("joins Windows verbatim folder paths without invalid forward slashes", async () => {
      const command = vi
        .spyOn(commands, "createFolder")
        .mockResolvedValue({ status: "ok", data: null })
      const parent = "\\\\?\\C:\\Vault"
      await expect(new DesktopAdapter().createFolder(parent, "Nested")).resolves.toBe(
        `${parent}\\Nested`,
      )
      expect(command).toHaveBeenCalledWith(`${parent}\\Nested`)
    })

    beforeEach(() => {
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
      adapter = new DesktopAdapter()
      setStorageAdapter(adapter)
    })

    it("delegates readNote and writeNote to generated commands", async () => {
      const readSpy = vi.spyOn(commands, "readNote").mockResolvedValue({
        status: "ok",
        data: {
          content: "desktop note content",
          revision: "revision-1",
          source: "---\nid: note-ulid-1\n---\ndesktop note content",
        },
      })

      const note = await notesRepository.readNote("/vault", "note-ulid-1")
      expect(note).toEqual({
        content: "desktop note content",
        revision: "revision-1",
        source: "---\nid: note-ulid-1\n---\ndesktop note content",
      })
      expect(readSpy).toHaveBeenCalledWith("note-ulid-1")

      const writeSpy = vi.spyOn(commands, "writeNote").mockResolvedValue({
        status: "ok",
        data: {
          path: "/vault/note.md",
          revision: "revision-2",
          indexState: "healthy",
          warnings: [],
        },
      })

      await notesRepository.writeNote(
        "/vault",
        "note-ulid-1",
        "new content",
        5,
        "revision-1",
        "main",
      )
      expect(writeSpy).toHaveBeenCalledWith({
        expectedGeneration: 5,
        noteId: "note-ulid-1",
        content: "new content",
        expectedRevision: "revision-1",
        originWindow: "main",
      })
    })

    it("preserves the typed stale-revision conflict from the IPC command", async () => {
      vi.spyOn(commands, "writeNote").mockResolvedValue({
        status: "error",
        error: { kind: "revisionConflict", actual_revision: "revision-current" },
      })

      await expect(
        notesRepository.writeNote(
          "/vault",
          "note-ulid-1",
          "stale content",
          5,
          "revision-stale",
          "main",
        ),
      ).rejects.toMatchObject({
        name: "NoteRevisionConflictError",
        actualRevision: "revision-current",
      })
    })

    it("delegates deleted-note restoration with the exact source template", async () => {
      const restoreSpy = vi.spyOn(commands, "restoreDeletedNote").mockResolvedValue({
        status: "ok",
        data: {
          path: "/vault/Note.md",
          revision: "restored-revision",
          indexState: "healthy",
          warnings: [],
        },
      })
      const sourceTemplate = "---\n# opaque\nid: note-ulid-1\n---\nold body"

      await notesRepository.restoreDeletedNote(
        "/vault",
        "note-ulid-1",
        "/vault/Note.md",
        "latest local body",
        sourceTemplate,
        5,
        "main",
      )

      expect(restoreSpy).toHaveBeenCalledWith({
        expectedGeneration: 5,
        noteId: "note-ulid-1",
        path: "/vault/Note.md",
        content: "latest local body",
        sourceTemplate,
        originWindow: "main",
      })
    })

    it("delegates AI credentials to generated commands", async () => {
      const storeSpy = vi.spyOn(commands, "storeAiCredential").mockResolvedValue({
        status: "ok",
        data: null,
      })
      const inspectSpy = vi.spyOn(commands, "inspectAiCredential").mockResolvedValue({
        status: "ok",
        data: { exists: true, masked: "sk-••••1234" },
      })
      const deleteSpy = vi.spyOn(commands, "deleteAiCredential").mockResolvedValue({
        status: "ok",
        data: null,
      })

      await settingsRepository.storeAiCredential("cred-1", "secret")
      expect(storeSpy).toHaveBeenCalledWith("cred-1", "secret")

      const info = await settingsRepository.inspectAiCredential("cred-1")
      expect(info.masked).toBe("sk-••••1234")
      expect(inspectSpy).toHaveBeenCalledWith("cred-1")

      await settingsRepository.deleteAiCredential("cred-1")
      expect(deleteSpy).toHaveBeenCalledWith("cred-1")
    })
  })
})
