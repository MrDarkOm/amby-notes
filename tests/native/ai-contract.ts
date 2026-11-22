import { createAiChatRepository, type Chat } from "../../src/lib/storage/ai-chat-repository"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"
import { commands } from "../../src/lib/bindings"
import { listen } from "@tauri-apps/api/event"

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function rejects(operation: Promise<unknown>) {
  try {
    await operation
  } catch {
    return
  }
  throw new Error("Expected operation to be rejected")
}

type Card = {
  id: string
  path: string
  state: string
  kind: string
  diff: string
  affected: string[]
}
type Mode = "manual" | "auto" | "turbo"

// Runs one turn on which the disposable provider calls a single write tool, and returns the
// tool's reply (what the model is told) and the cards the turn sent.
async function callTool(
  generation: number,
  tool: string,
  args: Record<string, unknown>,
  approvalMode: Mode | null,
  streamId: string,
) {
  const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
  check(url, "The disposable AI provider is available")
  const cards: Card[] = []
  const unlisten = await listen<{ streamId: string; kind: string; payload: Card }>(
    "ai:event",
    ({ payload }) => {
      if (payload.streamId === streamId && payload.kind === "proposal") cards.push(payload.payload)
    },
  )
  try {
    const turn = await commands.aiRunTurn({
      generation,
      config: {
        provider: "ollama",
        internalModelId: null,
        model: "fake",
        baseUrl: url,
        credentialId: null,
        apiKey: null,
        maxTokens: null,
        apiVersion: null,
      },
      messages: [{ role: "user", content: `Call tool ${tool} ${JSON.stringify(args)}` }],
      system: null,
      noteIds: [],
      folders: [],
      initialSources: [],
      searchEnabled: true,
      supportsTools: true,
      streamId,
      approvalMode,
    })
    check(turn.status === "ok", `The turn succeeded ${JSON.stringify(turn)}`)
    check(turn.data.content.startsWith("Reply: "), "The provider echoed the tool reply")
    const reply = JSON.parse(turn.data.content.slice("Reply: ".length)) as {
      status?: string
      error?: string
    }
    const deadline = Date.now() + 2000
    while (cards.length === 0 && !reply.error && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    return { reply, cards }
  } finally {
    unlisten()
  }
}

async function writeBody(
  adapter: StorageContractContext["adapter"],
  vaultPath: string,
  generation: number,
  name: string,
  body: string,
) {
  const created = await adapter.createNote(vaultPath, vaultPath, name)
  const original = await adapter.readNote(vaultPath, created.primaryId!)
  await adapter.writeNote(
    vaultPath,
    created.primaryId!,
    body,
    generation,
    original.revision,
    "main",
  )
  return { id: created.primaryId!, path: `${name}.md` }
}

export const nativeAiCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "AI turn streams a read-only search and source through real IPC",
    async run({ adapter, vaultPath }) {
      const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
      check(url, "The disposable AI provider is available")
      const created = await adapter.createNote(vaultPath, vaultPath, "Mercury")
      const id = created.primaryId!
      const generation = (await adapter.loadActiveVaultData()).generation
      const original = await adapter.readNote(vaultPath, id)
      await adapter.writeNote(
        vaultPath,
        id,
        "mercury is visible",
        generation,
        original.revision,
        "main",
      )
      const before = await adapter.readNote(vaultPath, id)
      const events: Array<{ sequence: number; kind: string }> = []
      const unlisten = await listen<{ streamId: string; sequence: number; kind: string }>(
        "ai:event",
        ({ payload }) => {
          if (payload.streamId === "native-ai-turn") events.push(payload)
        },
      )
      try {
        const result = await commands.aiRunTurn({
          generation,
          config: {
            provider: "ollama",
            internalModelId: null,
            model: "fake",
            baseUrl: url,
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: "Find mercury" }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled: true,
          supportsTools: true,
          streamId: "native-ai-turn",
          approvalMode: null,
        })
        check(result.status === "ok", "AI turn succeeded")
        check(result.data.content === "Found mercury [1].", "Provider received the tool results")
        check(
          result.data.steps.map((step) => step.tool).join(",") === "search_notes,read_note",
          "Both read-only steps were recorded",
        )
        check(result.data.sources[0]?.id === id, "Read note is attached as a source")
        const deadline = Date.now() + 2000
        while (!events.some((event) => event.kind === "done") && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(
          events.some((event) => event.kind === "token") &&
            events.filter((event) => event.kind === "toolEnd").length === 2,
          "Streaming events reached WebView",
        )
        check(
          events.every((event, index) => event.sequence === index + 1),
          "Events are ordered",
        )
        check(
          (await adapter.readNote(vaultPath, id)).source === before.source,
          "AI turn did not rewrite the note",
        )
      } finally {
        unlisten()
      }
    },
  },
  {
    name: "AI proposals write nothing until applied, keep an ai-edit version and can be undone",
    async run({ adapter, vaultPath }) {
      const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
      check(url, "The disposable AI provider is available")
      const created = await adapter.createNote(vaultPath, vaultPath, "Venus")
      const id = created.primaryId!
      const generation = (await adapter.loadActiveVaultData()).generation
      const original = await adapter.readNote(vaultPath, id)
      await adapter.writeNote(
        vaultPath,
        id,
        "venus is bright",
        generation,
        original.revision,
        "main",
      )
      const before = await adapter.readNote(vaultPath, id)
      const cards: Array<{ id: string; path: string; state: string; diff: string }> = []
      const unlisten = await listen<{
        streamId: string
        kind: string
        payload: { id: string; path: string; state: string; diff: string }
      }>("ai:event", ({ payload }) => {
        if (payload.streamId === "native-ai-proposal" && payload.kind === "proposal")
          cards.push(payload.payload)
      })
      try {
        const turn = await commands.aiRunTurn({
          generation,
          config: {
            provider: "ollama",
            internalModelId: null,
            model: "fake",
            baseUrl: url,
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: "Propose an edit" }],
          system: null,
          noteIds: [id],
          folders: [],
          initialSources: [],
          searchEnabled: false,
          supportsTools: true,
          streamId: "native-ai-proposal",
          approvalMode: null,
        })
        check(turn.status === "ok", "AI turn succeeded")
        const deadline = Date.now() + 2000
        while (cards.length === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(cards.length === 1 && cards[0].state === "pending", "A pending card arrived")
        check(
          cards[0].path === "Venus.md" && cards[0].diff.includes("+venus is bright and hot"),
          "The card shows the change",
        )
        check(
          (await adapter.readNote(vaultPath, id)).source === before.source,
          "A proposal writes nothing",
        )
        const unsaved = await commands.aiApplyProposal(generation, cards[0].id, ["Venus.md"], null)
        check(unsaved.status === "error", "A note with unsaved edits is not overwritten")
        const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
        check(applied.status === "ok" && applied.data.state === "applied", "Apply succeeds")
        const after = await adapter.readNote(vaultPath, id)
        check(after.source.includes("venus is bright and hot"), "The note holds the change")
        const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
        check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
        check(
          (await adapter.readNote(vaultPath, id)).source === before.source,
          "Undo restores the exact bytes",
        )
        const again = await commands.aiApplyProposal(generation, cards[0].id, [], null)
        check(again.status === "error", "A decided proposal cannot be applied twice")
        await commands.aiRejectProposal(generation, cards[0].id)
      } finally {
        unlisten()
      }
    },
  },
  {
    name: "AI property proposals go through the property engine and a vault without property groups refuses them",
    async run({ adapter, vaultPath }) {
      const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
      check(url, "The disposable AI provider is available")
      const created = await adapter.createNote(vaultPath, vaultPath, "Mars")
      const id = created.primaryId!
      const generation = (await adapter.loadActiveVaultData()).generation
      const original = await adapter.readNote(vaultPath, id)
      await adapter.writeNote(vaultPath, id, "mars is red", generation, original.revision, "main")
      const before = await adapter.readNote(vaultPath, id)
      const cards: Array<{ id: string; path: string; state: string; kind: string; diff: string }> =
        []
      const unlisten = await listen<{
        streamId: string
        kind: string
        payload: { id: string; path: string; state: string; kind: string; diff: string }
      }>("ai:event", ({ payload }) => {
        if (payload.streamId === "native-ai-property" && payload.kind === "proposal")
          cards.push(payload.payload)
      })
      try {
        const turn = await commands.aiRunTurn({
          generation,
          config: {
            provider: "ollama",
            internalModelId: null,
            model: "fake",
            baseUrl: url,
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: "Propose a property" }],
          system: null,
          noteIds: [id],
          folders: [],
          initialSources: [],
          searchEnabled: false,
          supportsTools: true,
          streamId: "native-ai-property",
          approvalMode: null,
        })
        check(turn.status === "ok", "AI turn succeeded")
        const deadline = Date.now() + 2000
        while (cards.length === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(cards.length === 1 && cards[0].kind === "setProperty", "A property card arrived")
        check(cards[0].diff.includes("+status: done"), "The card shows the new value")
        check(
          (await adapter.readNote(vaultPath, id)).source === before.source,
          "A proposal writes nothing",
        )
        const refused = await commands.aiApplyProposal(generation, cards[0].id, [], null)
        check(
          refused.status === "error" && refused.error === "propertiesNotMigrated",
          `A vault without property groups refuses ${JSON.stringify(refused)}`,
        )
        check(
          (await adapter.readNote(vaultPath, id)).source === before.source,
          "A refused apply writes nothing",
        )
        const rejected = await commands.aiRejectProposal(generation, cards[0].id)
        check(
          rejected.status === "ok" && rejected.data.state === "rejected",
          "The refused card can still be rejected",
        )
      } finally {
        unlisten()
      }
    },
  },
  {
    name: "AI database cell proposals apply through the database domain and undo restores the row",
    async run({ adapter, vaultPath }) {
      const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
      check(url, "The disposable AI provider is available")
      const generation = (await adapter.loadActiveVaultData()).generation
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const database = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "AiTasks",
      })
      const property = await adapter.createDatabaseProperty({
        expectedGeneration: generation,
        databaseId: database.databaseId,
        expectedManifestRevision: database.manifestRevision,
        name: "Done",
        propertyType: "checkbox",
      })
      const row = await adapter.createDatabaseRow({
        expectedGeneration: generation,
        databaseId: database.databaseId,
        title: "Ship it",
        template: { kind: "empty" },
      })
      const before = await adapter.readFile(row.notePath)
      const cards: Array<{ id: string; state: string; kind: string; diff: string }> = []
      const unlisten = await listen<{
        streamId: string
        kind: string
        payload: { id: string; state: string; kind: string; diff: string }
      }>("ai:event", ({ payload }) => {
        if (payload.streamId === "native-ai-cell" && payload.kind === "proposal")
          cards.push(payload.payload)
      })
      const turnArguments = {
        databaseId: database.databaseId,
        noteId: row.noteId,
        propertyId: property.propertyId,
        value: { type: "checkbox", checked: true },
      }
      try {
        const turn = await commands.aiRunTurn({
          generation,
          config: {
            provider: "ollama",
            internalModelId: null,
            model: "fake",
            baseUrl: url,
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: `Propose a cell ${JSON.stringify(turnArguments)}` }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled: true,
          supportsTools: true,
          streamId: "native-ai-cell",
          approvalMode: null,
        })
        check(turn.status === "ok", "AI turn succeeded")
        const deadline = Date.now() + 2000
        while (cards.length === 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(cards.length === 1 && cards[0].kind === "setDatabaseValue", "A cell card arrived")
        check((await adapter.readFile(row.notePath)) === before, "A proposal writes nothing")
        const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
        check(
          applied.status === "ok" && applied.data.state === "applied",
          `Apply succeeds ${JSON.stringify(applied)}`,
        )
        check((await adapter.readFile(row.notePath)).includes("Done: true"), "The row holds it")
        const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
        check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
        check((await adapter.readFile(row.notePath)) === before, "Undo restores the exact bytes")
      } finally {
        unlisten()
      }
    },
  },
  {
    name: "AI approval mode in the turn request decides what the write tools say",
    async run({ adapter, vaultPath }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      const note = await writeBody(adapter, vaultPath, generation, "Modes", "modes body")
      const before = await adapter.readNote(vaultPath, note.id)
      const expected: Array<[Mode | null, string, string, string]> = [
        [null, "pending", "pending", "pending"],
        ["manual", "pending", "pending", "pending"],
        ["auto", "applied", "pending", "pending"],
        ["turbo", "applied", "applied", "pending"],
      ]
      for (const [mode, appended, renamed, deleted] of expected) {
        const label = String(mode)
        const append = await callTool(
          generation,
          "append_note",
          { path: note.path, content: "more" },
          mode,
          `native-mode-append-${label}`,
        )
        check(append.reply.status === appended, `${label}: append is ${appended}`)
        const rename = await callTool(
          generation,
          "rename_item",
          { path: note.path, name: "ModesRenamed" },
          mode,
          `native-mode-rename-${label}`,
        )
        check(rename.reply.status === renamed, `${label}: rename is ${renamed}`)
        const removal = await callTool(
          generation,
          "delete_item",
          { path: note.path },
          mode,
          `native-mode-delete-${label}`,
        )
        check(removal.reply.status === deleted, `${label}: delete is ${deleted}`)
        for (const card of [...append.cards, ...rename.cards, ...removal.cards]) {
          check(card.state === "pending", "The turn only proposes; the panel applies")
          await commands.aiRejectProposal(generation, card.id)
        }
      }
      check(
        (await adapter.readNote(vaultPath, note.id)).source === before.source,
        "No turn wrote anything itself",
      )
    },
  },
  {
    name: "AI append proposals apply and undo to the exact bytes",
    async run({ adapter, vaultPath }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      const note = await writeBody(adapter, vaultPath, generation, "Appended", "first line")
      const before = await adapter.readNote(vaultPath, note.id)
      const { cards } = await callTool(
        generation,
        "append_note",
        { path: note.path, content: "second line" },
        "manual",
        "native-append",
      )
      check(cards.length === 1 && cards[0].state === "pending", "A pending card arrived")
      check(
        (await adapter.readNote(vaultPath, note.id)).source === before.source,
        "Nothing written",
      )
      const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
      check(applied.status === "ok" && applied.data.state === "applied", "Apply succeeds")
      check(
        (await adapter.readNote(vaultPath, note.id)).source.includes("second line"),
        "The note holds the appended text",
      )
      const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
      check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
      check(
        (await adapter.readNote(vaultPath, note.id)).source === before.source,
        "Undo restores the exact bytes",
      )
    },
  },
  {
    name: "AI property proposals apply and undo in a vault with property groups",
    async run({ adapter, vaultPath }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      const opened = await commands.openVaultProperties()
      check(opened.status === "ok", `The vault opens its properties ${JSON.stringify(opened)}`)
      const note = await writeBody(adapter, vaultPath, generation, "Props", "props body")
      const before = await adapter.readNote(vaultPath, note.id)
      const { cards } = await callTool(
        generation,
        "set_property",
        { path: note.path, name: "status", value: "done" },
        "manual",
        "native-prop",
      )
      check(cards.length === 1 && cards[0].kind === "setProperty", "A property card arrived")
      check(
        (await adapter.readNote(vaultPath, note.id)).source === before.source,
        "Nothing written",
      )
      const unsaved = await commands.aiApplyProposal(generation, cards[0].id, [note.path], null)
      check(unsaved.status === "error", "A note with unsaved edits is not touched")
      const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
      check(
        applied.status === "ok" && applied.data.state === "applied",
        `Apply succeeds ${JSON.stringify(applied)}`,
      )
      check(
        (await adapter.readNote(vaultPath, note.id)).source.includes("done"),
        "The note holds the property",
      )
      const waits = await commands.aiUndoProposal(generation, cards[0].id, [note.path])
      check(waits.status === "error", "Undo waits while the note has unsaved edits")
      const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
      check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
      check(
        (await adapter.readNote(vaultPath, note.id)).source === before.source,
        "Undo restores the exact bytes",
      )
    },
  },
  {
    name: "AI database row proposals create a row on Apply and Undo removes it again",
    async run({ adapter, vaultPath }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      const state = await adapter.getDatabaseModuleState()
      if (!state.enabled) await adapter.setDatabaseModuleEnabled(true, generation)
      const database = await adapter.createDatabase({
        expectedGeneration: generation,
        mode: "standalone",
        parentPath: vaultPath,
        name: "AiRows",
      })
      // A write through the shared tools asks the window for a rebuild (`database:changed`), as for
      // an MCP write; without a window listening, the test rebuilds the projection itself.
      const titles = async () => {
        await adapter.rebuildDatabaseProjection()
        return (
          await adapter.queryDatabase({
            expectedGeneration: generation,
            databaseId: database.databaseId,
            source: { kind: "inline", spec: { sorts: [] } },
            page: { limit: 50 },
          })
        ).rows.map((row) => row.title)
      }
      const { cards } = await callTool(
        generation,
        "create_database_row",
        { databaseId: database.databaseId, title: "Proposed row" },
        "manual",
        "native-row",
      )
      check(cards.length === 1 && cards[0].kind === "createDatabaseRow", "A row card arrived")
      check(!(await titles()).includes("Proposed row"), "A proposal creates no row")
      const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
      check(
        applied.status === "ok" && applied.data.state === "applied",
        `Apply succeeds ${JSON.stringify(applied)}`,
      )
      check(
        (await adapter.readFile(`${vaultPath}/AiRows/Proposed row.md`)).length > 0,
        "The row file exists on disk",
      )
      check((await titles()).includes("Proposed row"), "The row is queryable")
      const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
      check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
      check(!(await titles()).includes("Proposed row"), "Undo removed the created row")
    },
  },
  {
    name: "AI rename proposals rewrite links on Apply and Undo restores every file",
    async run({ adapter, vaultPath }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      const target = await writeBody(adapter, vaultPath, generation, "Alpha", "alpha body")
      const linker = await writeBody(adapter, vaultPath, generation, "Linker", "see [[Alpha]] here")
      const linkerBefore = await adapter.readNote(vaultPath, linker.id)
      const { cards } = await callTool(
        generation,
        "rename_item",
        { path: target.path, name: "Beta" },
        "manual",
        "native-rename",
      )
      check(cards.length === 1 && cards[0].state === "pending", "A pending card arrived")
      check(cards[0].affected.includes(linker.path), "The card lists the note whose link changes")
      const blocked = await commands.aiApplyProposal(generation, cards[0].id, [linker.path], null)
      check(blocked.status === "error", "Apply waits while an affected note has unsaved edits")
      const applied = await commands.aiApplyProposal(generation, cards[0].id, [], null)
      check(
        applied.status === "ok" && applied.data.state === "applied",
        `Apply succeeds ${JSON.stringify(applied)}`,
      )
      check(
        (await adapter.readNote(vaultPath, linker.id)).source.includes("[[Beta]]"),
        "The link follows the rename",
      )
      const waits = await commands.aiUndoProposal(generation, cards[0].id, [linker.path])
      check(waits.status === "error", "Undo waits while an affected note has unsaved edits")
      const undone = await commands.aiUndoProposal(generation, cards[0].id, [])
      check(undone.status === "ok" && undone.data.state === "undone", "Undo succeeds")
      check(
        (await adapter.readNote(vaultPath, linker.id)).source === linkerBefore.source,
        "Undo restores the linking note exactly",
      )
      check((await adapter.readNote(vaultPath, target.id)).source.includes("alpha body"), "Back")
    },
  },
  {
    name: "AI chats and cloud consent use generation-scoped native storage",
    async run({ adapter, vaultPath }) {
      const repo = createAiChatRepository(true)
      const generation = (await adapter.loadActiveVaultData()).generation
      const chat: Chat = {
        version: 1,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        title: "Native AI",
        createdAt: "2026-10-30T00:00:00Z",
        updatedAt: "2026-10-30T00:00:00Z",
        modelId: "test",
        searchEnabled: false,
        autoCurrent: true,
        context: [],
        messages: [{ role: "user", content: "native question", steps: [], sources: [] }],
      }
      const revision = await repo.save(generation, chat, null)
      check(
        (await repo.list(generation)).some((entry) => entry.id === chat.id),
        "Chat appears in the native vault",
      )
      check(
        (await repo.load(generation, chat.id)).chat?.messages[0].content === "native question",
        "Chat loads from disk",
      )
      await rejects(repo.save(generation, { ...chat, title: "stale" }, "stale"))
      const next = await repo.save(generation, { ...chat, title: "renamed" }, revision)
      await repo.trash(generation, chat.id, next)
      check((await repo.list(generation)).length === 0, "Trashed chat is absent")
      const trash = await adapter.listTrash()
      const archived = trash.find((entry) =>
        entry.originalPath.endsWith(`.amby/ai/chats/${chat.id}.json`),
      )
      check(archived, "Chat is restorable through the ordinary vault archive")
      await adapter.restoreTrash(archived.id)
      check(
        (await repo.load(generation, chat.id)).chat?.title === "renamed",
        "Restored chat retains its content",
      )
      const config = {
        provider: "openai",
        internalModelId: null,
        model: "test",
        baseUrl: "https://example.invalid/v1",
        credentialId: null,
        apiKey: null,
        maxTokens: null,
        apiVersion: null,
      }
      check(
        (await repo.consent(generation, config)) === "unknown",
        "Cloud search starts without consent",
      )
      await repo.setConsent(generation, config, false)
      check((await repo.consent(generation, config)) === "denied", "Refusal is retained")
      const reactivated = (await adapter.loadVaultData(vaultPath)).generation
      await rejects(repo.list(generation))
      check(
        (await repo.load(reactivated, chat.id)).chat?.title === "renamed",
        "Chat survives reactivation",
      )
      check((await repo.consent(reactivated, config)) === "denied", "Consent survives reactivation")
    },
  },
  {
    name: "Codex status answers through real IPC",
    async run() {
      const status = await commands.aiCodexStatus()
      check(
        typeof status.installed === "boolean" &&
          typeof status.supported === "boolean" &&
          typeof status.signedIn === "boolean",
        "Status has the three flags",
      )
      check(!status.signedIn || (status.installed && status.supported), "Sign-in implies usable")
    },
  },
  {
    name: "Codex does not start without consent, however search is set",
    async run({ adapter }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      for (const searchEnabled of [false, true]) {
        const result = await commands.aiRunTurn({
          generation,
          config: {
            provider: "codex",
            internalModelId: null,
            model: "",
            baseUrl: "",
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: "hello" }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled,
          supportsTools: false,
          streamId: `native-codex-gate-${searchEnabled}`,
          approvalMode: null,
        })
        check(
          result.status === "error" && result.error.code === "privacyConsentRequired",
          "Codex is refused before consent",
        )
      }
    },
  },
  {
    name: "Codex answers one turn through real IPC when it is installed and signed in",
    async run({ adapter }) {
      const status = await commands.aiCodexStatus()
      if (!status.signedIn) return // Not available here (CI, no Codex): nothing to verify.
      const repo = createAiChatRepository(true)
      const generation = (await adapter.loadActiveVaultData()).generation
      const config = {
        provider: "codex",
        internalModelId: null,
        model: "",
        baseUrl: "",
        credentialId: null,
        apiKey: null,
        maxTokens: null,
        apiVersion: null,
      }
      await repo.setConsent(generation, config, true)
      const events: Array<{ sequence: number; kind: string }> = []
      const unlisten = await listen<{ streamId: string; sequence: number; kind: string }>(
        "ai:event",
        ({ payload }) => {
          if (payload.streamId === "native-codex-turn") events.push(payload)
        },
      )
      try {
        const result = await commands.aiRunTurn({
          generation,
          config,
          messages: [{ role: "user", content: "Reply with the single word OK." }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled: false,
          supportsTools: false,
          streamId: "native-codex-turn",
          approvalMode: null,
        })
        check(result.status === "ok", "Codex turn succeeded")
        check(result.data.content.trim().length > 0, "Codex returned text")
        const deadline = Date.now() + 2000
        while (!events.some((event) => event.kind === "done") && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        check(
          events.some((event) => event.kind === "token") &&
            events.some((event) => event.kind === "done"),
          "Streaming events reached WebView",
        )
        check(
          events.every((event, index) => event.sequence === index + 1),
          "Events are ordered",
        )
      } finally {
        unlisten()
        await repo.setConsent(generation, config, false)
      }
    },
  },
  {
    name: "Claude Code status answers through real IPC",
    async run() {
      const status = await commands.aiClaudeStatus()
      check(
        typeof status.installed === "boolean" &&
          typeof status.supported === "boolean" &&
          typeof status.signedIn === "boolean",
        "Claude status has the three flags",
      )
      check(!status.signedIn || (status.installed && status.supported), "Sign-in implies usable")
    },
  },
  {
    name: "Claude Code does not start without consent, however search is set",
    async run({ adapter }) {
      const generation = (await adapter.loadActiveVaultData()).generation
      for (const searchEnabled of [false, true]) {
        const result = await commands.aiRunTurn({
          generation,
          config: {
            provider: "claude-code",
            internalModelId: null,
            model: "opus",
            baseUrl: "",
            credentialId: null,
            apiKey: null,
            maxTokens: null,
            apiVersion: null,
          },
          messages: [{ role: "user", content: "hello" }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled,
          supportsTools: false,
          streamId: `native-claude-gate-${searchEnabled}`,
          approvalMode: null,
        })
        check(
          result.status === "error" && result.error.code === "privacyConsentRequired",
          "Claude Code is refused before consent",
        )
      }
    },
  },
  {
    name: "Claude Code lists models and answers one turn through real IPC when signed in",
    async run({ adapter }) {
      const status = await commands.aiClaudeStatus()
      if (!status.signedIn) return // Not available here (CI, no Claude Code): nothing to verify.
      const repo = createAiChatRepository(true)
      const generation = (await adapter.loadActiveVaultData()).generation
      const config = {
        provider: "claude-code",
        internalModelId: null,
        model: "",
        baseUrl: "",
        credentialId: null,
        apiKey: null,
        maxTokens: null,
        apiVersion: null,
      }
      const catalog = await commands.aiModelCatalog(config, "native-claude-catalog")
      check(catalog.status === "ok" && catalog.data.length > 0, "Claude Code catalog is not empty")
      await repo.setConsent(generation, config, true)
      try {
        const result = await commands.aiRunTurn({
          generation,
          config,
          messages: [{ role: "user", content: "Reply with the single word OK." }],
          system: null,
          noteIds: [],
          folders: [],
          initialSources: [],
          searchEnabled: false,
          supportsTools: false,
          streamId: "native-claude-turn",
          approvalMode: null,
        })
        check(result.status === "ok", "Claude Code turn succeeded")
        check(result.data.content.trim().length > 0, "Claude Code returned text")
      } finally {
        await repo.setConsent(generation, config, false)
      }
    },
  },
  {
    name: "AI catalog and reversible migration use real IPC",
    async run({ adapter }) {
      const url = (window as unknown as { __AMBY_NATIVE_AI_URL__: string }).__AMBY_NATIVE_AI_URL__
      const result = await commands.aiModelCatalog(
        {
          provider: "ollama",
          internalModelId: null,
          model: "",
          baseUrl: url,
          credentialId: null,
          apiKey: null,
          maxTokens: null,
          apiVersion: null,
        },
        "native-catalog",
      )
      check(result.status === "ok", "Catalog loaded through native IPC")
      check(
        result.data.length === 1 && result.data[0].model === "native-chat",
        "Non-chat model filtered",
      )
      const previous = await adapter.readGlobalRaw("settings.json")
      const previousConnections = await adapter.readGlobalRaw("ai-connections.json")
      const connections = JSON.stringify({
        version: 1,
        connections: [
          {
            id: "c-old",
            provider: "ollama",
            method: "api",
            label: "Old",
            baseUrl: url,
            credentialId: null,
            apiVersion: "",
          },
        ],
        models: [
          {
            id: "old-id",
            connectionId: "c-old",
            model: "native-chat",
            label: "Old",
            enabled: true,
            available: true,
            origin: "local",
          },
        ],
        activeModelId: "old-id",
      })
      await adapter.writeGlobalRaw("ai-connections.json", connections)
      const next = await adapter.readGlobalRaw("ai-connections.json")
      check(
        next !== null && JSON.parse(next).models[0].id === "old-id",
        "Stable chat model ID retained",
      )
      const disabled = JSON.parse(next as string)
      disabled.models[0].enabled = false
      await adapter.writeGlobalRaw("ai-connections.json", JSON.stringify(disabled))
      const denied = await commands.aiChat(
        {
          provider: "ollama",
          internalModelId: "old-id",
          model: "native-chat",
          baseUrl: url,
          credentialId: null,
          apiKey: null,
          maxTokens: null,
          apiVersion: null,
        },
        [{ role: "user", content: "Do not send" }],
        null,
        null,
      )
      check(
        denied.status === "error" && denied.error.code === "invalidConfiguration",
        "Disabled model is refused at native dispatch",
      )
      let refusedOlderShape = false
      try {
        await adapter.writeGlobalRaw("ai-connections.json", JSON.stringify({ models: [] }))
      } catch {
        refusedOlderShape = true
      }
      check(refusedOlderShape, "The connections file refuses a section of the older shape")
      await adapter.writeGlobalRaw("settings.json", previous ?? "{}")
      if (previousConnections !== null) {
        await adapter.writeGlobalRaw("ai-connections.json", previousConnections)
      }
    },
  },
]
