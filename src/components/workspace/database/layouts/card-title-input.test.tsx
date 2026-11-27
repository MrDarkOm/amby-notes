// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { CardTitleInput } from "./card-title-input"

afterEach(cleanup)

const TAKEN = "Такое название уже занято. Введите другое."

async function commit(onCommit: (name: string) => unknown, name: string) {
  render(<CardTitleInput value="Old" refusalHint onCommit={onCommit as never} />)
  const input = screen.getByRole("textbox") as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  await act(async () => {
    fireEvent.blur(input)
  })
  return input
}

describe("CardTitleInput shows why a title was refused (docs/notices.md, section 8)", () => {
  it("keeps the typed title and says why under the field", async () => {
    const input = await commit(() => Promise.resolve({ status: "failed", text: TAKEN }), "Taken")
    expect(input.value).toBe("Taken")
    expect(screen.getByTestId("rename-hint").textContent).toContain(TAKEN)
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  it("takes the line away when the title changes", async () => {
    const input = await commit(() => Promise.resolve({ status: "failed", text: TAKEN }), "Taken")
    fireEvent.change(input, { target: { value: "Taken 2" } })
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })

  it("gives up when the field is left with the refused title still in it", async () => {
    let calls = 0
    const input = await commit(() => {
      calls += 1
      return Promise.resolve({ status: "failed", text: TAKEN })
    }, "Taken")
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(calls).toBe(1)
    expect(input.value).toBe("Old")
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })

  it("shows nothing after a good rename or when the handler returns nothing", async () => {
    await commit(() => Promise.resolve({ status: "renamed" }), "Fine")
    expect(screen.queryByTestId("rename-hint")).toBeNull()
    cleanup()
    await commit(() => undefined, "Also fine")
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })
})

describe("CardTitleInput without refusalHint keeps its own layout", () => {
  it("puts the old title back and shows no line", async () => {
    render(
      <CardTitleInput
        value="Old"
        onCommit={() => Promise.resolve({ status: "failed", text: TAKEN }) as never}
      />,
    )
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "Taken" } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(input.value).toBe("Old")
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })
})
