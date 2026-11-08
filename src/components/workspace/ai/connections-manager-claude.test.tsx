// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { ConnectionsManager } from "./connections-manager"
import type { AiConnectionsSettings } from "./connections"
import * as ai from "@/lib/ai"

vi.mock("@/lib/ai", async (original) => ({
  ...(await original<typeof import("@/lib/ai")>()),
  aiClaudeStatus: vi.fn(),
  aiClaudeLogin: vi.fn(),
  aiClaudeLoginCancel: vi.fn(),
  aiClaudeLogout: vi.fn(),
  aiCodexStatus: vi.fn(),
  aiModelCatalog: vi.fn(),
}))
const open = vi.hoisted(() => vi.fn())
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  openWebAddress: open,
  deleteUnreferencedAiCredential: vi.fn().mockResolvedValue(undefined),
  storeAiCredential: vi.fn().mockResolvedValue(undefined),
}))

const initial: AiConnectionsSettings = {
  version: 1,
  activeModelId: null,
  models: [],
  connections: [
    {
      id: "cli",
      provider: "anthropic",
      method: "claude-cli",
      label: "Claude Code",
      baseUrl: "",
      credentialId: "claude-session:1",
      apiVersion: "",
    },
  ],
}

const status = (installed: boolean, supported: boolean, signedIn: boolean) =>
  vi.mocked(ai.aiClaudeStatus).mockResolvedValue({ installed, supported, signedIn })

function renderCard(onCommit = vi.fn().mockResolvedValue(undefined)) {
  render(<ConnectionsManager settings={initial} onCommit={onCommit} />)
  return onCommit
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ai.aiClaudeLoginCancel).mockResolvedValue(true)
  vi.mocked(ai.aiModelCatalog).mockResolvedValue([
    { model: "opus", label: "Opus", supportsTools: true },
  ])
})
afterEach(cleanup)

describe("Claude Code connection card", () => {
  it("explains a missing CLI, offers the official page and the command, and loads no catalog", async () => {
    status(false, false, false)
    renderCard()
    expect(await screen.findByText("Claude Code CLI не установлен.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Инструкция по установке" }))
    expect(open).toHaveBeenCalledWith("https://code.claude.com/docs/en/setup")
    expect(screen.getByText("npm install -g @anthropic-ai/claude-code")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Войти через Claude" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Добавить локальную модель" })).toBeNull()
    expect(ai.aiModelCatalog).not.toHaveBeenCalled()
  })

  it("reports an unsupported version and offers no sign-in", async () => {
    status(true, false, false)
    renderCard()
    expect(
      await screen.findByText("Установлена неподдерживаемая версия Claude Code CLI."),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Войти через Claude" })).toBeNull()
    expect(ai.aiModelCatalog).not.toHaveBeenCalled()
  })

  it("offers sign-in when signed out, does not ask for a catalog, and rotates the session id", async () => {
    status(true, true, false)
    let finish: () => void = () => {}
    vi.mocked(ai.aiClaudeLogin).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    const onCommit = renderCard()
    expect(await screen.findByText("Claude Code установлен, но вход не выполнен.")).toBeTruthy()
    expect(ai.aiModelCatalog).not.toHaveBeenCalled()
    status(true, true, true)
    fireEvent.click(screen.getByRole("button", { name: "Войти через Claude" }))
    await waitFor(() => expect(ai.aiClaudeLogin).toHaveBeenCalledOnce())
    const rotated = onCommit.mock.calls[0][0].connections[0].credentialId as string
    expect(rotated).toMatch(/^claude-session:/)
    expect(rotated).not.toBe("claude-session:1")
    // A sign-in that waits can be cancelled.
    fireEvent.click(await screen.findByRole("button", { name: "Отменить вход" }))
    expect(ai.aiClaudeLoginCancel).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => expect(ai.aiClaudeStatus).toHaveBeenCalledTimes(2))
  })

  it("loads the catalog through the claude-code provider once ready and offers sign-out", async () => {
    status(true, true, true)
    renderCard()
    expect(await screen.findByRole("img", { name: "подключено" })).toBeTruthy()
    await waitFor(() => expect(ai.aiModelCatalog).toHaveBeenCalledOnce())
    expect(vi.mocked(ai.aiModelCatalog).mock.calls[0][0]).toMatchObject({ provider: "claude-code" })
    fireEvent.click(screen.getByRole("button", { name: "Параметры подключения" }))
    expect(screen.getByRole("button", { name: "Выйти" })).toBeTruthy()
  })

  it("signs out through Claude's own command", async () => {
    status(true, true, true)
    vi.mocked(ai.aiClaudeLogout).mockResolvedValue(undefined)
    renderCard()
    fireEvent.click(await screen.findByRole("button", { name: "Параметры подключения" }))
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }))
    await waitFor(() => expect(ai.aiClaudeLogout).toHaveBeenCalledOnce())
  })

  it("shows a sign-in failure without crashing", async () => {
    status(true, true, false)
    vi.mocked(ai.aiClaudeLogin).mockRejectedValue(
      new ai.AiRequestError({ code: "providerRejected", provider: "claude-code" }),
    )
    renderCard()
    fireEvent.click(await screen.findByRole("button", { name: "Войти через Claude" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
  })
})
