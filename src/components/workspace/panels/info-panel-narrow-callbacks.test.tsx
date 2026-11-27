// @vitest-environment happy-dom
// docs/sync-plan.md, З60: where the properties are changed by name, each callback of a row sends one
// narrow command with its own field. It never builds the whole property from what the row saw when it
// was drawn: that put the old icon back when a rename followed an icon change in the same editor.
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import type { DocumentProperties } from "../panel-registry"

type RowProps = {
  property: { key: string; value: string }
  onIconChange?: (icon: string) => Promise<void> | void
  onRename?: (name: string) => Promise<void> | void
  onChangeType?: (type: string) => Promise<void> | void
  onChangeSettings?: (settings: string) => Promise<void> | void
  onSave?: (value: string) => Promise<void> | void
  onDelete?: () => Promise<void> | void
}
const rows: RowProps[] = []
vi.mock("./info-frontmatter-rows", () => ({
  FrontmatterPropertyRow: (props: RowProps) => {
    rows.push(props)
    return null
  },
}))

import { InfoPanel } from "./info-panel"

afterEach(() => {
  cleanup()
  rows.length = 0
})

const doc: DocumentProperties = {
  kind: "document",
  type: "Markdown",
  backlinks: 0,
  created: "",
  modified: "",
  id: "N1",
  frontmatter: {
    hasFrontmatter: true,
    properties: [{ key: "Статус", value: "Готово", valueKind: "text" }],
    customProperties: [
      {
        id: "Статус",
        name: "Статус",
        icon: "🔥",
        propertyType: "select",
        value: "Готово",
        settings: "А,Б",
      },
    ],
  },
}

function mount() {
  const calls = {
    upsert: vi.fn(),
    rename: vi.fn(),
    icon: vi.fn(),
    settings: vi.fn(),
    create: vi.fn(),
    type: vi.fn(),
    value: vi.fn(),
  }
  render(
    <InfoPanel
      treeItems={[]}
      selectedId="N1"
      vault="/vault"
      onSelect={() => {}}
      onOpenVault={() => {}}
      properties={doc}
      onUpsertCustomProperty={calls.upsert}
      onRenameProperty={calls.rename}
      onCreateProperty={calls.create}
      onSetPropertyIcon={calls.icon}
      onSetPropertySettings={calls.settings}
      onChangePropertyType={calls.type}
      onSetPropertyValue={calls.value}
    />,
  )
  return { calls, row: rows[rows.length - 1] }
}

describe("rows of the panel where properties are changed by name", () => {
  it("an icon change and then a rename, with the same callbacks, send one narrow command each", async () => {
    const { calls, row } = mount()
    await row.onIconChange!("😀")
    await row.onRename!("Статик")
    expect(calls.icon).toHaveBeenCalledWith("Статус", "😀")
    expect(calls.settings).not.toHaveBeenCalled()
    expect(calls.rename).toHaveBeenCalledWith("Статус", "Статик")
    expect(calls.upsert).not.toHaveBeenCalled()
  })

  it("type, settings and value each go alone, and the value does not carry the icon", async () => {
    const { calls, row } = mount()
    await row.onChangeType!("text")
    await row.onChangeSettings!("В")
    await row.onSave!("Идея")
    expect(calls.type).toHaveBeenCalledWith("Статус", "text")
    expect(calls.settings).toHaveBeenCalledWith("Статус", "В")
    expect(calls.icon).not.toHaveBeenCalled()
    expect(calls.value).toHaveBeenCalledWith("Статус", "Идея")
    expect(calls.upsert).not.toHaveBeenCalled()
  })
})
