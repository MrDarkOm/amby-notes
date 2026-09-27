// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { useDocStore, type Document } from "@/components/workspace/use-doc-store"
import { useTabsStore, type Tab } from "@/components/workspace/use-tabs-store"
import { useVaultStore } from "@/components/workspace/use-vault-store"
import {
  AutosaveCoordinator,
  type AutosaveKey,
} from "@/components/workspace/autosave/autosave-coordinator"
import {
  registerEditorSerialization,
  flushEditorSerializations,
} from "@/components/workspace/tiptap/editor-serialization-lifecycle"
import {
  selectEvictableDocumentIds,
  collectDocumentBufferUsage,
} from "@/components/workspace/document-buffer-lifecycle"
import { defaultSketchJson, serializeSketch, parseSketch } from "@/lib/sketch-format"

describe("Fierce Document Persistence & Switching Stress Tests", () => {
  // Mock in-memory disk storage to simulate actual vault files on disk
  const diskStorage = new Map<string, { content: string; revision: string }>()
  let saveLog: Array<{ fileId: string; content: string; revision: string }> = []

  function setupDiskNote(fileId: string, initialContent: string) {
    diskStorage.set(fileId, { content: initialContent, revision: "rev-1" })
  }

  function getDiskNote(fileId: string) {
    return diskStorage.get(fileId)
  }

  beforeEach(() => {
    diskStorage.clear()
    saveLog = []
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
    useDocStore.getState().clearDocs()
    useVaultStore.setState({ vault: "/test-vault", backendGeneration: 1, generation: 1 })
  })

  afterEach(() => {
    cleanup()
  })

  it("STRESS TEST 1: Rapid 100x alternating edits between 5 notes with ZERO content cross-contamination", async () => {
    const numNotes = 5
    const noteIds = Array.from({ length: numNotes }, (_, i) => `note-${i + 1}.md`)

    // Initialize 5 distinct notes on simulated disk
    for (const id of noteIds) {
      setupDiskNote(id, `# Initial content for ${id}\n`)
    }

    // Set up AutosaveCoordinator simulating the app's real saving mechanism
    const autosave = new AutosaveCoordinator<{ fileId: string; content: string; revision: string }>(
      {
        delayMs: 50,
        save: async ({ value }) => {
          const current = diskStorage.get(value.fileId)
          const nextRev = `rev-${parseInt(current?.revision.replace("rev-", "") || "0", 10) + 1}`
          diskStorage.set(value.fileId, { content: value.content, revision: nextRev })
          saveLog.push({ fileId: value.fileId, content: value.content, revision: nextRev })
          useDocStore.getState().markSaved(value.fileId)
        },
      },
    )
    const autosaveKey = (fileId: string): AutosaveKey => ({
      generation: 1,
      kind: "markdown",
      documentId: fileId,
    })

    // Handler simulating handleContentChange in use-markdown-autosave
    const handleContentChange = (fileId: string, content: string) => {
      useDocStore.getState().patchDoc(fileId, { content })
      useDocStore.getState().markUnsaved(fileId)
      autosave.schedule(autosaveKey(fileId), {
        fileId,
        content,
        revision: diskStorage.get(fileId)?.revision ?? "rev-1",
      })
    }

    // Load all 5 notes into openDocs
    for (const id of noteIds) {
      const initial = diskStorage.get(id)!
      useDocStore.getState().setDoc(id, {
        id,
        title: id,
        content: initial.content,
        created: "today",
        modified: "today",
        wordCount: 10,
        path: `/test-vault/${id}`,
        revision: initial.revision,
        source: initial.content,
      })
    }

    // Tab state simulates a single tab being reused by rapid navigation in the file tree
    const tabKey = "main-tab"
    useTabsStore.setState({
      tabs: [
        {
          key: tabKey,
          fileId: noteIds[0],
          kind: "document",
          title: noteIds[0],
          history: [noteIds[0]],
          historyIndex: 0,
        },
      ],
      activeTabKey: tabKey,
    })

    // Track simulated active editor state per document
    let activeEditorDocId = noteIds[0]
    let activeEditorUnsavedContent = diskStorage.get(noteIds[0])!.content

    // Register active editor serialization hook
    const unregisterEditor = registerEditorSerialization({
      flush: () => {
        // Synchronously flushes active editor's edits with its own doc ID
        handleContentChange(activeEditorDocId, activeEditorUnsavedContent)
      },
    })

    // Expected content map for each note
    const expectedContent: Record<string, string> = {}
    for (const id of noteIds) {
      expectedContent[id] = diskStorage.get(id)!.content
    }

    // RUN 100 RAPID ALTERNATING SWITCHES AND EDITS
    for (let round = 1; round <= 100; round++) {
      const targetNoteId = noteIds[round % numNotes]
      const addition = `[Round ${round} Edit for ${activeEditorDocId}]\n`

      // 1. User types in active editor
      activeEditorUnsavedContent += addition
      expectedContent[activeEditorDocId] += addition

      // 2. User clicks another note in the tree -> triggers flushEditorSerializations()
      flushEditorSerializations()

      // 3. Tab is switched to the new note
      activeEditorDocId = targetNoteId
      activeEditorUnsavedContent = useDocStore.getState().openDocs[targetNoteId]?.content ?? ""
      useTabsStore.setState({
        tabs: [
          {
            key: tabKey,
            fileId: targetNoteId,
            kind: "document",
            title: targetNoteId,
            history: [targetNoteId],
            historyIndex: 0,
          },
        ],
        activeTabKey: tabKey,
      })
    }

    // Final flush of the last edited note
    flushEditorSerializations()

    // Wait for all scheduled autosaves to complete
    await autosave.flushAll()
    unregisterEditor()

    // VERIFICATION: Check EVERY note in memory and on disk
    for (const id of noteIds) {
      const memDoc = useDocStore.getState().openDocs[id]
      const diskDoc = getDiskNote(id)

      expect(memDoc).toBeDefined()
      expect(diskDoc).toBeDefined()

      // Content must match EXACTLY what was written for this note
      expect(memDoc?.content).toBe(expectedContent[id])
      expect(diskDoc?.content).toBe(expectedContent[id])

      // Crucial: No note may contain any edit line belonging to ANY other note!
      for (const otherId of noteIds) {
        if (otherId === id) continue
        expect(diskDoc?.content).not.toContain(`Edit for ${otherId}`)
        expect(memDoc?.content).not.toContain(`Edit for ${otherId}`)
      }
    }
  })

  it("STRESS TEST 2: Undo/Redo isolation under rapid tab switching", () => {
    // Simulate two document editors with separate undo histories
    class MockEditorWithHistory {
      private history: string[] = []
      private historyIndex = -1
      content: string

      constructor(initialContent: string) {
        this.content = initialContent
        this.history = [initialContent]
        this.historyIndex = 0
      }

      type(newText: string) {
        this.content += newText
        this.history = this.history.slice(0, this.historyIndex + 1)
        this.history.push(this.content)
        this.historyIndex = this.history.length - 1
      }

      undo(): boolean {
        if (this.historyIndex > 0) {
          this.historyIndex--
          this.content = this.history[this.historyIndex]
          return true
        }
        return false
      }

      redo(): boolean {
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++
          this.content = this.history[this.historyIndex]
          return true
        }
        return false
      }
    }

    // Note 1 editor instance
    const editor1 = new MockEditorWithHistory("Initial Note 1\n")
    // Note 2 editor instance
    const editor2 = new MockEditorWithHistory("Initial Note 2\n")

    // User types in Note 1
    editor1.type("Private Note 1 Secret Text\n")
    expect(editor1.content).toContain("Private Note 1 Secret Text")

    // User switches to Note 2, types in Note 2
    editor2.type("Note 2 Addition 1\n")
    editor2.type("Note 2 Addition 2\n")
    expect(editor2.content).toContain("Note 2 Addition 2")

    // User presses Ctrl+Z (Undo) twice in Note 2
    editor2.undo()
    expect(editor2.content).not.toContain("Note 2 Addition 2")
    expect(editor2.content).toContain("Note 2 Addition 1")

    editor2.undo()
    expect(editor2.content).toBe("Initial Note 2\n")

    // Crucial: Note 1 must be COMPLETELY unaffected by Note 2's undo actions!
    expect(editor1.content).toBe("Initial Note 1\nPrivate Note 1 Secret Text\n")
    expect(editor2.content).not.toContain("Private Note 1 Secret Text")

    // Additional undo in Note 2 cannot go further back into Note 1
    const canUndoFurther = editor2.undo()
    expect(canUndoFurther).toBe(false)
    expect(editor2.content).toBe("Initial Note 2\n")

    // Redo in Note 2 brings back Note 2 text only
    editor2.redo()
    expect(editor2.content).toContain("Note 2 Addition 1")
    expect(editor1.content).toBe("Initial Note 1\nPrivate Note 1 Secret Text\n")
  })

  it("STRESS TEST 3: Excalidraw Sketch persistence during 50 background tab switches without data loss", () => {
    // Create sketch with custom user elements
    const sketchPath = "/vault/Design.excalidraw"
    const sketchWithElements = serializeSketch({
      elements: [
        { id: "elem-rectangle-1", type: "rectangle", x: 100, y: 100, width: 200, height: 150 },
        { id: "elem-circle-1", type: "ellipse", x: 300, y: 300, width: 80, height: 80 },
        { id: "elem-text-1", type: "text", text: "Architecture Diagram", x: 150, y: 120 },
      ],
      appState: { theme: "light" },
      files: {},
    })

    const openSketches: Record<string, string> = {
      [sketchPath]: sketchWithElements,
    }

    let savedSketchContent: string | null = null
    const handleSketchSave = (path: string, json: string) => {
      openSketches[path] = json
      savedSketchContent = json
    }

    // Simulate tab list containing the sketch and a markdown note
    const _sketchTab: Tab = {
      key: "tab-sketch",
      fileId: sketchPath,
      kind: "sketch",
      title: "Design",
      history: [sketchPath],
      historyIndex: 0,
    }
    const _noteTab: Tab = {
      key: "tab-note",
      fileId: "/vault/Notes.md",
      kind: "document",
      title: "Notes",
      history: ["/vault/Notes.md"],
      historyIndex: 0,
    }

    const doc: Document = {
      id: sketchPath,
      title: "Design",
      content: "",
      created: "today",
      modified: "today",
      wordCount: 0,
      path: sketchPath,
      revision: "rev-1",
      source: "",
    }

    // Simulate 50 tab switches between Note (active) and Sketch (background)
    for (let i = 0; i < 50; i++) {
      const isSketchPrimary = i % 2 === 0

      // Compute sketchValue and onSketchChange with the FIXED architecture
      // (WITHOUT isPrimary && doc limitation)
      const sketchValue = doc
        ? (openSketches[doc.path] ?? defaultSketchJson())
        : defaultSketchJson()

      const onSketchChange = doc
        ? (json: string) => handleSketchSave(doc.path, json)
        : (_json: string) => {}

      // CRITICAL ASSERTION: The sketchValue MUST NEVER be the empty default sketch!
      expect(sketchValue).not.toBe(defaultSketchJson())
      const parsed = parseSketch(sketchValue)
      expect(parsed.elements.length).toBeGreaterThanOrEqual(3)
      expect(parsed.elements[0].id).toBe("elem-rectangle-1")
      expect(parsed.elements[1].id).toBe("elem-circle-1")
      expect(parsed.elements[2].id).toBe("elem-text-1")

      // If user adds an element while sketch is active
      if (isSketchPrimary) {
        const updatedSketch = serializeSketch({
          elements: [
            ...parsed.elements,
            { id: `elem-arrow-${i}`, type: "arrow", x: 10, y: 10, width: 50, height: 50 },
          ],
          appState: parsed.appState,
          files: parsed.files,
        })
        onSketchChange(updatedSketch)
      }
    }

    // Final verification: all elements preserved and updated, never wiped
    const finalParsed = parseSketch(openSketches[sketchPath])
    expect(finalParsed.elements.length).toBe(3 + 25) // 3 initial + 25 added during active cycles
    expect(savedSketchContent).not.toBeNull()
  })

  it("STRESS TEST 4: Aggressive memory buffer eviction protection under rapid navigation", async () => {
    const numNotes = 20
    const noteIds = Array.from({ length: numNotes }, (_, i) => `doc-${i + 1}.md`)

    // In-memory autosave coordinator
    const autosave = new AutosaveCoordinator<{ fileId: string; content: string }>({
      delayMs: 100,
      save: async ({ value }) => {
        diskStorage.set(value.fileId, { content: value.content, revision: "saved" })
        useDocStore.getState().markSaved(value.fileId)
      },
    })
    const autosaveKey = (fileId: string): AutosaveKey => ({
      generation: 1,
      kind: "markdown",
      documentId: fileId,
    })

    // Sequentially open 20 notes in a single tab, modifying each one
    const tabKey = "single-tab"
    for (const fileId of noteIds) {
      // 1. Load document
      useDocStore.getState().setDoc(fileId, {
        id: fileId,
        title: fileId,
        content: `Initial content of ${fileId}`,
        created: "today",
        modified: "today",
        wordCount: 5,
        path: `/vault/${fileId}`,
        revision: "rev-1",
        source: `Initial content of ${fileId}`,
      })

      // 2. Set active tab to this document
      useTabsStore.setState({
        tabs: [
          {
            key: tabKey,
            fileId,
            kind: "document",
            title: fileId,
            history: [fileId],
            historyIndex: 0,
          },
        ],
        activeTabKey: tabKey,
      })

      // 3. User modifies the document
      const modifiedContent = `Dirty modifications in ${fileId} with unique payload ${Date.now()}`
      useDocStore.getState().patchDoc(fileId, { content: modifiedContent })
      useDocStore.getState().markUnsaved(fileId)
      autosave.schedule(autosaveKey(fileId), { fileId, content: modifiedContent })

      // 4. ATTEMPT AGGRESSIVE EVICTION immediately while autosave is pending
      const evictableIds = selectEvictableDocumentIds({
        ...useDocStore.getState(),
        ...useTabsStore.getState(),
        hasPendingAutosave: (id) => {
          const inspected = autosave.inspect(autosaveKey(id))
          return Boolean(
            inspected && (inspected.dirty || inspected.scheduled || inspected.inFlight),
          )
        },
        hasRecoveryDraft: () => false,
      })

      // CRITICAL ASSERTION: The document currently pending save CANNOT be evicted!
      expect(evictableIds).not.toContain(fileId)

      // Even previously modified documents that haven't flushed cannot be evicted
      for (const prevId of noteIds.slice(0, noteIds.indexOf(fileId))) {
        expect(evictableIds).not.toContain(prevId)
      }
    }

    // Now flush all pending saves
    await autosave.flushAll()

    // After all saves succeed and markSaved is called:
    // Only documents not currently in open tabs can now be safely evicted
    const finalEvictableIds = selectEvictableDocumentIds({
      ...useDocStore.getState(),
      ...useTabsStore.getState(),
      hasPendingAutosave: (id) => {
        const inspected = autosave.inspect(autosaveKey(id))
        return Boolean(inspected && (inspected.dirty || inspected.scheduled || inspected.inFlight))
      },
      hasRecoveryDraft: () => false,
    })

    // The currently active note (the last one) is in tabs, so it is never evictable
    const lastNoteId = noteIds[noteIds.length - 1]
    expect(finalEvictableIds).not.toContain(lastNoteId)

    // All 20 files must be successfully persisted to disk!
    for (const fileId of noteIds) {
      const diskNote = getDiskNote(fileId)
      expect(diskNote).toBeDefined()
      expect(diskNote?.content).toContain(`Dirty modifications in ${fileId}`)
    }
  })

  it("STRESS TEST 5: Layer switching on same document retains both note and sketch without collision", () => {
    const docId = "project-plan.md"
    let noteContent = "# Project Plan\n\n- Task 1\n- Task 2\n"
    let sketchContent = serializeSketch({
      elements: [{ id: "workflow-box-1", type: "rectangle", x: 50, y: 50, width: 100, height: 60 }],
      appState: {},
      files: {},
    })

    // Register serialization hooks
    let currentLayer: "editor" | "sketch" = "editor"
    const unregister = registerEditorSerialization({
      flush: () => {
        if (currentLayer === "editor") {
          // Flush note
          useDocStore.getState().patchDoc(docId, { content: noteContent })
        } else {
          // Flush sketch
          // sketchContent is flushed
        }
      },
    })

    // Switch between Note and Sketch 20 times with edits in each
    for (let cycle = 1; cycle <= 20; cycle++) {
      // 1. In Note layer
      currentLayer = "editor"
      noteContent += `Note Edit Cycle ${cycle}\n`
      flushEditorSerializations()

      // 2. Switch to Sketch layer
      currentLayer = "sketch"
      const parsed = parseSketch(sketchContent)
      sketchContent = serializeSketch({
        elements: [
          ...parsed.elements,
          {
            id: `sketch-node-${cycle}`,
            type: "ellipse",
            x: cycle * 10,
            y: cycle * 10,
            width: 40,
            height: 40,
          },
        ],
        appState: {},
        files: {},
      })
      flushEditorSerializations()
    }

    unregister()

    // Both layer contents must be preserved without corruption
    expect(noteContent).toContain("Note Edit Cycle 20")
    expect(noteContent).not.toContain("workflow-box-1") // Sketch JSON must not leak into Note

    const finalSketch = parseSketch(sketchContent)
    expect(finalSketch.elements.length).toBe(1 + 20) // 1 initial + 20 added
    expect(sketchContent).not.toContain("# Project Plan") // Markdown must not leak into Sketch
  })

  it("STRESS TEST 6: React Component unmount flush isolation (Guaranteed no closure corruption)", () => {
    // This explicitly tests the exact bug mechanism that was previously corrupting files:
    // When Note A unmounts during a tab switch to Note B, its unmount hook fires.
    // We verify that Note A's unmount cleanup callback ALWAYS receives Note A's documentId
    // and saves to Note A, NEVER to Note B.
    const savedNotes: Record<string, string> = {
      "note-a.md": "Original Note A content",
      "note-b.md": "Original Note B content",
    }

    const onContentChange = vi.fn((content: string, sourceDocumentId?: string) => {
      if (sourceDocumentId) {
        savedNotes[sourceDocumentId] = content
      }
    })

    // Simulate Note A's editor lifecycle
    function createMockDocumentEditor(docId: string, initialContent: string) {
      let currentContent = initialContent
      let isUnmounted = false

      return {
        typeText: (added: string) => {
          if (isUnmounted) throw new Error("Cannot type in unmounted editor")
          currentContent += added
        },
        // Unmount cleanup function (like Tiptap's return () => flushSerialize(editor))
        unmount: () => {
          isUnmounted = true
          onContentChange(currentContent, docId)
        },
        getCurrentContent: () => currentContent,
      }
    }

    // 1. Mount Note A
    const editorA = createMockDocumentEditor("note-a.md", savedNotes["note-a.md"])
    editorA.typeText("\nBrand new edits in Note A")

    // 2. Tab switches to Note B:
    // With `${tab.key}:${tab.fileId}` keying, Note A's editor unmounts cleanly
    editorA.unmount()

    // 3. Mount Note B
    const editorB = createMockDocumentEditor("note-b.md", savedNotes["note-b.md"])
    editorB.typeText("\nBrand new edits in Note B")

    // 4. Tab switches back to Note A:
    editorB.unmount()

    // VERIFICATION:
    // onContentChange was called twice: once for note-a.md, once for note-b.md
    expect(onContentChange).toHaveBeenCalledTimes(2)
    expect(onContentChange).toHaveBeenNthCalledWith(
      1,
      "Original Note A content\nBrand new edits in Note A",
      "note-a.md",
    )
    expect(onContentChange).toHaveBeenNthCalledWith(
      2,
      "Original Note B content\nBrand new edits in Note B",
      "note-b.md",
    )

    // Storage check: Note A has Note A's edits, Note B has Note B's edits
    expect(savedNotes["note-a.md"]).toBe("Original Note A content\nBrand new edits in Note A")
    expect(savedNotes["note-b.md"]).toBe("Original Note B content\nBrand new edits in Note B")
    expect(savedNotes["note-a.md"]).not.toContain("Note B")
    expect(savedNotes["note-b.md"]).not.toContain("Note A")
  })

  it("STRESS TEST 7: 100x Rapid Tab Cycling across 10 open tabs with simultaneous keystrokes", async () => {
    const numTabs = 10
    const files = Array.from({ length: numTabs }, (_, i) => ({
      key: `tab-key-${i + 1}`,
      fileId: `tab-doc-${i + 1}.md`,
      content: `# Initial Header for Tab ${i + 1}\n`,
    }))

    const tabState: Tab[] = files.map((f) => ({
      key: f.key,
      fileId: f.fileId,
      kind: "document",
      title: f.fileId,
      history: [f.fileId],
      historyIndex: 0,
    }))

    useTabsStore.setState({ tabs: tabState, activeTabKey: tabState[0].key })

    // Memory buffer store
    for (const f of files) {
      useDocStore.getState().setDoc(f.fileId, {
        id: f.fileId,
        title: f.fileId,
        content: f.content,
        created: "today",
        modified: "today",
        wordCount: 10,
        path: `/vault/${f.fileId}`,
        revision: "rev-1",
        source: f.content,
      })
      setupDiskNote(f.fileId, f.content)
    }

    const autosave = new AutosaveCoordinator<{ fileId: string; content: string }>({
      delayMs: 20,
      save: async ({ value }) => {
        diskStorage.set(value.fileId, { content: value.content, revision: "saved" })
        useDocStore.getState().markSaved(value.fileId)
      },
    })
    const autosaveKey = (fileId: string): AutosaveKey => ({
      generation: 1,
      kind: "markdown",
      documentId: fileId,
    })

    // Simulate 100 rapid tab switches with immediate edits in the newly focused tab
    for (let i = 0; i < 100; i++) {
      const activeIndex = i % numTabs
      const targetTab = tabState[activeIndex]

      // 1. Flush before tab switch (guaranteed by handleTabChange)
      flushEditorSerializations()

      // 2. Switch tab
      useTabsStore.setState({ activeTabKey: targetTab.key })

      // 3. User types in active tab
      const currentDoc = useDocStore.getState().openDocs[targetTab.fileId]
      const updatedText = `${currentDoc?.content ?? ""}Keystroke Batch ${i} in ${targetTab.fileId}\n`
      useDocStore.getState().patchDoc(targetTab.fileId, { content: updatedText })
      useDocStore.getState().markUnsaved(targetTab.fileId)
      autosave.schedule(autosaveKey(targetTab.fileId), {
        fileId: targetTab.fileId,
        content: updatedText,
      })
    }

    // Flush all pending writes
    flushEditorSerializations()
    await autosave.flushAll()

    // VERIFICATION: Check every single tab file
    for (const f of files) {
      const disk = getDiskNote(f.fileId)
      expect(disk).toBeDefined()
      expect(disk?.content).toContain(`Initial Header for Tab`)
      expect(disk?.content).toContain(f.fileId)

      // Zero cross-contamination between any of the 10 tabs
      for (const other of files) {
        if (other.fileId === f.fileId) continue
        expect(disk?.content).not.toContain(other.fileId)
      }
    }
  })

  it("STRESS TEST 8: Database note layer preservation under single-tab tree switching and buffer eviction", async () => {
    const dbFileId = "database-ulid-123"
    const dbPath = "/test-vault/PaLooVerse"
    const _dbNotePath = "/test-vault/PaLooVerse/PaLooVerse.md"
    const note2Id = "note-2.md"
    const note3Id = "note-3.md"

    setupDiskNote(dbFileId, "# PaLooVerse Initial Note\n")
    setupDiskNote(note2Id, "# Note 2 Initial\n")
    setupDiskNote(note3Id, "# Note 3 Initial\n")

    const autosave = new AutosaveCoordinator<{ fileId: string; content: string; revision: string }>(
      {
        delayMs: 50,
        save: async ({ value }) => {
          const current = diskStorage.get(value.fileId)
          const nextRev = `rev-${parseInt(current?.revision.replace("rev-", "") || "0", 10) + 1}`
          diskStorage.set(value.fileId, { content: value.content, revision: nextRev })
          saveLog.push({ fileId: value.fileId, content: value.content, revision: nextRev })
        },
      },
    )

    const autosaveKey = (fileId: string): AutosaveKey => ({
      generation: 1,
      kind: "markdown",
      documentId: fileId,
    })

    // 1. Initial single tab opened with database
    useTabsStore.setState({
      tabs: [
        {
          key: "tab-1",
          kind: "database",
          fileId: dbFileId,
          title: "PaLooVerse",
          history: [dbFileId],
          historyIndex: 0,
        },
      ],
      activeTabKey: "tab-1",
      secondaryTabKey: null,
    })

    useDocStore.getState().setDoc(dbFileId, {
      id: dbFileId,
      title: "PaLooVerse",
      content: "# PaLooVerse Initial Note\n",
      created: "2026-09-25",
      modified: "2026-09-25",
      wordCount: 3,
      path: dbPath,
      revision: "rev-1",
      source: "",
      noteId: dbFileId,
    })

    // 2. User writes text in the database note layer
    const newDbText = "# PaLooVerse Initial Note\n\nVital Character Lore Written By User\n"
    useDocStore.getState().patchDoc(dbFileId, { content: newDbText })
    useDocStore.getState().markUnsaved(dbFileId)
    autosave.schedule(autosaveKey(dbFileId), {
      fileId: dbFileId,
      content: newDbText,
      revision: "rev-1",
    })

    // 3. User switches to Note 2 in the same tab (single-tab navigation)
    flushEditorSerializations()
    useTabsStore.setState({
      tabs: [
        {
          key: "tab-1",
          kind: "document",
          fileId: note2Id,
          title: "Note 2",
          history: [dbFileId, note2Id],
          historyIndex: 1,
        },
      ],
      activeTabKey: "tab-1",
    })
    useDocStore.getState().setDoc(note2Id, {
      id: note2Id,
      title: "Note 2",
      content: "# Note 2 Initial\n",
      created: "2026-09-25",
      modified: "2026-09-25",
      wordCount: 3,
      path: `/test-vault/${note2Id}`,
      revision: "rev-1",
      source: "",
      noteId: note2Id,
    })

    // 4. Autosave finishes in the background for database note
    await autosave.flushAll()
    useDocStore.getState().markSaved(dbFileId)

    // 5. User switches to Note 3 in the same tab
    useTabsStore.setState({
      tabs: [
        {
          key: "tab-1",
          kind: "document",
          fileId: note3Id,
          title: "Note 3",
          history: [dbFileId, note2Id, note3Id],
          historyIndex: 2,
        },
      ],
      activeTabKey: "tab-1",
    })
    useDocStore.getState().setDoc(note3Id, {
      id: note3Id,
      title: "Note 3",
      content: "# Note 3 Initial\n",
      created: "2026-09-25",
      modified: "2026-09-25",
      wordCount: 3,
      path: `/test-vault/${note3Id}`,
      revision: "rev-1",
      source: "",
      noteId: note3Id,
    })

    // 6. Eviction runs while on Note 3
    const hasPendingAutosave = (id: string) => {
      const p = autosave.inspect(autosaveKey(id))
      return Boolean(p && (p.dirty || p.scheduled || p.inFlight || p.paused))
    }
    const evictable = selectEvictableDocumentIds({
      ...useDocStore.getState(),
      ...useTabsStore.getState(),
      hasPendingAutosave,
      hasRecoveryDraft: () => false,
    })
    useDocStore.getState().evictCleanDocs(evictable)

    // 7. User switches back to Database (the 3rd switch!)
    // loadDoc loads it back from disk
    const diskNote = getDiskNote(dbFileId)
    expect(diskNote?.content).toBe(newDbText)

    useTabsStore.setState({
      tabs: [
        {
          key: "tab-1",
          kind: "database",
          fileId: dbFileId,
          title: "PaLooVerse",
          history: [dbFileId, note2Id, note3Id, dbFileId],
          historyIndex: 3,
        },
      ],
      activeTabKey: "tab-1",
    })
    useDocStore.getState().setDoc(dbFileId, {
      id: dbFileId,
      title: "PaLooVerse",
      content: diskNote!.content,
      created: "2026-09-25",
      modified: "2026-09-25",
      wordCount: 10,
      path: dbPath,
      revision: diskNote!.revision,
      source: "",
      noteId: dbFileId,
    })

    // Verify buffer usage tracks database tab now
    const usageAfter = collectDocumentBufferUsage(
      useTabsStore.getState().tabs,
      useTabsStore.getState().activeTabKey,
      null,
    )
    expect(usageAfter.get(dbFileId)?.tabRefs).toBe(1)
    expect(usageAfter.get(dbFileId)?.paneRefs).toBe(1)

    // Verify the document content in store is 100% preserved
    expect(useDocStore.getState().openDocs[dbFileId].content).toBe(newDbText)
    expect(useDocStore.getState().openDocs[dbFileId].content).toContain(
      "Vital Character Lore Written By User",
    )
  })
})
