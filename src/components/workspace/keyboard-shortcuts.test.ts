import { describe, expect, it } from "vitest"
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  matchesShortcut,
  normalizeShortcutBindings,
  shortcutFromEvent,
} from "./keyboard-shortcuts"

function keyEvent(
  key: string,
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) {
  return {
    key,
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe("keyboard shortcuts", () => {
  it("captures the platform primary modifier as a portable Mod binding", () => {
    expect(shortcutFromEvent(keyEvent("p", "KeyP", { metaKey: true }), true)).toEqual({
      status: "captured",
      binding: "Mod+P",
    })
    expect(shortcutFromEvent(keyEvent("p", "KeyP", { ctrlKey: true }), false)).toEqual({
      status: "captured",
      binding: "Mod+P",
    })
  })

  it("requires a modifier for typing keys but permits function keys", () => {
    expect(shortcutFromEvent(keyEvent("a", "KeyA"), false)).toEqual({
      status: "needs-modifier",
    })
    expect(shortcutFromEvent(keyEvent("F2", "F2"), false)).toEqual({
      status: "captured",
      binding: "F2",
    })
  })

  it("matches exact modifiers and punctuation keys", () => {
    expect(matchesShortcut(keyEvent(",", "Comma", { metaKey: true }), "Mod+Comma", true)).toBe(true)
    expect(matchesShortcut(keyEvent("f", "KeyF", { ctrlKey: true }), "Mod+Shift+F", false)).toBe(
      false,
    )
    expect(
      matchesShortcut(
        keyEvent("f", "KeyF", { ctrlKey: true, shiftKey: true }),
        "Mod+Shift+F",
        false,
      ),
    ).toBe(true)
  })

  it("fills missing persisted commands with defaults", () => {
    expect(normalizeShortcutBindings({ quickOpen: "F2" })).toEqual({
      ...DEFAULT_SHORTCUTS,
      quickOpen: "F2",
    })
  })

  it("formats portable bindings for the current platform", () => {
    expect(formatShortcut("Mod+Shift+F", true)).toBe("⌘ + ⇧ + F")
    expect(formatShortcut("Mod+Comma", false)).toBe("Ctrl + ,")
  })
})
