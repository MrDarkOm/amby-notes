import { describe, expect, it } from "vitest"
import { isComposingKeyEvent, isEnterKey } from "./keyboard"

function nativeEvent(init: { key?: string; isComposing?: boolean; keyCode?: number }) {
  return init as unknown as KeyboardEvent
}

describe("isComposingKeyEvent", () => {
  it("is false for a plain key", () => {
    expect(isComposingKeyEvent(nativeEvent({ key: "a", isComposing: false, keyCode: 65 }))).toBe(
      false,
    )
  })

  it("is true while a native event reports isComposing", () => {
    expect(isComposingKeyEvent(nativeEvent({ key: "Enter", isComposing: true }))).toBe(true)
  })

  it("is true for the WebKit final keydown (keyCode 229, isComposing false)", () => {
    expect(
      isComposingKeyEvent(nativeEvent({ key: "Enter", isComposing: false, keyCode: 229 })),
    ).toBe(true)
  })

  it("reads isComposing from a React synthetic event's nativeEvent", () => {
    const synthetic = { key: "Enter", nativeEvent: { isComposing: true } }
    expect(isComposingKeyEvent(synthetic as never)).toBe(true)
  })

  it("reads keyCode 229 from a React synthetic event", () => {
    const synthetic = { key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } }
    expect(isComposingKeyEvent(synthetic as never)).toBe(true)
  })
})

describe("isEnterKey", () => {
  it("accepts a normal Enter", () => {
    expect(isEnterKey(nativeEvent({ key: "Enter", isComposing: false, keyCode: 13 }))).toBe(true)
  })

  it("rejects other keys", () => {
    expect(isEnterKey(nativeEvent({ key: "a", isComposing: false, keyCode: 65 }))).toBe(false)
  })

  it("rejects Enter that confirms an IME composition", () => {
    expect(isEnterKey(nativeEvent({ key: "Enter", isComposing: true, keyCode: 229 }))).toBe(false)
    expect(isEnterKey(nativeEvent({ key: "Enter", isComposing: false, keyCode: 229 }))).toBe(false)
  })
})
