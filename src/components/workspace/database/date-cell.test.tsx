// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabasePropertySummary } from "@/lib/storage"
import { DateCell } from "./date-cell"
import { dateInputValue, storedDate } from "./date-input"
import { dateDisplayOf, formatDateValue } from "./value-format"

const property = (config: Record<string, unknown> = {}): DatabasePropertySummary => ({
  propertyId: "d",
  name: "Due",
  propertyType: "date",
  configJson: JSON.stringify({ includeTime: false, allowRange: false, ...config }),
  options: [],
})

describe("date formats", () => {
  const now = new Date(2026, 9, 3, 12, 0)
  const display = (config: Record<string, unknown>) => dateDisplayOf(JSON.stringify(config))

  it("shows the numeric orders chosen for the property", () => {
    expect(formatDateValue("2026-10-03", display({ dateFormat: "monthDayYear" }), "en", now)).toBe(
      "10/03/2026",
    )
    expect(formatDateValue("2026-10-03", display({ dateFormat: "dayMonthYear" }), "en", now)).toBe(
      "03/10/2026",
    )
    expect(formatDateValue("2026-10-03", display({ dateFormat: "yearMonthDay" }), "en", now)).toBe(
      "2026/10/03",
    )
  })

  it("shows the full date by default and an unreadable value as it is", () => {
    expect(formatDateValue("2026-10-03", display({}), "en", now)).toBe("Oct 3, 2026")
    expect(formatDateValue("soon", display({}), "en", now)).toBe("soon")
  })

  it("shows nearby days relative to today and far ones in full", () => {
    const relative = display({ dateFormat: "relative" })
    expect(formatDateValue("2026-10-03", relative, "en", now)).toBe("today")
    expect(formatDateValue("2026-10-04", relative, "en", now)).toBe("tomorrow")
    expect(formatDateValue("2026-10-01", relative, "en", now)).toBe("2 days ago")
    expect(formatDateValue("2027-10-03", relative, "en", now)).toBe("Oct 3, 2027")
  })

  it("shows the time only when the property keeps one, in 24 or 12 hour form", () => {
    const at = new Date(2026, 9, 3, 15, 5).toISOString()
    const hours = (config: Record<string, unknown>) =>
      formatDateValue(
        at,
        display({ includeTime: true, dateFormat: "yearMonthDay", ...config }),
        "en",
        now,
      )
    expect(hours({ timeFormat: "24h" })).toBe("2026/10/03 15:05")
    expect(hours({ timeFormat: "12h" })).toMatch(/^2026\/10\/03 3:05\s?PM$/i)
    expect(
      formatDateValue(at, display({ includeTime: false, dateFormat: "yearMonthDay" }), "en", now),
    ).toBe("2026/10/03")
  })
})

describe("date field values", () => {
  it("round-trips a time through the local field and a UTC instant", () => {
    const stored = new Date(2026, 9, 3, 9, 30).toISOString().replace(/\.\d{3}Z$/, "Z")
    expect(dateInputValue(stored, true)).toBe("2026-10-03T09:30")
    expect(storedDate("2026-10-03T09:30", true)).toBe(stored)
  })

  it("keeps a plain date as it is and reads one without a time as midnight", () => {
    expect(dateInputValue("2026-10-03", false)).toBe("2026-10-03")
    expect(storedDate("2026-10-03", false)).toBe("2026-10-03")
    expect(dateInputValue("2026-10-03", true)).toBe("2026-10-03T00:00")
    expect(storedDate("", true)).toBeNull()
  })
})

describe("DateCell", () => {
  afterEach(cleanup)

  it("shows the date in the property's format and edits it in a date field", () => {
    const onCommit = vi.fn(async () => {})
    render(
      <DateCell
        property={property({ dateFormat: "dayMonthYear" })}
        value={{ type: "date", start: "2026-10-03" }}
        pending={false}
        onCommit={onCommit}
      />,
    )
    const open = screen.getByRole("button", { name: "Due" })
    expect(open.textContent).toBe("03/10/2026")
    fireEvent.click(open)
    const input = screen.getByLabelText("Due") as HTMLInputElement
    expect(input.type).toBe("date")
    fireEvent.change(input, { target: { value: "2026-11-05" } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith(
      JSON.stringify({ type: "date", start: "2026-11-05", end: null, timeZone: null }),
    )
  })

  it("keeps the range end, clears the value when the field is emptied, and Escape cancels", () => {
    const onCommit = vi.fn(async () => {})
    const { rerender } = render(
      <DateCell
        property={property()}
        value={{ type: "date", start: "2026-10-03", end: "2026-10-09", timeZone: "UTC" }}
        pending={false}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Due" }))
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2026-10-04" } })
    fireEvent.blur(screen.getByLabelText("Due"))
    expect(onCommit).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "date", start: "2026-10-04", end: "2026-10-09", timeZone: "UTC" }),
    )
    rerender(
      <DateCell
        property={property()}
        value={{ type: "date", start: "2026-10-03" }}
        pending={false}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Due" }))
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "" } })
    fireEvent.blur(screen.getByLabelText("Due"))
    expect(onCommit).toHaveBeenLastCalledWith(undefined)
    onCommit.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Due" }))
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2030-01-01" } })
    fireEvent.keyDown(screen.getByLabelText("Due"), { key: "Escape" })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("uses a date and time field when the property keeps a time, and does not open the card", () => {
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <DateCell
          property={property({ includeTime: true })}
          value={null}
          pending={false}
          onCommit={async () => {}}
        />
      </div>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Due" }))
    expect((screen.getByLabelText("Due") as HTMLInputElement).type).toBe("datetime-local")
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
