// @vitest-environment happy-dom
// docs/sync-plan.md, З60: the editor of a property sends only the fields the person changed in the
// form, each as its own narrow command. The icon changed in the row while the editor was open is not
// put back by a save of the name.
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import "@/lib/i18n"
import type { CustomProperty } from "@/lib/storage"
import type { DocumentProperties } from "../panel-registry"

const captured = vi.hoisted(() => ({
  row: null as { onEdit: () => void } | null,
  editor: null as {
    property: CustomProperty | null
    onSave: (property: CustomProperty) => Promise<void>
  } | null,
}))
vi.mock("./info-database-rows", () => ({
  DatabasePropertyRow: () => null,
  PropertyRow: (props: { onEdit: () => void }) => {
    captured.row = props
    return null
  },
}))
vi.mock("./property-editor", () => ({
  PropertyEditor: (props: {
    property: CustomProperty | null
    onSave: (property: CustomProperty) => Promise<void>
  }) => {
    captured.editor = props
    return null
  },
}))

import { InfoPanel } from "./info-panel"

afterEach(() => {
  cleanup()
  captured.row = null
  captured.editor = null
})

const original: CustomProperty = {
  id: "Заказчик",
  name: "Заказчик",
  icon: "🔥",
  propertyType: "text",
  value: "Иван",
  settings: "",
}
const doc: DocumentProperties = {
  kind: "document",
  type: "Markdown",
  backlinks: 0,
  created: "",
  modified: "",
  id: "N1",
  frontmatter: { hasFrontmatter: true, properties: [], customProperties: [original] },
}

function mount() {
  const calls = {
    upsert: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    type: vi.fn(),
    icon: vi.fn(),
    settings: vi.fn(),
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
      onCreateProperty={calls.create}
      onRenameProperty={calls.rename}
      onChangePropertyType={calls.type}
      onSetPropertyIcon={calls.icon}
      onSetPropertySettings={calls.settings}
      onSetPropertyValue={calls.value}
    />,
  )
  return calls
}

describe("the editor of a property where properties are changed by name", () => {
  it("a changed name alone is only a rename, whatever the row did meanwhile", async () => {
    const calls = mount()
    act(() => captured.row!.onEdit())
    expect(captured.editor!.property).toEqual(original)
    await act(async () => {
      await captured.editor!.onSave({ ...original, name: "Клиент" })
    })
    expect(calls.rename).toHaveBeenCalledWith("Заказчик", "Клиент")
    expect(calls.icon).not.toHaveBeenCalled()
    expect(calls.type).not.toHaveBeenCalled()
    expect(calls.settings).not.toHaveBeenCalled()
    expect(calls.value).not.toHaveBeenCalled()
    expect(calls.upsert).not.toHaveBeenCalled()
  })

  it("every changed field goes by itself, to the new name", async () => {
    const calls = mount()
    act(() => captured.row!.onEdit())
    await act(async () => {
      await captured.editor!.onSave({
        ...original,
        name: "Клиент",
        icon: "😀",
        propertyType: "select",
        settings: "А,Б",
        value: "А",
      })
    })
    expect(calls.rename).toHaveBeenCalledWith("Заказчик", "Клиент")
    expect(calls.type).toHaveBeenCalledWith("Клиент", "select")
    expect(calls.icon).toHaveBeenCalledWith("Клиент", "😀")
    expect(calls.settings).toHaveBeenCalledWith("Клиент", "А,Б")
    expect(calls.value).toHaveBeenCalledWith("Клиент", "А")
    expect(calls.upsert).not.toHaveBeenCalled()
  })

  it("a new property is created by one command", async () => {
    const calls = mount()
    const fresh = { ...original, id: "", name: "Новое" }
    await act(async () => {
      await captured.editor!.onSave(fresh)
    })
    expect(calls.create).toHaveBeenCalledWith(fresh)
    expect(calls.upsert).not.toHaveBeenCalled()
  })
})
