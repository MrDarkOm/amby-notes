// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary, DatabaseRow } from "@/lib/storage"
import { BoardCard } from "./board-card"
import { createCoverResolver } from "./cover-resolver"
import { GalleryCard } from "./gallery-view"
import { useBoardDrag } from "./use-board-drag"

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
const renameHandler: { current?: (row: DatabaseRow, name: string) => Promise<void> } = {}
const cardEdit = {
  onCommit: async () => {},
  pendingCells: new Set<string>(),
  cellErrors: {},
  onRename: (target: DatabaseRow, name: string) =>
    renameHandler.current?.(target, name) ?? Promise.resolve(),
}
const pencil = () => screen.getByRole("button", { name: "Изменить свойства" })

describe("the pencil on gallery and board cards", () => {
  afterEach(cleanup)

  const gallery = (onRowSelect = vi.fn()) =>
    render(
      <GalleryCard
        row={row}
        properties={properties}
        cardFields={null}
        cardEdit={cardEdit}
        cardSize="medium"
        coverVisible={false}
        coverResolver={createCoverResolver(async (paths) => paths.map(() => null))}
        onRowSelect={onRowSelect}
      />,
    )
  const board = (onRowSelect = vi.fn()) =>
    render(
      <BoardCard
        row={row}
        laneKey="a"
        laneIndex={0}
        laneCount={2}
        pending={false}
        dragging={false}
        properties={properties}
        cardFields={null}
        cardEdit={cardEdit}
        groupPropertyId={null}
        onPointerDown={() => {}}
        consumeClick={() => false}
        onMoveRow={async () => {}}
        onRowSelect={onRowSelect}
      />,
    )

  for (const [name, mount] of [
    ["gallery", gallery],
    ["board", board],
  ] as const) {
    it(`${name}: shows values as labels, with no controls until the pencil is pressed`, () => {
      mount()
      expect(screen.getByText("Todo")).toBeTruthy()
      // Only the value, not the name of the property it belongs to.
      expect(screen.queryByText("Status")).toBeNull()
      expect(screen.queryByRole("textbox")).toBeNull()
      expect(screen.queryByRole("button", { name: "Status" })).toBeNull()
      fireEvent.click(pencil())
      // Every property is a control now, empty ones included.
      expect(screen.getByRole("button", { name: "Status" })).toBeTruthy()
      // The title and the empty Hours field.
      expect(screen.getAllByRole("textbox")).toHaveLength(2)
    })

    it(`${name}: the card opens the record, but not while it is being edited`, () => {
      const onRowSelect = vi.fn()
      const { container } = mount(onRowSelect)
      const card = container.firstElementChild as HTMLElement
      fireEvent.click(card)
      expect(onRowSelect).toHaveBeenCalledTimes(1)
      fireEvent.click(pencil())
      fireEvent.click(card)
      expect(onRowSelect).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Готово" }))
      expect(screen.queryByRole("textbox")).toBeNull()
      fireEvent.click(card)
      expect(onRowSelect).toHaveBeenCalledTimes(2)
    })
  }

  for (const [name, mount] of [
    ["gallery", gallery],
    ["board", board],
  ] as const) {
    it(`${name}: the title is renamed in edit mode and plain text otherwise`, async () => {
      const onRename = vi.fn(async () => {})
      renameHandler.current = onRename
      mount()
      expect(screen.queryByLabelText("Название записи")).toBeNull()
      fireEvent.click(pencil())
      const input = screen.getByLabelText("Название записи") as HTMLInputElement
      fireEvent.change(input, { target: { value: "  New name " } })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.blur(input)
      await vi.waitFor(() => expect(onRename).toHaveBeenCalledWith(row, "New name"))
      expect(onRename).toHaveBeenCalledTimes(1)
    })

    it(`${name}: Escape drops a title change and an unchanged title is not saved`, async () => {
      const onRename = vi.fn(async () => {})
      renameHandler.current = onRename
      mount()
      fireEvent.click(pencil())
      const input = screen.getByLabelText("Название записи") as HTMLInputElement
      fireEvent.change(input, { target: { value: "Other" } })
      fireEvent.keyDown(input, { key: "Escape" })
      fireEvent.blur(input)
      expect(input.value).toBe("Write docs")
      fireEvent.blur(input)
      expect(onRename).not.toHaveBeenCalled()
    })
  }

  it("keeps the title as text when the view cannot rename records", () => {
    renameHandler.current = undefined
    render(
      <GalleryCard
        row={row}
        properties={properties}
        cardFields={null}
        cardEdit={{ ...cardEdit, onRename: undefined }}
        cardSize="medium"
        coverVisible={false}
        coverResolver={createCoverResolver(async (paths) => paths.map(() => null))}
      />,
    )
    fireEvent.click(pencil())
    expect(screen.queryByLabelText("Название записи")).toBeNull()
    expect(screen.getByText("Write docs")).toBeTruthy()
  })

  for (const [name, mount] of [
    ["gallery", gallery],
    ["board", board],
  ] as const) {
    it(`${name}: the page icon becomes a button only in edit mode`, () => {
      mount()
      expect(screen.queryByRole("button", { name: "Сменить иконку страницы" })).toBeNull()
      fireEvent.click(pencil())
      expect(screen.getByRole("button", { name: "Сменить иконку страницы" })).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Готово" }))
      expect(screen.queryByRole("button", { name: "Сменить иконку страницы" })).toBeNull()
    })
  }

  for (const [name, mount] of [
    ["gallery", gallery],
    ["board", board],
  ] as const) {
    it(`${name}: the pencil is hidden at rest, shows on hover and focus, and stays while editing`, async () => {
      const { container } = mount()
      const card = container.firstElementChild as HTMLElement
      const opacity = () => Number(pencil().style.opacity)
      expect(opacity()).toBe(0)
      fireEvent.pointerEnter(card)
      await vi.waitFor(() => expect(opacity()).toBeGreaterThan(0.9))
      fireEvent.pointerLeave(card)
      await vi.waitFor(() => expect(opacity()).toBe(0))
      fireEvent.focus(card)
      await vi.waitFor(() => expect(opacity()).toBeGreaterThan(0.9))
      fireEvent.blur(card)
      await vi.waitFor(() => expect(opacity()).toBe(0))
      fireEvent.click(pencil())
      await vi.waitFor(() =>
        expect(Number(screen.getByRole("button", { name: "Готово" }).style.opacity)).toBe(1),
      )
    })
  }

  it("does not offer the pencil on a card that cannot be edited", () => {
    render(
      <GalleryCard
        row={row}
        properties={properties}
        cardFields={null}
        cardSize="medium"
        coverVisible={false}
        coverResolver={createCoverResolver(async (paths) => paths.map(() => null))}
      />,
    )
    expect(screen.queryByRole("button", { name: "Изменить свойства" })).toBeNull()
  })
})

describe("board card dragging", () => {
  afterEach(() => {
    cleanup()
    // @ts-expect-error test stub
    delete document.elementsFromPoint
  })

  function Harness({ onDrop }: { onDrop: (row: DatabaseRow, lane: string) => void }) {
    const scrollRef = { current: null }
    const { drag, begin, consumeClick } = useBoardDrag({ scrollRef, onDrop })
    return (
      <div>
        <div data-lane-drop="a" data-testid="lane-a">
          <div
            role="button"
            data-testid="card"
            onPointerDown={(event) => begin(event, row, "a")}
            onClickCapture={(event) => {
              if (consumeClick()) event.stopPropagation()
            }}
            onClick={() => (window as unknown as { clicked: () => void }).clicked()}
          >
            <button type="button">inner</button>
          </div>
        </div>
        <div data-lane-drop="b" data-testid="lane-b" />
        <output data-testid="over">{drag?.overLane ?? "none"}</output>
      </div>
    )
  }
  const point = (target: Element, x: number, y: number, over: string | null) => {
    document.elementsFromPoint = () => (over ? [screen.getByTestId(`lane-${over}`)] : [])
    act(() => {
      fireEvent.pointerMove(window, { clientX: x, clientY: y, isPrimary: true })
    })
    return target
  }

  it("drops a held card on the lane under the pointer", () => {
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    fireEvent.pointerDown(screen.getByTestId("card"), {
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    })
    point(screen.getByTestId("card"), 60, 10, "b")
    expect(screen.getByTestId("over").textContent).toBe("b")
    act(() => {
      fireEvent.pointerUp(window)
    })
    expect(onDrop).toHaveBeenCalledWith(row, "b")
  })

  it("treats a small movement as a click, not a drag", () => {
    const onDrop = vi.fn()
    ;(window as unknown as { clicked: () => void }).clicked = vi.fn()
    render(<Harness onDrop={onDrop} />)
    fireEvent.pointerDown(screen.getByTestId("card"), {
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    })
    point(screen.getByTestId("card"), 12, 11, "b")
    act(() => {
      fireEvent.pointerUp(window)
    })
    fireEvent.click(screen.getByTestId("card"))
    expect(onDrop).not.toHaveBeenCalled()
    expect((window as unknown as { clicked: () => void }).clicked).toHaveBeenCalled()
  })

  it("does not open the card with the click that ends a drag", () => {
    const clicked = vi.fn()
    ;(window as unknown as { clicked: () => void }).clicked = clicked
    render(<Harness onDrop={() => {}} />)
    fireEvent.pointerDown(screen.getByTestId("card"), {
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    })
    point(screen.getByTestId("card"), 80, 40, "b")
    act(() => {
      fireEvent.pointerUp(window)
    })
    fireEvent.click(screen.getByTestId("card"))
    expect(clicked).not.toHaveBeenCalled()
  })

  it("puts the card back on Escape and when released over its own lane", () => {
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    const down = () =>
      fireEvent.pointerDown(screen.getByTestId("card"), {
        button: 0,
        isPrimary: true,
        clientX: 10,
        clientY: 10,
      })
    down()
    point(screen.getByTestId("card"), 80, 40, "b")
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    act(() => {
      fireEvent.pointerUp(window)
    })
    expect(onDrop).not.toHaveBeenCalled()
    expect(screen.getByTestId("over").textContent).toBe("none")

    down()
    point(screen.getByTestId("card"), 40, 40, "a")
    act(() => {
      fireEvent.pointerUp(window)
    })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("keeps text from being selected while a card is held, and restores it after", () => {
    render(<Harness onDrop={() => {}} />)
    const removeAllRanges = vi.fn()
    vi.spyOn(window, "getSelection").mockReturnValue({ removeAllRanges } as unknown as Selection)
    fireEvent.pointerDown(screen.getByTestId("card"), {
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    })
    expect(document.body.style.userSelect).toBe("none")
    expect(removeAllRanges).toHaveBeenCalled()
    act(() => {
      fireEvent.pointerUp(window)
    })
    expect(document.body.style.userSelect).toBe("")
    vi.restoreAllMocks()
  })

  it("does not lift a card by pressing a control inside it", () => {
    const onDrop = vi.fn()
    render(<Harness onDrop={onDrop} />)
    fireEvent.pointerDown(screen.getByText("inner"), {
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    })
    point(screen.getByTestId("card"), 80, 40, "b")
    act(() => {
      fireEvent.pointerUp(window)
    })
    expect(onDrop).not.toHaveBeenCalled()
  })
})
