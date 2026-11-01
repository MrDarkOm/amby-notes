import { beforeEach, describe, expect, it, vi } from "vitest"
import { useAiChatStore, newChatId } from "./use-ai-chat-store"

const calls = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), save: vi.fn(), trash: vi.fn() }))
vi.mock("@/lib/storage", () => ({ resolveAiChatRepository: () => ({ available: true, ...calls }) }))

beforeEach(() => {
  vi.clearAllMocks()
  useAiChatStore.getState().beginVault(null)
  useAiChatStore.getState().beginVault(100)
  calls.list.mockResolvedValue([])
})

describe("AI conversation persistence", () => {
  it("creates canonical ULIDs even when random bytes repeat", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      ;(array as Uint8Array).fill(42)
      return array
    })
    const id = newChatId()
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(id.slice(-16)).toBe("58N2MAHA58N2MAHA")
    vi.restoreAllMocks()
  })

  // AI1-H2: two saves of one conversation must not overwrite newer state.
  it("serializes writes and uses the previous revision", async () => {
    let finishFirst!: (revision: string) => void
    calls.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    calls.save.mockResolvedValueOnce("revision-2")
    const chat = useAiChatStore.getState().create("model", null)
    const first = useAiChatStore.getState().save({ ...chat, title: "first" })
    const second = useAiChatStore.getState().save({ ...chat, title: "second" })
    await vi.waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1))
    finishFirst("revision-1")
    await Promise.all([first, second])
    expect(calls.save.mock.calls[0][2]).toBeNull()
    expect(calls.save.mock.calls[1][2]).toBe("revision-1")
  })

  it("does not show a delayed load from a previous vault", async () => {
    let finishLoad!: (value: unknown) => void
    calls.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        }),
    )
    const load = useAiChatStore.getState().open("chat")
    await Promise.resolve()
    useAiChatStore.getState().beginVault(101)
    finishLoad({ chat: { id: "chat" }, revision: "r", raw: null, status: "ready" })
    await load
    expect(useAiChatStore.getState().chat).toBeNull()
  })
})
