// @vitest-environment happy-dom
// An unsaved version of a canvas or a sketch found after a crash (docs/notices.md, section 9): the application
// asks in its own window. "Yes" opens the saved draft; only the button "Do not restore" drops it. Escape and a
// click beside the window close the question without an answer: the draft stays in the journal, the canvas opens
// as it is on the disk and cannot be edited (an edit would write over the draft), and the question comes again
// when the layer is opened again.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { serializeCanvas } from "@/lib/canvas-format"
import { defaultSketchJson, serializeSketch, createDefaultSketch } from "@/lib/sketch-format"
import { confirmChoice, type ConfirmOutcome } from "@/lib/confirm"
import * as drafts from "@/lib/recovery-drafts"
import * as storage from "@/lib/storage"
import { useCanvasWorkspace } from "./use-canvas-workspace"
import { useSketchWorkspace } from "./use-sketch-workspace"
import { useHeldDraftsStore } from "../held-drafts-store"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn(), confirmChoice: vi.fn() }))

const scope = { vault: "/vault", generation: 1 }
const t = ((key: string) => key) as never

const canvasOnDisk = serializeCanvas({ nodes: [], edges: [] })
const canvasDraft = serializeCanvas({
  nodes: [{ id: "n1", type: "text", text: "после сбоя", x: 0, y: 0, width: 100, height: 50 }],
  edges: [],
})
const sketchOnDisk = defaultSketchJson()
const sketchDraft = serializeSketch({
  ...createDefaultSketch(),
  elements: [{ id: "e1", type: "rectangle", x: 1, y: 1, width: 10, height: 10 } as never],
})

beforeEach(() => {
  vi.mocked(confirmChoice).mockReset()
  useHeldDraftsStore.setState(useHeldDraftsStore.getInitialState())
  vi.spyOn(storage, "getFileRevision").mockResolvedValue("rev-1")
  vi.spyOn(drafts, "discardRecoveryDraft").mockResolvedValue(undefined as never)
  vi.spyOn(drafts, "scheduleRecoveryDraft").mockImplementation(() => {})
  vi.spyOn(drafts, "migrateLegacyRecoveryDrafts").mockResolvedValue(undefined as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const answer = (outcome: ConfirmOutcome) => vi.mocked(confirmChoice).mockResolvedValue(outcome)

describe.each([
  {
    kind: "canvas",
    disk: canvasOnDisk,
    draft: canvasDraft,
    mount: () => {
      const hook = renderHook(() => useCanvasWorkspace(1, t, scope))
      return {
        load: async (path: string) => {
          let content = ""
          await act(async () => {
            content = await hook.result.current.loadCanvasBuffer(path)
          })
          return content
        },
        buffer: (path: string) => hook.result.current.openCanvases[path],
        stop: () => hook.result.current.autosave.cancelGeneration(1),
      }
    },
  },
  {
    kind: "sketch",
    disk: sketchOnDisk,
    draft: sketchDraft,
    mount: () => {
      const hook = renderHook(() => useSketchWorkspace(1, t, scope))
      return {
        load: async (path: string) => {
          let content = ""
          await act(async () => {
            content = await hook.result.current.loadSketchBuffer(path)
          })
          return content
        },
        buffer: (path: string) => hook.result.current.openSketches[path],
        stop: () => hook.result.current.autosave.cancelGeneration(1),
      }
    },
  },
])("a $kind with a draft that differs from the disk", ({ kind, disk, draft, mount }) => {
  const path = `/vault/План.${kind === "canvas" ? "canvas" : "excalidraw"}`
  beforeEach(() => {
    vi.spyOn(storage, "readFile").mockResolvedValue(disk)
    vi.spyOn(drafts, "readRecoveryDraft").mockResolvedValue({ content: draft } as never)
  })

  it("asks once, in the application, and 'no' is worded as what it does", async () => {
    answer("no")
    const view = mount()
    await view.load(path)
    view.stop()
    expect(confirmChoice).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirmChoice).mock.calls[0][0]
    expect(question.title.trim().endsWith("?")).toBe(true)
    expect(question.cancelLabel).toBe("Не восстанавливать")
  })

  it("'Do not restore' keeps the disk and drops the draft", async () => {
    answer("no")
    const view = mount()
    expect(await view.load(path)).toBe(disk)
    view.stop()
    expect(drafts.discardRecoveryDraft).toHaveBeenCalledWith(path, scope)
    expect(useHeldDraftsStore.getState().held[path]).toBeUndefined()
  })

  it("'Restore' opens the draft and keeps it as a draft until it is saved", async () => {
    answer("yes")
    const view = mount()
    expect(await view.load(path)).toBe(draft)
    view.stop()
    expect(drafts.scheduleRecoveryDraft).toHaveBeenCalledWith(path, draft, kind, path, scope)
    expect(useHeldDraftsStore.getState().held[path]).toBeUndefined()
  })

  it("closing without an answer opens the disk, keeps the draft and holds the layer", async () => {
    answer("dismissed")
    const view = mount()
    expect(await view.load(path)).toBe(disk)
    view.stop()
    expect(drafts.discardRecoveryDraft).not.toHaveBeenCalled()
    expect(drafts.scheduleRecoveryDraft).not.toHaveBeenCalled()
    expect(useHeldDraftsStore.getState().held[path]).toBeDefined()
  })

  it("asks again when it is opened again, and 'Restore' then puts the draft in the buffer", async () => {
    answer("dismissed")
    const view = mount()
    await view.load(path)
    answer("yes")
    await act(async () => {
      await useHeldDraftsStore.getState().held[path].resolve()
    })
    view.stop()
    expect(confirmChoice).toHaveBeenCalledTimes(2)
    expect(view.buffer(path)).toBe(draft)
    expect(useHeldDraftsStore.getState().held[path]).toBeUndefined()
    // The draft is kept as a draft until the restored version is saved.
    expect(drafts.scheduleRecoveryDraft).toHaveBeenCalledWith(path, draft, kind, path, scope)
  })

  it("asked again, 'Do not restore' drops the draft and lets the layer be edited", async () => {
    answer("dismissed")
    const view = mount()
    await view.load(path)
    answer("no")
    await act(async () => {
      await useHeldDraftsStore.getState().held[path].resolve()
    })
    view.stop()
    expect(drafts.discardRecoveryDraft).toHaveBeenCalledWith(path, scope)
    expect(useHeldDraftsStore.getState().held[path]).toBeUndefined()
  })

  it("closed again, the draft stays and the layer stays held", async () => {
    answer("dismissed")
    const view = mount()
    await view.load(path)
    await act(async () => {
      await useHeldDraftsStore.getState().held[path].resolve()
    })
    view.stop()
    expect(drafts.discardRecoveryDraft).not.toHaveBeenCalled()
    expect(useHeldDraftsStore.getState().held[path]).toBeDefined()
  })

  it("does not ask when the draft is the same as the disk", async () => {
    vi.mocked(drafts.readRecoveryDraft).mockResolvedValue({ content: disk } as never)
    const view = mount()
    await view.load(path)
    view.stop()
    expect(confirmChoice).not.toHaveBeenCalled()
  })
})
