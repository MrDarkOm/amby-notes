// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { ChatList } from "./chat-list"
import { useAiChatStore } from "./use-ai-chat-store"
import type { ChatEntry } from "@/lib/storage"

const NOW = new Date("2026-10-31T15:30:00")
const NAMES: Record<string, string> = {
  "2026-10-31T09:05:00": "Утренняя",
  "2026-10-30T18:00:00": "Вчерашняя",
  "2026-10-12T10:00:00": "Давняя",
}
const at = (iso: string): ChatEntry =>
  ({ id: iso, title: NAMES[iso], updatedAt: iso, status: "ready" }) as ChatEntry

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  useAiChatStore.setState({
    ...useAiChatStore.getInitialState(),
    entries: [at("2026-10-31T09:05:00"), at("2026-10-30T18:00:00"), at("2026-10-12T10:00:00")],
    chat: { id: "2026-10-30T18:00:00" } as never,
  })
})
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const row = (id: string) =>
  screen
    .getByRole("button", { name: new RegExp(NAMES[id]) })
    .closest("[data-chat-row]") as HTMLElement

describe("Chat list", () => {
  it("shows when each chat was last used: the time today, the date otherwise", () => {
    render(<ChatList onOpen={vi.fn()} />)
    expect(within(row("2026-10-31T09:05:00")).getByText("09:05")).toBeTruthy()
    expect(within(row("2026-10-30T18:00:00")).getByText(/30/)).toBeTruthy()
    expect(within(row("2026-10-12T10:00:00")).getByText(/12/)).toBeTruthy()
  })

  it("marks the chat that is open", () => {
    render(<ChatList onOpen={vi.fn()} />)
    expect(row("2026-10-30T18:00:00").getAttribute("aria-current")).toBe("true")
    expect(row("2026-10-31T09:05:00").getAttribute("aria-current")).toBeNull()
  })

  it("keeps rename and delete on every row", () => {
    render(<ChatList onOpen={vi.fn()} />)
    const first = row("2026-10-31T09:05:00")
    expect(within(first).getByRole("button", { name: "Переименовать беседу" })).toBeTruthy()
    expect(within(first).getByRole("button", { name: "В архив" })).toBeTruthy()
  })

  it("opens a chat from its title", () => {
    const onOpen = vi.fn()
    useAiChatStore.setState({ open: vi.fn().mockResolvedValue(undefined) })
    render(<ChatList onOpen={onOpen} />)
    fireEvent.click(screen.getByRole("button", { name: /Давняя/ }))
    expect(useAiChatStore.getState().open).toHaveBeenCalledWith("2026-10-12T10:00:00")
  })
})
