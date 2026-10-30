// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { AiPanel } from "../ai-panel"
import { useAiChatStore } from "./use-ai-chat-store"
import { useVaultStore } from "../use-vault-store"
import { useDocStore } from "../use-doc-store"
import * as ai from "@/lib/ai"

const mock = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), save: vi.fn(), trash: vi.fn() }))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  resolveAiChatRepository: () => ({ available: true, ...mock }),
  searchNotes: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/lib/ai", async (original) => ({
  ...(await original<typeof import("@/lib/ai")>()),
  aiRunTurn: vi.fn(),
  aiSearchConsent: vi.fn(),
  aiSetSearchConsent: vi.fn(),
}))
vi.mock("../app-config", async (original) => {
  const actual = await original<typeof import("../app-config")>()
  return {
    ...actual,
    loadSettings: vi.fn().mockResolvedValue({
      ai: {
        models: [
          {
            id: "cloud",
            label: "Cloud",
            provider: "openai",
            model: "test",
            baseUrl: "https://api.example.com",
            apiVersion: "",
          },
        ],
        activeModelId: "cloud",
      },
    }),
    saveSettingsPatch: vi.fn().mockResolvedValue(undefined),
  }
})

const props = {
  treeItems: [{ id: "note", path: "/vault/Note.md", name: "Note.md", type: "file" as const }],
  selectedId: "note",
  vault: "/vault",
  currentDocId: "note",
  onSelect: vi.fn(),
  onOpenVault: vi.fn(),
  onCreateNoteFromText: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  useAiChatStore.getState().beginVault(null)
  useVaultStore.setState({
    ...useVaultStore.getInitialState(),
    vault: "/vault",
    backendGeneration: 201,
    switching: false,
  })
  useDocStore.getState().clearDocs()
  useDocStore.getState().setDoc("note", {
    id: "note",
    title: "Note",
    content: "unsaved text",
    source: "old",
    path: "/vault/Note.md",
    created: "",
    modified: "",
    wordCount: 2,
  })
  mock.list.mockResolvedValue([])
  mock.save.mockResolvedValue("revision")
  vi.mocked(ai.aiSearchConsent).mockResolvedValue("unknown")
  vi.mocked(ai.aiSetSearchConsent).mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  useAiChatStore.getState().beginVault(null)
})

describe("AI panel", () => {
  // AI1-S1: cloud search is not started until the user has made a decision.
  it("asks before cloud search and continues without search after refusal", async () => {
    vi.mocked(ai.aiRunTurn).mockResolvedValue({
      content: "Answer [1]",
      steps: [],
      sources: [{ id: "note", title: "Note" }],
    })
    render(<AiPanel {...props} />)
    await waitFor(() => expect(useAiChatStore.getState().chat).not.toBeNull())
    fireEvent.click(screen.getByRole("checkbox", { name: /Поиск по хранилищу/ }))
    fireEvent.change(screen.getByPlaceholderText("Сообщение…"), { target: { value: "Question" } })
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }))
    const dialog = await screen.findByRole("dialog")
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Без поиска" }))
    await waitFor(() => expect(ai.aiRunTurn).toHaveBeenCalledOnce())
    const options = vi.mocked(ai.aiRunTurn).mock.calls[0][2]
    expect(options.searchEnabled).toBe(false)
    expect(options.system).toContain("unsaved text")
    expect(ai.aiSetSearchConsent).toHaveBeenCalledWith(201, expect.anything(), false)
    await screen.findByText("Answer [1]")
    fireEvent.click(screen.getByRole("button", { name: "Сохранить как заметку" }))
    expect(props.onCreateNoteFromText).toHaveBeenCalledWith("Answer [1]")
    await waitFor(() => expect(mock.save).toHaveBeenCalled())
  })

  // AI1-U8/H2: a stopped stream is kept as a partial answer.
  it("saves the partial answer when the user stops", async () => {
    vi.mocked(ai.aiRunTurn).mockImplementation(
      (_config, _messages, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.("Partial")
          options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          })
        }),
    )
    render(<AiPanel {...props} />)
    await waitFor(() => expect(useAiChatStore.getState().chat).not.toBeNull())
    fireEvent.change(screen.getByPlaceholderText("Сообщение…"), { target: { value: "Question" } })
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }))
    await screen.findByText("Partial")
    fireEvent.click(screen.getByRole("button", { name: "Остановить" }))
    await waitFor(() => expect(mock.save).toHaveBeenCalled())
    const saved = mock.save.mock.calls[mock.save.mock.calls.length - 1]?.[1]
    expect(saved.messages[saved.messages.length - 1].content).toBe("Partial")
  })
})
