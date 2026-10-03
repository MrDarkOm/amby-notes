// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { PropertyHeaderMenu } from "./table-view"

const property: DatabasePropertySummary = {
  propertyId: "p",
  name: "Stage",
  propertyType: "select",
  configJson: "{}",
  options: [],
}

function open(settingsEditor?: React.ReactNode) {
  render(
    <PropertyHeaderMenu property={property} onRename={() => {}} settingsEditor={settingsEditor} />,
  )
  fireEvent.pointerDown(screen.getByRole("button", { name: "Stage" }), {
    button: 0,
    ctrlKey: false,
  })
}

describe("PropertyHeaderMenu settings", () => {
  afterEach(cleanup)

  it("offers Edit property when the property has settings, and shows them in a submenu", async () => {
    open(<div data-testid="editor">the settings</div>)
    const trigger = await screen.findByRole("menuitem", { name: /Редактировать свойство/ })
    fireEvent.keyDown(trigger, { key: "ArrowRight" })
    expect((await screen.findByTestId("editor")).textContent).toBe("the settings")
  })

  it("has no such item for a property without settings", async () => {
    open(null)
    await screen.findByRole("menuitem", { name: /Тип|Изменить тип|Фильтр/ })
    expect(screen.queryByRole("menuitem", { name: /Редактировать свойство/ })).toBeNull()
  })
})
