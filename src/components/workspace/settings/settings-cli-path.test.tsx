// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { CliPathPort, CliPathStatus } from "@/lib/storage"
import { CliPathOperationError } from "@/lib/storage"
import { useConfirmStore } from "@/lib/confirm"
import { CliPathSettings } from "./settings-cli-path"

afterEach(cleanup)

const off: CliPathStatus = {
  state: "off",
  location: "/Users/p/.local/bin/amby",
  profile: "/Users/p/.zprofile",
}
const on: CliPathStatus = { ...off, state: "on" }

function port(overrides: Partial<CliPathPort> = {}): CliPathPort {
  return {
    available: true,
    status: vi.fn(async () => off),
    install: vi.fn(async () => on),
    remove: vi.fn(async () => off),
    ...overrides,
  }
}

const answer = async (yes: boolean) => {
  await waitFor(() => expect(useConfirmStore.getState().queue.length).toBe(1))
  const [question] = useConfirmStore.getState().queue
  useConfirmStore.getState().settle(question.id, yes ? "yes" : "dismissed")
  return question
}

describe("the amby command in Settings", () => {
  it("names every change before setting it up, and does nothing when the question is declined", async () => {
    const p = port()
    render(<CliPathSettings port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    const question = await answer(false)
    expect(question.description).toContain("/Users/p/.local/bin/amby")
    expect(question.description).toContain("/Users/p/.zprofile")
    await waitFor(() => expect(useConfirmStore.getState().queue).toHaveLength(0))
    expect(p.install).not.toHaveBeenCalled()
  })

  it("sets it up after a yes and offers to take it back", async () => {
    const p = port()
    render(<CliPathSettings port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    await answer(true)
    expect(await screen.findByRole("button", { name: "Отключить" })).toBeTruthy()
    expect(screen.getByTestId("cli-path-state").textContent).toContain("amby --help")
    fireEvent.click(screen.getByRole("button", { name: "Отключить" }))
    await screen.findByRole("button", { name: "Подключить" })
    expect(p.remove).toHaveBeenCalledOnce()
  })

  it("leaves a foreign amby alone and offers no button", async () => {
    render(<CliPathSettings port={port({ status: async () => ({ ...off, state: "taken" }) })} />)
    expect((await screen.findByTestId("cli-path-state")).textContent).toMatch(/Имя занято/)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("shows a stable message, not raw text, when the change fails", async () => {
    const p = port({
      install: async () => {
        throw new CliPathOperationError("failed")
      },
    })
    render(<CliPathSettings port={p} />)
    fireEvent.click(await screen.findByRole("button", { name: "Подключить" }))
    await answer(true)
    expect((await screen.findByRole("alert")).textContent).toMatch(/Не удалось изменить PATH/)
  })

  it("is absent in the browser and in builds without a CLI", async () => {
    const { container, rerender } = render(
      <CliPathSettings port={{ ...port(), available: false }} />,
    )
    expect(container.textContent).toBe("")
    rerender(
      <CliPathSettings port={port({ status: async () => ({ ...off, state: "unavailable" }) })} />,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(container.textContent).toBe("")
  })
})
