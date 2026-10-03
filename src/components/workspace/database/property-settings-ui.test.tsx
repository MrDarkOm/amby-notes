// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SettingInlineRow } from "./property-settings-ui"

describe("SettingInlineRow", () => {
  afterEach(cleanup)

  it("shows the whole name as a tooltip, for when the row is too narrow to fit it", () => {
    render(
      <SettingInlineRow icon={<span />} label="Поле связанных страниц">
        <select aria-label="control" />
      </SettingInlineRow>,
    )
    expect(screen.getByText("Поле связанных страниц").getAttribute("title")).toBe(
      "Поле связанных страниц",
    )
  })
})
