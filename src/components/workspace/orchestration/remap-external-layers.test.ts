import { afterEach, describe, expect, it, vi } from "vitest"

const recovery = vi.hoisted(() => ({ remapRecoveryDraft: vi.fn(async () => {}) }))
vi.mock("@/lib/recovery-drafts", () => recovery)
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { FileRevisionTracker } from "../autosave/file-revision-tracker"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import { remapExternalLayers } from "./remap-external-layers"

afterEach(() => {
  useDocStore.getState().clearDocs()
  useTabsStore.getState().setTabs([])
  vi.clearAllMocks()
})

describe("remapExternalLayers", () => {
  for (const kind of ["canvas", "sketch"] as const) {
    it(`moves an open dirty ${kind} and its queued save, tab and recovery`, async () => {
      const oldPath = "/vault/old." + (kind === "canvas" ? "canvas" : "excalidraw")
      const newPath = oldPath.replace("old", "new")
      let buffers: Record<string, string> = { [oldPath]: "draft" }
      const saves: string[] = []
      const autosave = new AutosaveCoordinator({
        delayMs: 10000,
        save: async ({ value }: { value: { path: string; json: string } }) => {
          saves.push(value.path)
        },
      })
      const key = (path: string): AutosaveKey => ({ generation: 4, kind, documentId: path })
      const revisions = new FileRevisionTracker()
      revisions.commit(oldPath, "original")
      autosave.schedule(key(oldPath), { path: oldPath, json: "draft" })
      useDocStore.getState().setDoc(oldPath, {
        id: oldPath,
        path: oldPath,
        title: "old",
        content: "draft",
        source: "",
        created: "",
        modified: "",
        wordCount: 0,
      })
      useDocStore.getState().markUnsaved(oldPath)
      useTabsStore
        .getState()
        .setTabs([
          { key: "tab", kind, fileId: oldPath, title: "old", history: [oldPath], historyIndex: 0 },
        ])
      remapExternalLayers(
        [{ oldPath, newPath }],
        [
          {
            kind,
            autosave,
            key,
            revisions,
            setBuffers: (fn) => {
              buffers = fn(buffers)
            },
          },
        ],
        { vault: "/vault", generation: 9 },
      )
      expect(buffers).toEqual({ [newPath]: "draft" })
      expect(useTabsStore.getState().tabs[0]).toMatchObject({ fileId: newPath, history: [newPath] })
      expect(useDocStore.getState().openDocs[newPath]).toMatchObject({
        id: newPath,
        path: newPath,
        content: "draft",
      })
      expect(useDocStore.getState().unsavedFileIds.has(newPath)).toBe(true)
      expect(recovery.remapRecoveryDraft).toHaveBeenCalledWith(oldPath, newPath, kind, newPath, {
        vault: "/vault",
        generation: 9,
      })
      await autosave.flush(key(newPath))
      expect(saves).toEqual([newPath])
    })
  }

  it("keeps both buffers untouched if the destination is already open", () => {
    let buffers = { "/old.canvas": "old draft", "/new.canvas": "other draft" }
    const autosave = new AutosaveCoordinator<{ path: string; json: string }>({
      delayMs: 10000,
      save: async () => {},
    })
    const key = (path: string): AutosaveKey => ({ generation: 1, kind: "canvas", documentId: path })
    remapExternalLayers(
      [{ oldPath: "/old.canvas", newPath: "/new.canvas" }],
      [
        {
          kind: "canvas",
          setBuffers: (fn) => {
            buffers = fn(buffers) as typeof buffers
          },
          autosave,
          key,
          revisions: new FileRevisionTracker(),
        },
      ],
      { vault: "/", generation: 1 },
    )
    expect(buffers).toEqual({ "/old.canvas": "old draft", "/new.canvas": "other draft" })
    expect(recovery.remapRecoveryDraft).not.toHaveBeenCalled()
  })
})
