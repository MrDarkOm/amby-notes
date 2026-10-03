// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { PropertyOptionsDialog } from "./property-options-dialog"

const property: DatabasePropertySummary = {
  propertyId: "p",
  name: "Stage",
  propertyType: "select",
  configJson: "{}",
  options: [
    { optionId: "a", name: "Todo", color: "#94a3b8" },
    { optionId: "b", name: "Done", color: "#22c55e" },
  ],
}

describe("PropertyOptionsDialog", () => {
  afterEach(cleanup)

  it("saves renamed, added and removed options in order", async () => {
    const onSave = vi.fn(async () => [])
    const onClose = vi.fn()
    render(<PropertyOptionsDialog property={property} onSave={onSave} onClose={onClose} />)

    const names = screen.getAllByLabelText("Название варианта")
    expect(names).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Сохранить" }).hasAttribute("disabled")).toBe(true)

    fireEvent.change(names[0], { target: { value: "To do" } })
    fireEvent.click(screen.getByRole("button", { name: "Добавить вариант" }))
    fireEvent.change(screen.getAllByLabelText("Название варианта")[2], {
      target: { value: "Later" },
    })
    fireEvent.click(screen.getAllByRole("button", { name: "Удалить вариант" })[1])
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const [propertyId, drafts] = onSave.mock.calls[0] as unknown as [
      string,
      { id: string | null; name: string }[],
    ]
    expect(propertyId).toBe("p")
    expect(drafts.map((draft) => [draft.id, draft.name])).toEqual([
      ["a", "To do"],
      [null, "Later"],
    ])
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("blocks saving a repeated or empty name and says why", () => {
    const onSave = vi.fn(async () => [])
    render(<PropertyOptionsDialog property={property} onSave={onSave} onClose={() => {}} />)
    fireEvent.change(screen.getAllByLabelText("Название варианта")[1], {
      target: { value: "todo" },
    })
    expect(screen.getByRole("alert").textContent).toContain("повторяться")
    expect(screen.getByRole("button", { name: "Сохранить" }).hasAttribute("disabled")).toBe(true)
    fireEvent.change(screen.getAllByLabelText("Название варианта")[1], { target: { value: "" } })
    expect(screen.getByRole("alert").textContent).toContain("название")
    expect(onSave).not.toHaveBeenCalled()
  })

  it("keeps the dialog open and shows the failure when saving fails", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Manifest revision conflict")
    })
    const onClose = vi.fn()
    render(<PropertyOptionsDialog property={property} onSave={onSave} onClose={onClose} />)
    fireEvent.change(screen.getAllByLabelText("Название варианта")[0], {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))
    expect((await screen.findByRole("alert")).textContent).toContain("revision conflict")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("offers a group for each status option only", () => {
    const { rerender } = render(
      <PropertyOptionsDialog property={property} onSave={async () => []} onClose={() => {}} />,
    )
    expect(screen.queryAllByLabelText("Группа статуса")).toHaveLength(0)
    rerender(
      <PropertyOptionsDialog
        property={{ ...property, propertyType: "status" }}
        onSave={async () => []}
        onClose={() => {}}
      />,
    )
    expect(screen.getAllByLabelText("Группа статуса")).toHaveLength(2)
  })

  it("reorders options with the grip, by dragging or with the arrow keys", async () => {
    const onSave = vi.fn(async () => [])
    render(<PropertyOptionsDialog property={property} onSave={onSave} onClose={() => {}} />)
    const grips = screen.getAllByRole("button", { name: /Перетащить вариант/ })
    expect(grips).toHaveLength(2)
    fireEvent.keyDown(grips[0], { key: "ArrowDown" })
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const drafts = (onSave.mock.calls[0] as unknown as [string, { name: string }[]])[1]
    expect(drafts.map((draft) => draft.name)).toEqual(["Done", "Todo"])
    // The arrow buttons are gone.
    expect(screen.queryByRole("button", { name: "Выше" })).toBeNull()
  })
})
