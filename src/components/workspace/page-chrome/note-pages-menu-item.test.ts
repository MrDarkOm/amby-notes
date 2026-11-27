import { describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { notePagesMenuItem } from "./page-menu-items"

describe("note pages menu item", () => {
  const t = i18n.getFixedT("ru")

  it("is absent when pages are off or the note cannot be changed", () => {
    expect(notePagesMenuItem(t, "off", null, vi.fn())).toBeNull()
    expect(notePagesMenuItem(t, "flagged", null, undefined)).toBeNull()
  })

  it("marks a flagged note as paged and asks to remove the flag when unchecked", () => {
    const change = vi.fn()
    const item = notePagesMenuItem(t, "flagged", true, change)!
    expect(item.label).toBe("Страницы в заметке")
    expect(item.checked).toBe(true)
    item.onSelect?.()
    expect(change).toHaveBeenCalledWith(null)
  })

  it("turns pages on in flagged mode and off in every-note mode", () => {
    const change = vi.fn()
    notePagesMenuItem(t, "flagged", null, change)!.onSelect?.()
    expect(change).toHaveBeenLastCalledWith(true)
    const always = notePagesMenuItem(t, "always", null, change)!
    expect(always.checked).toBe(true)
    always.onSelect?.()
    expect(change).toHaveBeenLastCalledWith(false)
  })

  it("shows the dossier default and lets the author explicitly disable it", () => {
    const change = vi.fn()
    const enabled = notePagesMenuItem(t, "flagged", null, change, false, true)!
    expect(enabled.label).toBe("Страницы в заметке")
    expect(enabled.checked).toBe(true)
    enabled.onSelect?.()
    expect(change).toHaveBeenLastCalledWith(false)
    const disabled = notePagesMenuItem(t, "flagged", false, change, false, true)!
    expect(disabled.checked).toBe(false)
    disabled.onSelect?.()
    expect(change).toHaveBeenLastCalledWith(null)
  })
})
