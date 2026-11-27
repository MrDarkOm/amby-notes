// @vitest-environment happy-dom
// docs/notices.md, section 4: a failed save is said once. When the card of the note already says it,
// the dialog does not say it again; a failure no card tells (a database property) is said in the dialog.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import i18n from "@/lib/i18n"
import type { CustomProperty } from "@/lib/storage"
import { markSaidByNoteCard } from "../note-notices/use-note-notices-store"
import { PropertyEditor } from "./property-editor"

beforeEach(async () => {
  await i18n.changeLanguage("ru")
})
afterEach(cleanup)

const property: CustomProperty = {
  id: "",
  name: "Статус",
  icon: "",
  propertyType: "text",
  value: "",
  settings: "",
}

function mount(onSave: () => Promise<void>) {
  const onOpenChange = vi.fn()
  render(
    <PropertyEditor
      property={property}
      open
      onOpenChange={onOpenChange}
      onSave={onSave}
      onDelete={async () => {}}
    />,
  )
  return onOpenChange
}

const line = "Не удалось сохранить свойство. Повторите попытку."

describe("a failed save in the property dialog", () => {
  it("is not said again when the card of the note says it, and the dialog stays for a retry", async () => {
    const onSave = vi.fn(async () => {
      const error = new Error("refused")
      markSaidByNoteCard(error)
      throw error
    })
    const onOpenChange = mount(onSave)
    fireEvent.click(screen.getByText("Сохранить"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText("Сохранить").closest("button")?.disabled).toBe(false),
    )
    expect(screen.queryByText(line)).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("is said in the dialog when nothing else says it", async () => {
    mount(async () => {
      throw new Error("refused")
    })
    fireEvent.click(screen.getByText("Сохранить"))
    expect(await screen.findByText(line)).toBeTruthy()
  })
})
