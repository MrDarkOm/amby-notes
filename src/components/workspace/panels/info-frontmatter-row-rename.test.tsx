// @vitest-environment happy-dom
// Typing a new name of a property is one rename, sent when the typing is over (Enter or leaving the
// field); the blur that follows Enter, and the closing of the popover, must not send it again with the
// old name: that second call was refused and the panel said «Не удалось сохранить свойство».
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import { FrontmatterPropertyRow } from "./info-frontmatter-rows"

afterEach(cleanup)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("renaming a property in its row", () => {
  it("typing letters sends nothing; Enter and the blur after it send one rename", async () => {
    const slow = deferred()
    const onRename = vi.fn(() => slow.promise)
    render(
      <FrontmatterPropertyRow
        property={{ key: "Статус", value: "x", valueKind: "text" }}
        propertyType="text"
        settings=""
        onRename={onRename}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Статус" }))
    const input = await screen.findByLabelText("Название свойства")
    for (const draft of ["Статуc", "Статулор", "Статулорлорс"]) {
      fireEvent.change(input, { target: { value: draft } })
    }
    expect(onRename).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    // the field is disabled while the rename goes on, which blurs it
    fireEvent.blur(input)
    await act(async () => {
      slow.resolve()
      await slow.promise
    })
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith("Статулорлорс")
  })
})
