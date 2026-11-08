// @vitest-environment happy-dom
// An unsaved version of a canvas or a sketch found after a crash (docs/notices.md, section 9): the application
// asks in its own window. "Yes" opens the saved draft; "no" keeps what is on the disk and the draft is dropped,
// exactly as it did with the window of the system. The text says so.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { serializeCanvas } from "@/lib/canvas-format"
import { defaultSketchJson, serializeSketch, createDefaultSketch } from "@/lib/sketch-format"
import { confirm } from "@/lib/confirm"
import * as drafts from "@/lib/recovery-drafts"
import * as storage from "@/lib/storage"
import { useCanvasWorkspace } from "./use-canvas-workspace"
import { useSketchWorkspace } from "./use-sketch-workspace"

vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

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
  vi.mocked(confirm).mockReset()
  vi.spyOn(storage, "getFileRevision").mockResolvedValue("rev-1")
  vi.spyOn(drafts, "discardRecoveryDraft").mockResolvedValue(undefined as never)
  vi.spyOn(drafts, "scheduleRecoveryDraft").mockImplementation(() => {})
  vi.spyOn(drafts, "migrateLegacyRecoveryDrafts").mockResolvedValue(undefined as never)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe.each([
  {
    kind: "canvas",
    disk: canvasOnDisk,
    draft: canvasDraft,
    load: async (path: string) => {
      const hook = renderHook(() => useCanvasWorkspace(1, t, scope))
      let content = ""
      await act(async () => {
        content = await hook.result.current.loadCanvasBuffer(path)
      })
      hook.result.current.autosave.cancelGeneration(1)
      return content
    },
  },
  {
    kind: "sketch",
    disk: sketchOnDisk,
    draft: sketchDraft,
    load: async (path: string) => {
      const hook = renderHook(() => useSketchWorkspace(1, t, scope))
      let content = ""
      await act(async () => {
        content = await hook.result.current.loadSketchBuffer(path)
      })
      hook.result.current.autosave.cancelGeneration(1)
      return content
    },
  },
])("a $kind with a draft that differs from the disk", ({ kind, disk, draft, load }) => {
  const path = `/vault/План.${kind === "canvas" ? "canvas" : "excalidraw"}`
  beforeEach(() => {
    vi.spyOn(storage, "readFile").mockResolvedValue(disk)
    vi.spyOn(drafts, "readRecoveryDraft").mockResolvedValue({ content: draft } as never)
  })

  it("asks once, in the application, and says what 'no' does to the draft", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    await load(path)
    expect(confirm).toHaveBeenCalledTimes(1)
    const question = vi.mocked(confirm).mock.calls[0][0]
    expect(question.title.trim().endsWith("?")).toBe(true)
    expect(question.description).toBeTruthy()
    expect(question.confirmLabel).toBeTruthy()
  })

  it("keeps the disk and drops the draft on 'no'", async () => {
    vi.mocked(confirm).mockResolvedValue(false)
    expect(await load(path)).toBe(disk)
    expect(drafts.discardRecoveryDraft).toHaveBeenCalledWith(path, scope)
  })

  it("opens the draft on 'yes' and keeps it as a draft until it is saved", async () => {
    vi.mocked(confirm).mockResolvedValue(true)
    expect(await load(path)).toBe(draft)
    expect(drafts.scheduleRecoveryDraft).toHaveBeenCalledWith(path, draft, kind, path, scope)
  })

  it("does not ask when the draft is the same as the disk", async () => {
    vi.mocked(drafts.readRecoveryDraft).mockResolvedValue({ content: disk } as never)
    await load(path)
    expect(confirm).not.toHaveBeenCalled()
  })
})
