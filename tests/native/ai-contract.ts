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
