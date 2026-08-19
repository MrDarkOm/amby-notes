import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebAdapter } from "./web-adapter"
import { DesktopAdapter } from "./desktop-adapter"
import {
  notesRepository,
  mutationsRepository,
  settingsRepository,
  setStorageAdapter,
} from "./index"
import { commands } from "@/lib/bindings"

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

    it("handles note lifecycle (create, read, write, move, delete)", async () => {
      // 1. Create note
      const createRes = await notesRepository.createNote("web-vault", "web-vault", "Project")
      expect(createRes.primaryPath).toBe("web-vault/Project.md")

      // 2. Write note
      await notesRepository.writeNote("web-vault", "web-vault/Project.md", "Initial text", null)

      // 3. Read note
      const read = await notesRepository.readNote("web-vault", "web-vault/Project.md")
      expect(read).toBe("Initial text")

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

  describe("DesktopAdapter with mocked Tauri commands", () => {
    let adapter: DesktopAdapter

    beforeEach(() => {
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
      adapter = new DesktopAdapter()
      setStorageAdapter(adapter)
    })

    it("delegates readNote and writeNote to generated commands", async () => {
      const readSpy = vi.spyOn(commands, "readNote").mockResolvedValue({
        status: "ok",
        data: "desktop note content",
      })

      const content = await notesRepository.readNote("/vault", "note-ulid-1")
      expect(content).toBe("desktop note content")
      expect(readSpy).toHaveBeenCalledWith("note-ulid-1")

      const writeSpy = vi.spyOn(commands, "writeNote").mockResolvedValue({
        status: "ok",
        data: { path: "/vault/note.md", indexState: "healthy", warnings: [] },
      })

      await notesRepository.writeNote("/vault", "note-ulid-1", "new content", 5)
      expect(writeSpy).toHaveBeenCalledWith(5, "note-ulid-1", "new content")
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
