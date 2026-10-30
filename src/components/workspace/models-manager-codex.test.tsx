// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { ModelsManager } from "./models-manager"
import type { AiSettings } from "./app-config"
import * as ai from "@/lib/ai"

vi.mock("@/lib/ai", async (original) => ({
  ...(await original<typeof import("@/lib/ai")>()),
  aiCodexStatus: vi.fn(),
  aiCodexLogin: vi.fn(),
  aiCodexLoginCancel: vi.fn(),
  aiCodexLogout: vi.fn(),
}))

const settings: AiSettings = {
  models: [
    { id: "codex", label: "Codex", provider: "codex", model: "", baseUrl: "", apiVersion: "" },
  ],
  activeModelId: "codex",
}

const missing = { installed: false, supported: false, signedIn: false }
const signedOut = { installed: true, supported: true, signedIn: false }
const ready = { installed: true, supported: true, signedIn: true }

function show() {
  render(<ModelsManager ai={settings} onChange={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ai.aiCodexLoginCancel).mockResolvedValue(true)
})
afterEach(cleanup)

describe("Codex sign-in in the model settings", () => {
  it("offers sign-in only when Codex is installed, supported and signed out", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValue(signedOut)
    show()
    expect(await screen.findByRole("button", { name: "Войти через ChatGPT" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull()
  })

  it("offers nothing to sign in to when Codex is missing or unsupported", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValue(missing)
    show()
    await screen.findByText(/Codex не найден/)
    expect(screen.queryByRole("button", { name: "Войти через ChatGPT" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull()
  })

  it("waits for the browser, can be cancelled, and refreshes the status when it ends", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValueOnce(signedOut).mockResolvedValue(ready)
    let finish: () => void = () => {}
    vi.mocked(ai.aiCodexLogin).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
    show()
    fireEvent.click(await screen.findByRole("button", { name: "Войти через ChatGPT" }))
    expect(await screen.findByText(/Ждём подтверждения/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Войти через ChatGPT" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }))
    expect(ai.aiCodexLoginCancel).toHaveBeenCalledOnce()
    finish()
    expect(await screen.findByRole("button", { name: "Выйти" })).toBeTruthy()
    expect(ai.aiCodexStatus).toHaveBeenCalledTimes(2)
  })

  it("shows why a sign-in failed and lets the user try again", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValue(signedOut)
    vi.mocked(ai.aiCodexLogin).mockRejectedValue(
      new ai.AiRequestError({ code: "missingCredential", provider: "codex" }),
    )
    show()
    fireEvent.click(await screen.findByRole("button", { name: "Войти через ChatGPT" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(await screen.findByRole("button", { name: "Войти через ChatGPT" })).toBeTruthy()
  })

  it("signs out and shows the signed-out state", async () => {
    vi.mocked(ai.aiCodexStatus).mockResolvedValueOnce(ready).mockResolvedValue(signedOut)
    vi.mocked(ai.aiCodexLogout).mockResolvedValue(undefined)
    show()
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }))
    await waitFor(() => expect(ai.aiCodexLogout).toHaveBeenCalledOnce())
    expect(await screen.findByRole("button", { name: "Войти через ChatGPT" })).toBeTruthy()
  })
})
