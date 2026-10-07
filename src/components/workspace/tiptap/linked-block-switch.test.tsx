// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react"
import * as React from "react"
import { afterEach, expect, it, vi } from "vitest"
import "@/lib/i18n"
import * as storage from "@/lib/storage"
import { useDatabaseStore } from "@/components/workspace/database/database-store"
import { TiptapEditor } from "./TiptapEditor"

vi.mock("./BlockHandles", () => ({ BlockHandles: () => null }))
vi.mock("./BubbleToolbar", () => ({ BubbleToolbar: () => null }))
vi.mock("./BlockInsertPanel", () => ({ BlockInsertPanel: () => null }))
vi.mock("./WikiLinkContextMenu", () => ({ WikiLinkContextMenu: () => null }))

const DB = "01J00000000000000000000010"
const fence =
  "```amby-db\n" +
  JSON.stringify({
    version: 2,
    views: [{ id: "a", databaseId: DB, title: "T", layout: "table", config: {} }],
  }) +
  "\n```"

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? (
      <pre data-testid="err">{String(this.state.error.stack)}</pre>
    ) : (
      this.props.children
    )
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

for (const layout of ["table", "list", "board", "gallery"]) {
  it(`switches away from a note with a ${layout} shortcut without crashing`, async () => {
    vi.useFakeTimers()
    const errors: unknown[] = []
    vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args))
    useDatabaseStore.getState().reset(1)
    useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
    useDatabaseStore.getState().setCatalog([
      {
        databaseId: DB,
        title: "Tasks",
        icon: null,
        attachedNoteId: null,
        manifestRevision: "m",
        locked: false,
        properties: [],
        views: [
          {
            viewId: "01J00000000000000000000011",
            title: "All",
            layout,
            revision: "r",
            groupField: null,
          },
        ],
        templates: [],
        diagnostics: [],
      },
    ])
    vi.spyOn(storage, "getDatabaseNoteContext").mockResolvedValue(null)
    vi.spyOn(storage, "resolveRecordReferences").mockResolvedValue({ references: [] })
    vi.spyOn(storage, "queryDatabase").mockResolvedValue({
      database: {} as never,
      projection: {} as never,
      rows: [],
      nextCursor: null,
      diagnostics: [],
      totalCount: 0,
    })
    const value = fence.replace('"table"', `"${layout}"`)
    const { container, rerender, queryByTestId, unmount } = render(
      <Boundary>
        <TiptapEditor value={value} onChange={vi.fn()} />
      </Boundary>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(queryByTestId("err")?.textContent).toBeUndefined()
    expect(container.querySelector(".amby-database-host")).not.toBeNull()
    rerender(
      <Boundary>
        <TiptapEditor value="Another note" onChange={vi.fn()} />
      </Boundary>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(queryByTestId("err")?.textContent).toBeUndefined()
    unmount()
    expect(errors).toEqual([])
  })
}

it("unlocks the shortcut as soon as the note becomes editable, without a click in the text", async () => {
  vi.useFakeTimers()
  useDatabaseStore.getState().reset(1)
  useDatabaseStore.getState().setRuntime({ enabled: true, vaultGeneration: 1, projection: null })
  useDatabaseStore.getState().setCatalog([
    {
      databaseId: DB,
      title: "Tasks",
      icon: null,
      attachedNoteId: null,
      manifestRevision: "m",
      locked: false,
      properties: [],
      views: [
        {
          viewId: "01J00000000000000000000011",
          title: "All",
          layout: "table",
          revision: "r",
          groupField: null,
        },
      ],
      templates: [],
      diagnostics: [],
    },
  ])
  vi.spyOn(storage, "getDatabaseNoteContext").mockResolvedValue(null)
  vi.spyOn(storage, "resolveRecordReferences").mockResolvedValue({ references: [] })
  vi.spyOn(storage, "queryDatabase").mockResolvedValue({
    database: {} as never,
    projection: {} as never,
    rows: [],
    nextCursor: null,
    diagnostics: [],
    totalCount: 0,
  })
  const { rerender, queryByRole } = render(
    <TiptapEditor value={fence} onChange={vi.fn()} editable={false} />,
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(queryByRole("button", { name: "Настройки" })).toBeNull()
  rerender(<TiptapEditor value={fence} onChange={vi.fn()} editable />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(queryByRole("button", { name: "Настройки" })).not.toBeNull()
  expect(queryByRole("button", { name: "Новая" })).not.toBeNull()
})
