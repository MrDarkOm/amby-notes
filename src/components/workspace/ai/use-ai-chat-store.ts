import { create } from "zustand"
import { resolveAiChatRepository, type Chat, type ChatEntry, type LoadedChat } from "@/lib/storage"

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Generate the 48-bit timestamp and 80 bits of randomness required by ULID. */
export function newChatId(): string {
  const random = crypto.getRandomValues(new Uint8Array(10))
  let value = BigInt(Date.now()) << 80n
  for (let index = 0; index < random.length; index++) {
    value |= BigInt(random[index]) << BigInt((9 - index) * 8)
  }
  let result = ""
  for (let index = 0; index < 26; index++) {
    result = alphabet[Number(value & 31n)] + result
    value >>= 5n
  }
  return result
}

interface AiChatState {
  generation: number | null
  chat: Chat | null
  selectedId: string | null
  revision: string | null
  readOnly: LoadedChat | null
  entries: ChatEntry[]
  error: boolean
  beginVault: (generation: number | null) => void
  create: (modelId: string, currentNoteId: string | null) => Chat
  replace: (chat: Chat) => void
  refresh: () => Promise<void>
  open: (id: string) => Promise<void>
  save: (chat: Chat, expectedGeneration?: number) => Promise<void>
  remove: (id: string) => Promise<void>
}

// Queue by activation and chat: later snapshots use the revision returned by
// earlier writes and never overtake them. Entries survive panel unmounting.
const pending = new Map<string, Promise<void>>()
const revisions = new Map<string, string>()
let selection = 0
const keyFor = (generation: number, id: string) => `${generation}:${id}`

export const useAiChatStore = create<AiChatState>((set, get) => ({
  generation: null,
  chat: null,
  selectedId: null,
  revision: null,
  readOnly: null,
  entries: [],
  error: false,
  beginVault: (generation) => {
    if (get().generation === generation) return
    selection++
    set({
      generation,
      chat: null,
      selectedId: null,
      revision: null,
      readOnly: null,
      entries: [],
      error: false,
    })
  },
  create: (modelId, currentNoteId) => {
    selection++
    const now = new Date().toISOString()
    const chat: Chat = {
      version: 1,
      id: newChatId(),
      title: "",
      createdAt: now,
      updatedAt: now,
      modelId,
      searchEnabled: false,
      autoCurrent: true,
      context: currentNoteId ? [{ kind: "current", id: currentNoteId }] : [],
      messages: [],
    }
    set({ chat, selectedId: chat.id, revision: null, readOnly: null, error: false })
    return chat
  },
  replace: (chat) => set((state) => (state.chat?.id === chat.id ? { chat } : {})),
  refresh: async () => {
    const generation = get().generation
    if (generation === null) return
    const repository = resolveAiChatRepository()
    if (!repository.available) return
    try {
      const entries = await repository.list(generation)
      if (get().generation === generation) set({ entries, error: false })
    } catch {
      if (get().generation === generation) set({ error: true })
    }
  },
  open: async (id) => {
    const generation = get().generation
    if (generation === null) return
    const attempt = ++selection
    const key = keyFor(generation, id)
    try {
      await pending.get(key)
      const result = await resolveAiChatRepository().load(generation, id)
      if (get().generation !== generation || selection !== attempt) return
      revisions.set(key, result.revision)
      set({
        chat: result.chat,
        selectedId: id,
        readOnly: result.chat ? null : result,
        revision: result.revision,
        error: false,
      })
    } catch {
      if (get().generation === generation && selection === attempt) set({ error: true })
    }
  },
  save: async (chat, expectedGeneration) => {
    const generation = get().generation
    if (
      generation === null ||
      (expectedGeneration !== undefined && generation !== expectedGeneration)
    )
      throw new Error("Vault changed")
    const key = keyFor(generation, chat.id)
    const snapshot = structuredClone(chat)
    const previous = pending.get(key) ?? Promise.resolve()
    const next = previous
      // Keeps the queue going: the failure itself reaches the caller of the previous save, whose
      // `save` sets `error`.
      .catch(() => {})
      .then(async () => {
        const revision = await resolveAiChatRepository().save(
          generation,
          snapshot,
          revisions.get(key) ?? null,
        )
        revisions.set(key, revision)
        const state = get()
        if (state.generation === generation && state.chat?.id === chat.id)
          set({ revision, error: false })
      })
    pending.set(key, next)
    try {
      await next
      if (get().generation === generation) await get().refresh()
    } catch (error) {
      if (get().generation === generation) set({ error: true })
      throw error
    } finally {
      if (pending.get(key) === next) pending.delete(key)
    }
  },
  remove: async (id) => {
    const generation = get().generation
    if (generation === null) return
    const key = keyFor(generation, id)
    try {
      await pending.get(key)
      const loaded = await resolveAiChatRepository().load(generation, id)
      await resolveAiChatRepository().trash(generation, id, loaded.revision)
      revisions.delete(key)
      if (get().generation !== generation) return
      if (get().selectedId === id)
        set({ chat: null, selectedId: null, revision: null, readOnly: null })
      await get().refresh()
    } catch {
      if (get().generation === generation) set({ error: true })
    }
  },
}))
