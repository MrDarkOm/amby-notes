// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
  { client: "antigravity", found: true, connected: true, vault: "/other", write: true },
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

const tile = async (client: string) => screen.findByTestId(`mcp-client-tile-${client}`)

describe("connecting AI clients in Settings", () => {
  it("shows every client as a tile in one row", async () => {
    render(<McpClientsSettings vault="/v" port={port()} />)
    for (const name of ["Claude Code", "Codex", "Cursor", "Antigravity"]) {
      const tile = await screen.findByRole("group", { name })
      // Every client is drawn with its own bundled mark.
      expect(tile.querySelector("svg path")).not.toBeNull()
    }
  })

  it("names the vault and the access before connecting, read only by default", async () => {
    const p = port()
    render(<McpClientsSettings vault="/Users/p/Notes" port={p} />)
    const claude = await tile("claudeCode")
    fireEvent.click(within(claude).getByRole("button", { name: "Подключить: Claude Code" }))
    const question = await answer(true)
    expect(question.title).toContain("Claude Code")
    expect(question.description).toContain("/Users/p/Notes")
    expect(question.description).toContain("только чтение")
    await waitFor(() =>
      expect(p.connect).toHaveBeenCalledWith("claudeCode", "/Users/p/Notes", false),
    )
    expect((await screen.findByTestId("mcp-client-claudeCode")).textContent).toMatch(/Подключён/)
    fireEvent.click(within(claude).getByRole("button", { name: "Отключить: Claude Code" }))
    await waitFor(() => expect(p.disconnect).toHaveBeenCalledWith("claudeCode"))
  })

  it("keeps the access per client: editing on before connecting asks for writes", async () => {
    const p = port()
    render(<McpClientsSettings vault="/v" port={p} />)
    const claude = await tile("claudeCode")
    fireEvent.click(within(claude).getByRole("switch", { name: "Редактирование: Claude Code" }))
    expect(p.connect).not.toHaveBeenCalled()
    fireEvent.click(within(claude).getByRole("button", { name: "Подключить: Claude Code" }))
    const question = await answer(true)
    expect(question.description).toContain("чтение и запись")
    await waitFor(() => expect(p.connect).toHaveBeenCalledWith("claudeCode", "/v", true))
    // Another client keeps its own access.
    const cursor = await tile("cursor")
    expect(
      within(cursor)
        .getByRole("switch", { name: "Редактирование: Cursor" })
        .getAttribute("aria-checked"),
    ).toBe("false")
  })

  it("connects a connected client again when its access changes", async () => {
    const p = port()
    render(<McpClientsSettings vault="/v" port={p} />)
    const cursor = await tile("cursor")
    fireEvent.click(within(cursor).getByRole("switch", { name: "Редактирование: Cursor" }))
    await answer(true)
    await waitFor(() => expect(p.connect).toHaveBeenCalledWith("cursor", "/v", true))
  })

  it("does nothing when the question is declined", async () => {
    const p = port()
    render(<McpClientsSettings vault="/v" port={p} />)
    fireEvent.click(
      within(await tile("claudeCode")).getByRole("button", { name: "Подключить: Claude Code" }),
    )
    await answer(false)
    await waitFor(() => expect(useConfirmStore.getState().queue).toHaveLength(0))
    expect(p.connect).not.toHaveBeenCalled()
  })

  it("offers no button for a missing client, no disconnect for Cursor, and moves another vault here", async () => {
    render(<McpClientsSettings vault="/v" port={port()} />)
    expect((await screen.findByTestId("mcp-client-codex")).textContent).toMatch(/Не найден/)
    expect(within(await tile("codex")).queryByRole("button")).toBeNull()
    expect((await screen.findByTestId("mcp-client-cursor")).textContent).toMatch(
      /настройках Cursor/,
    )
    expect(within(await tile("cursor")).queryByRole("button", { name: /Отключить/ })).toBeNull()
    expect((await screen.findByTestId("mcp-client-antigravity")).textContent).toMatch(
      /Другое хранилище/,
    )
    expect(
      within(await tile("antigravity")).getByRole("button", {
        name: "Подключить сюда: Antigravity",
      }),
    ).toBeTruthy()
  })

  it("shows a stable message when the vault is not the open one", async () => {
    const p = port({
      connect: async () => {
        throw new McpClientOperationError("noVault")
      },
    })
    render(<McpClientsSettings vault="/v" port={p} />)
    fireEvent.click(
      within(await tile("claudeCode")).getByRole("button", { name: "Подключить: Claude Code" }),
    )
    await answer(true)
    expect((await screen.findByRole("alert")).textContent).toMatch(/Откройте хранилище/)
  })
})
