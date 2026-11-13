// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { RowTitleEditor } from "./row-title-editor"

afterEach(cleanup)

const TAKEN = "Такое название уже занято. Введите другое."

async function commit(onCommit: () => unknown, name: string) {
  render(<RowTitleEditor value="Old" onCommit={onCommit as never} />)
  fireEvent.click(screen.getByRole("button"))
  const input = screen.getByRole("textbox") as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" })
  })
}

describe("RowTitleEditor shows why a name was refused", () => {
  it("keeps the field open with the typed name and the reason under it", async () => {
    await commit(() => Promise.resolve({ status: "failed", text: TAKEN }), "Taken")
    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input.value).toBe("Taken")
    expect(screen.getByTestId("rename-hint").textContent).toContain(TAKEN)
  })

  it("clears the reason when the name changes", async () => {
    await commit(() => Promise.resolve({ status: "failed", text: TAKEN }), "Taken")
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Taken 2" } })
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })

  it("closes the field after a good rename", async () => {
    await commit(() => Promise.resolve({ status: "renamed" }), "Fine")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })
})
