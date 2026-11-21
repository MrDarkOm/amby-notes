// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { McpClientStatus, McpClientsPort } from "@/lib/storage"
import { McpClientOperationError } from "@/lib/storage"
import { useConfirmStore } from "@/lib/confirm"
import { McpClientsSettings } from "./settings-mcp-clients"

afterEach(cleanup)

const statuses: McpClientStatus[] = [
  { client: "claudeCode", found: true, connected: false, vault: null, write: null },
  { client: "codex", found: false, connected: false, vault: null, write: null },
  { client: "cursor", found: true, connected: true, vault: "/v", write: false },
]

function port(overrides: Partial<McpClientsPort> = {}): McpClientsPort {
  return {
    available: true,
    status: vi.fn(async () => statuses),
    connect: vi.fn(async (client, vault, write) => ({
      client,
      found: true,
      connected: true,
      vault,
      write,
    })),
    disconnect: vi.fn(async (client) => ({
      client,
      found: true,
      connected: false,
      vault: null,
      write: null,
    })),
    ...overrides,
  }
}

const answer = async (yes: boolean) => {
  await waitFor(() => expect(useConfirmStore.getState().queue.length).toBe(1))
  const [question] = useConfirmStore.getState().queue
  useConfirmStore.getState().settle(question.id, yes ? "yes" : "dismissed")
  return question
}

describe("connecting AI clients in Settings", () => {
  it("names the vault and the access before connecting, read only by default", async () => {
    const p = port()
    render(<McpClientsSettings vault="/Users/p/Notes" port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    const question = await answer(true)
    expect(question.title).toContain("Claude Code")
    expect(question.description).toContain("/Users/p/Notes")
    expect(question.description).toContain("только чтение")
    await waitFor(() =>
      expect(p.connect).toHaveBeenCalledWith("claudeCode", "/Users/p/Notes", false),
    )
    expect((await screen.findByTestId("mcp-client-claudeCode")).textContent).toMatch(/Подключён/)
    fireEvent.click(screen.getAllByRole("button", { name: "Отключить" })[0])
    await waitFor(() => expect(p.disconnect).toHaveBeenCalledWith("claudeCode"))
  })

  it("does nothing when the question is declined", async () => {
    const p = port()
    render(<McpClientsSettings vault="/v" port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    await answer(false)
    await waitFor(() => expect(useConfirmStore.getState().queue).toHaveLength(0))
    expect(p.connect).not.toHaveBeenCalled()
  })

  it("offers no button for a missing client and no disconnect for Cursor", async () => {
    render(<McpClientsSettings vault="/v" port={port()} />)
    expect((await screen.findByTestId("mcp-client-codex")).textContent).toMatch(/Не найден/)
    expect((await screen.findByTestId("mcp-client-cursor")).textContent).toMatch(
      /настройках Cursor/,
    )
    expect(screen.queryAllByRole("button", { name: "Отключить" })).toHaveLength(0)
    expect(screen.getAllByRole("button", { name: /Подключить|Переподключить/ })).toHaveLength(2)
  })

  it("shows a stable message when the vault is not the open one", async () => {
    const p = port({
      connect: async () => {
        throw new McpClientOperationError("noVault")
      },
    })
    render(<McpClientsSettings vault="/v" port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    await answer(true)
    expect((await screen.findByRole("alert")).textContent).toMatch(/Откройте хранилище/)
  })
})
