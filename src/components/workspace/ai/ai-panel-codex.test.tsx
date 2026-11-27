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
            id: "codex",
            label: "Codex",
            provider: "codex",
            model: "",
            baseUrl: "",
            apiVersion: "",
          },
        ],
        activeModelId: "codex",
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

async function send() {
  render(<AiPanel {...props} />)
  await waitFor(() => expect(useAiChatStore.getState().chat).not.toBeNull())
  fireEvent.change(screen.getByPlaceholderText("Сообщение…"), { target: { value: "Question" } })
  fireEvent.click(screen.getByRole("button", { name: "Отправить" }))
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
    content: "text",
    source: "old",
    path: "/vault/Note.md",
    created: "",
    modified: "",
    wordCount: 1,
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

describe("AI panel with Codex (agent mode)", () => {
  it("always asks first and says Codex is isolated and what leaves for ChatGPT", async () => {
    await send()
    const dialog = await screen.findByRole("dialog")
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    const text = dialog.textContent ?? ""
    expect(text).toContain("Codex")
    expect(text).toContain("ChatGPT")
    expect(text).toContain("в изоляции")
    expect(text).toContain("только")
    // Codex has no access to the computer; the dialog must not claim it does, nor reuse
    // the wording written for the other providers.
    expect(text).not.toContain("может читать файлы за пределами")
    expect(text).not.toContain("ИИ сможет искать и читать заметки")
  })

  it("runs the turn once the user allows it", async () => {
    vi.mocked(ai.aiRunTurn).mockResolvedValue({ content: "Answer", steps: [], sources: [] })
    await send()
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Разрешить" }))
    await waitFor(() => expect(ai.aiRunTurn).toHaveBeenCalledOnce())
    expect(ai.aiSetSearchConsent).toHaveBeenCalledWith(201, expect.anything(), true)
    expect(vi.mocked(ai.aiRunTurn).mock.calls[0][0]).toMatchObject({ provider: "codex" })
  })

  it("does not run at all after a refusal and says why", async () => {
    await send()
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }))
    await waitFor(() =>
      expect(ai.aiSetSearchConsent).toHaveBeenCalledWith(201, expect.anything(), false),
    )
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    expect(await screen.findByText("Без вашего разрешения Codex не запускается.")).toBeTruthy()
  })

  it("does not ask again once consent is already given", async () => {
    vi.mocked(ai.aiSearchConsent).mockResolvedValue("allowed")
    vi.mocked(ai.aiRunTurn).mockResolvedValue({ content: "Answer", steps: [], sources: [] })
    await send()
    await waitFor(() => expect(ai.aiRunTurn).toHaveBeenCalledOnce())
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("does not run when consent was denied earlier, even with search switched off", async () => {
    vi.mocked(ai.aiSearchConsent).mockResolvedValue("denied")
    await send()
    await waitFor(() => expect(ai.aiSearchConsent).toHaveBeenCalled())
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    expect(await screen.findByText("Без вашего разрешения Codex не запускается.")).toBeTruthy()
  })
})
