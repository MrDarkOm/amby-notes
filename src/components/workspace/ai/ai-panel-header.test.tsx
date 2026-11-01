// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

import { OPEN_SETTINGS_REQUEST_EVENT } from "../settings-navigation"

async function showPanel() {
  render(<AiPanel {...props} />)
  await waitFor(() => expect(useAiChatStore.getState().chat).not.toBeNull())
}

function captureSettingsRequests() {
  const requests: unknown[] = []
  const listener = (event: Event) => requests.push((event as CustomEvent).detail)
  window.addEventListener(OPEN_SETTINGS_REQUEST_EVENT, listener)
  return { requests, stop: () => window.removeEventListener(OPEN_SETTINGS_REQUEST_EVENT, listener) }
}

describe("AI panel header", () => {
  it("shows three icons in the header and no overflow menu", async () => {
    await showPanel()
    for (const name of ["Беседы", "Новая беседа", "Настройки ИИ"])
      expect(screen.getByRole("button", { name })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Меню" })).toBeNull()
  })

  it("opens the AI settings, in the Settings dialog, from the settings icon", async () => {
    const captured = captureSettingsRequests()
    await showPanel()
    fireEvent.click(screen.getByRole("button", { name: "Настройки ИИ" }))
    expect(captured.requests).toEqual([{ section: "modules", moduleId: "ai" }])
    captured.stop()
  })

  it("opens the chat list from the history icon and comes back", async () => {
    await showPanel()
    fireEvent.click(screen.getByRole("button", { name: "Беседы" }))
    expect(await screen.findByPlaceholderText("Поиск бесед…")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Назад к чату" }))
    expect(await screen.findByPlaceholderText("Сообщение…")).toBeTruthy()
  })

  it("starts a new chat from its icon", async () => {
    await showPanel()
    const before = useAiChatStore.getState().chat?.id
    fireEvent.click(screen.getByRole("button", { name: "Новая беседа" }))
    await waitFor(() => expect(useAiChatStore.getState().chat?.id).not.toBe(before))
  })

  it("no longer hosts the model library: providers live in the AI settings", async () => {
    await showPanel()
    expect(screen.queryByRole("button", { name: "Добавить модель" })).toBeNull()
  })

  it("sends the model list's manage link to the same settings", async () => {
    const captured = captureSettingsRequests()
    await showPanel()
    fireEvent.click(screen.getByRole("combobox", { name: "Активная модель" }))
    fireEvent.click(await screen.findByRole("button", { name: "Управлять моделями" }))
    expect(captured.requests).toEqual([{ section: "modules", moduleId: "ai" }])
    expect(screen.queryByRole("button", { name: "Добавить модель" })).toBeNull()
    captured.stop()
  })

  it("keeps new chat and settings at the top of the chat list, without the history icon", async () => {
    await showPanel()
    fireEvent.click(screen.getByRole("button", { name: "Беседы" }))
    await screen.findByPlaceholderText("Поиск бесед…")
    expect(screen.getByRole("button", { name: "Новая беседа" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Настройки ИИ" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Беседы" })).toBeNull()
  })

  it("starts a new chat from the list and goes back to the chat", async () => {
    await showPanel()
    const before = useAiChatStore.getState().chat?.id
    fireEvent.click(screen.getByRole("button", { name: "Беседы" }))
    await screen.findByPlaceholderText("Поиск бесед…")
    fireEvent.click(screen.getByRole("button", { name: "Новая беседа" }))
    expect(await screen.findByPlaceholderText("Сообщение…")).toBeTruthy()
    expect(useAiChatStore.getState().chat?.id).not.toBe(before)
  })

  it("opens the AI settings from the list too", async () => {
    const captured = captureSettingsRequests()
    await showPanel()
    fireEvent.click(screen.getByRole("button", { name: "Беседы" }))
    await screen.findByPlaceholderText("Поиск бесед…")
    fireEvent.click(screen.getByRole("button", { name: "Настройки ИИ" }))
    expect(captured.requests).toEqual([{ section: "modules", moduleId: "ai" }])
    captured.stop()
  })
})
