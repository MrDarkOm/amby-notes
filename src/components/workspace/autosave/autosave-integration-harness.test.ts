import { describe, expect, it } from "vitest"
import { AutosaveCoordinator, type AutosaveKey } from "./autosave-coordinator"

interface NoteState {
  content: string
  revision: string
}

interface BackendEvent {
  noteId: string
  revision: string
  origin: string
}

class RevisionConflict extends Error {}

/** Shared fake IPC/backend used to exercise two independent renderer buffers. */
class SharedFakeBackend {
  private readonly notes = new Map<string, NoteState>()
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private nextRevision = 1
  watcherOwner: string | null = null

  constructor(noteId: string, content: string) {
    this.notes.set(noteId, { content, revision: this.revision() })
  }

  read(noteId: string): NoteState {
    const note = this.notes.get(noteId)
    if (!note) throw new Error(`Missing note ${noteId}`)
    return { ...note }
  }

  async write(noteId: string, content: string, expectedRevision: string, origin: string) {
    const current = this.read(noteId)
    if (current.revision !== expectedRevision) throw new RevisionConflict()
    const next = { content, revision: this.revision() }
    this.notes.set(noteId, next)
    this.emit({ noteId, revision: next.revision, origin })
    return { ...next }
  }

  externalEdit(noteId: string, content: string) {
    const next = { content, revision: this.revision() }
    this.notes.set(noteId, next)
    this.emit({ noteId, revision: next.revision, origin: "external-editor" })
  }

  listen(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  startWatcher(windowLabel: string) {
    if (!this.watcherOwner) this.watcherOwner = windowLabel
  }

  private emit(event: BackendEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private revision(): string {
    return `r${this.nextRevision++}`
  }
}

interface RendererDocument extends NoteState {
  dirty: boolean
  conflict?: NoteState
}

class FakeRenderer {
  private readonly documents = new Map<string, RendererDocument>()
  private generation = 1
  private readonly disposeListener: () => void
  private readonly autosave: AutosaveCoordinator<{
    noteId: string
    content: string
    revision: string
  }>

  constructor(
    readonly label: string,
    private readonly backend: SharedFakeBackend,
  ) {
    this.autosave = new AutosaveCoordinator({
      delayMs: 200,
      save: async ({ value }) => {
        const saved = await backend.write(value.noteId, value.content, value.revision, label)
        const document = this.documents.get(value.noteId)
        if (document?.content === value.content) {
          document.revision = saved.revision
          document.dirty = false
        }
      },
      onSaveFailure: ({ value }, error) => {
        if (!(error instanceof RevisionConflict)) return
        const document = this.documents.get(value.noteId)
        if (!document) return
        document.conflict = this.backend.read(value.noteId)
      },
    })
    this.disposeListener = backend.listen((event) => this.onBackendEvent(event))
  }

  open(noteId: string) {
    const note = this.backend.read(noteId)
    this.documents.set(noteId, { ...note, dirty: false })
  }

  edit(noteId: string, content: string, immediate = false) {
    const document = this.document(noteId)
    document.content = content
    document.dirty = true
    const key = this.key(noteId)
    const value = { noteId, content, revision: document.revision }
    if (immediate) this.autosave.enqueueImmediate(key, value)
    else this.autosave.schedule(key, value)
  }

  restoreRecovery(noteId: string, content: string) {
    this.edit(noteId, content, true)
  }

  async flush(noteId: string) {
    await this.autosave.flush(this.key(noteId))
  }

  async switchVault(noteId: string) {
    await this.flush(noteId)
    this.autosave.cancelGeneration(this.generation)
    this.generation += 1
    this.documents.clear()
  }

  snapshot(noteId: string): RendererDocument {
    return { ...this.document(noteId) }
  }

  dispose() {
    this.disposeListener()
  }

  private key(noteId: string): AutosaveKey {
    return { generation: this.generation, kind: "markdown", documentId: noteId }
  }

  private document(noteId: string): RendererDocument {
    const document = this.documents.get(noteId)
    if (!document) throw new Error(`Renderer ${this.label} did not open ${noteId}`)
    return document
  }

  private onBackendEvent(event: BackendEvent) {
    if (event.origin === this.label) return
    const document = this.documents.get(event.noteId)
    if (!document) return
    const current = this.backend.read(event.noteId)
    if (document.dirty) {
      document.conflict = current
      return
    }
    document.content = current.content
    document.revision = current.revision
  }
}

describe("two-renderer autosave integration harness", () => {
  it("converges rapid edits, preserves a stale dirty buffer as conflict, and keeps watcher ownership in main", async () => {
    const backend = new SharedFakeBackend("note", "initial")
    backend.startWatcher("main")
    const main = new FakeRenderer("main", backend)
    const child = new FakeRenderer("note-1", backend)
    main.open("note")
    child.open("note")

    // A second edit arrives before the 200 ms debounce; the final version wins.
    main.edit("note", "first")
    main.edit("note", "rapid final", true)
    await main.flush("note")
    expect(backend.read("note")).toMatchObject({ content: "rapid final" })
    expect(child.snapshot("note")).toMatchObject({ content: "rapid final", dirty: false })

    // A dirty child must not be silently overwritten by a save from main.
    child.edit("note", "child local")
    main.edit("note", "main wins", true)
    await main.flush("note")
    await expect(child.flush("note")).rejects.toBeInstanceOf(RevisionConflict)
    expect(backend.read("note")).toMatchObject({ content: "main wins" })
    expect(child.snapshot("note")).toMatchObject({
      content: "child local",
      dirty: true,
      conflict: { content: "main wins" },
    })

    // Closing a detached window never relinquishes the process-wide watcher.
    child.dispose()
    expect(backend.watcherOwner).toBe("main")
    main.dispose()
  })

  it("reloads clean external edits, persists confirmed recovery, and flushes before vault switch", async () => {
    const backend = new SharedFakeBackend("note", "initial")
    const main = new FakeRenderer("main", backend)
    main.open("note")

    backend.externalEdit("note", "edited outside Amby")
    expect(main.snapshot("note")).toMatchObject({ content: "edited outside Amby", dirty: false })

    main.restoreRecovery("note", "confirmed recovery")
    await main.switchVault("note")
    expect(backend.read("note")).toMatchObject({ content: "confirmed recovery" })
    main.dispose()
  })
})
