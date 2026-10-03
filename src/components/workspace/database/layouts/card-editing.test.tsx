// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { createCoverResolver } from "./cover-resolver"
import { GalleryCard } from "./gallery-view"
import { ListView } from "./list-view"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"

const properties: DatabasePropertySummary[] = [
  {
    propertyId: "s",
    name: "Status",
    propertyType: "status",
    configJson: "{}",
    options: [
      { optionId: "a", name: "Todo", color: "#94a3b8" },
      { optionId: "b", name: "Done", color: "#22c55e" },
    ],
  },
  { propertyId: "h", name: "Hours", propertyType: "number", configJson: "{}", options: [] },
]
const row: DatabaseRow = {
  noteId: "n1",
  title: "Write docs",
  relativePath: "Write docs.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: JSON.stringify({ s: { type: "status", optionId: "a" } }),
  rowRevision: "r",
}

describe("editable cards", () => {
  afterEach(cleanup)

  it("changes a property on the card without opening the record", async () => {
    const onRowSelect = vi.fn()
    const onCommit = vi.fn(async () => {})
    render(
      <ListView
        rows={[row]}
        properties={properties}
        onRowSelect={onRowSelect}
        cardEdit={{ onCommit, pendingCells: new Set(), cellErrors: {} }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Status" }))
    fireEvent.click(await screen.findByRole("option", { name: /Done/ }))
    expect(onCommit).toHaveBeenCalledWith(
      row,
      properties[0],
      JSON.stringify({ type: "status", optionId: "b" }),
    )
    expect(onRowSelect).not.toHaveBeenCalled()
  })

  it("opens the record on a click on the card itself, and on Enter", () => {
    const onRowSelect = vi.fn()
    render(<ListView rows={[row]} properties={properties} onRowSelect={onRowSelect} />)
    const card = screen.getByRole("button", { name: /Write docs/ })
    fireEvent.click(card)
    fireEvent.keyDown(card, { key: "Enter" })
    expect(onRowSelect).toHaveBeenCalledTimes(2)
  })

  it("keys typed inside a property control do not open the record", () => {
    const onRowSelect = vi.fn()
    render(
      <ListView
        rows={[row]}
        properties={properties}
        cardFields={["h"]}
        onRowSelect={onRowSelect}
        cardEdit={{ onCommit: async () => {}, pendingCells: new Set(), cellErrors: {} }}
      />,
    )
    // With chosen properties the empty Hours field is a control right on the card.
    const input = screen.getByRole("textbox")
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: " " })
    expect(onRowSelect).not.toHaveBeenCalled()
  })

  it("shows each page's own icon beside its title in the list", () => {
    useViewStateStore.setState({ iconOverrides: { n1: "🚀" } })
    render(<ListView rows={[row]} properties={properties} />)
    expect(screen.getByText("🚀")).toBeTruthy()
    useViewStateStore.setState({ iconOverrides: {} })
  })

  it("leaves out the cover of a gallery card when it is turned off", () => {
    const withImage: DatabaseRow = {
      ...row,
      valuesJson: JSON.stringify({ f: { type: "files", items: [{ relativePath: "a.png" }] } }),
    }
    const resolver = createCoverResolver(async (paths) => paths.map(() => null))
    const card = (coverVisible: boolean) => (
      <GalleryCard
        row={withImage}
        properties={properties}
        cardFields={null}
        cardSize="medium"
        coverVisible={coverVisible}
        coverResolver={resolver}
      />
    )
    const { container, rerender } = render(card(true))
    expect(container.querySelector("[data-gallery-cover]")).toBeTruthy()
    rerender(card(false))
    expect(container.querySelector("[data-gallery-cover]")).toBeNull()
    expect(screen.getByText("Write docs")).toBeTruthy()
  })

  it("spans the whole width, with a column per property that is as wide as its values", () => {
    render(<ListView rows={[row]} properties={properties} cardFields={["s", "h"]} />)
    const list = screen.getByRole("list")
    expect(list.className).not.toMatch(/max-w/)
    expect(list.style.gridTemplateColumns).toBe("minmax(0, 1fr) repeat(2, fit-content(14rem))")
    // Every row takes the list's columns as its own, so values line up between rows.
    expect(screen.getByRole("button", { name: /Write docs/ }).className).toMatch(
      /grid-cols-subgrid/,
    )
  })

  it("does not indent rows that all sit at the same depth, and indents the deeper ones", () => {
    const deeper: DatabaseRow = { ...row, noteId: "n2", title: "Child", depth: 3 }
    render(<ListView rows={[{ ...row, depth: 2 }, deeper]} properties={properties} />)
    const indent = (title: string) =>
      screen
        .getByText(title)
        .closest<HTMLElement>(".amby-density-inline-padding-left")
        ?.style.getPropertyValue("--amby-density-padding-left")
    expect(indent("Write docs")).toBe("0px")
    expect(indent("Child")).toBe("16px")
  })
})
