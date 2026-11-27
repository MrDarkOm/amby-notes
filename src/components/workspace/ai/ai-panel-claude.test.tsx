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
            id: "claude",
            label: "Opus",
            provider: "claude-code",
            model: "opus",
            baseUrl: "",
            apiVersion: "",
          },
        ],
        activeModelId: "claude",
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

describe("AI panel with Claude Code (agent mode)", () => {
  it("asks first and names Claude Code and Anthropic, not Codex or ChatGPT", async () => {
    await send()
    const dialog = await screen.findByRole("dialog")
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    const text = dialog.textContent ?? ""
    expect(text).toContain("Claude Code")
    expect(text).toContain("Anthropic")
    expect(text).toContain("в изоляции")
    expect(text).not.toContain("Codex")
    expect(text).not.toContain("ChatGPT")
  })

  it("runs the turn once the user allows it, as the claude-code family", async () => {
    vi.mocked(ai.aiRunTurn).mockResolvedValue({ content: "Answer", steps: [], sources: [] })
    await send()
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Разрешить" }))
    await waitFor(() => expect(ai.aiRunTurn).toHaveBeenCalledOnce())
    expect(vi.mocked(ai.aiRunTurn).mock.calls[0][0]).toMatchObject({
      provider: "claude-code",
      model: "opus",
    })
  })

  it("does not run after a refusal and says why", async () => {
    await send()
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }))
    expect(ai.aiRunTurn).not.toHaveBeenCalled()
    expect(
      await screen.findByText("Без вашего разрешения Claude Code не запускается."),
    ).toBeTruthy()
  })
})

describe("Claude Code errors", () => {
  it("tell a signed-out or rejected Claude Code what to do, never about a key", () => {
    const out = new ai.AiRequestError({ code: "missingCredential", provider: "claude-code" })
    expect(out.message).toContain("Claude Code")
    expect(out.message).not.toContain("ключ")
    expect(
      new ai.AiRequestError({ code: "providerRejected", provider: "claude-code" }).message,
    ).toContain("Claude")
    expect(
      new ai.AiRequestError({ code: "agentBoundary", provider: "claude-code" }).message,
    ).toContain("Claude Code")
  })
})
