// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  disposeEmojiPicker,
  mountEmojiPicker,
  warmEmojiPicker,
  type PickerSetup,
} from "./picker-runtime"

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  update: vi.fn(),
  configure: vi.fn(),
}))
vi.mock("emoji-mart", () => ({
  Picker: class extends HTMLElement {
    props: Record<string, unknown>
    constructor(props: Record<string, unknown>) {
      super()
      this.props = props
      calls.create()
      this.attachShadow({ mode: "open" }).innerHTML =
        '<section id="root"><input type="search" /></section>'
    }
    connectedCallback() {
      calls.connect()
    }
    disconnectedCallback() {
      calls.disconnect()
    }
    update(props: Record<string, unknown>) {
      calls.update(props)
    }
  },
}))
vi.mock("./picker-search", () => ({ configurePickerSearch: calls.configure }))
vi.mock("./picker-data", () => ({ notoPickerData: {}, installPickerImageFallback: () => vi.fn() }))
vi.mock("./picker-styles", () => ({ installPickerStyles: () => vi.fn() }))
const setup: PickerSetup = { language: "ru", theme: "light", i18n: {} }
const mount = () => {
  const node = document.createElement("div")
  document.body.append(node)
  return node
}

afterEach(() => {
  disposeEmojiPicker()
  document.body.replaceChildren()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe("retained emoji picker", () => {
  it("warms one grid, reuses it across owners and releases callbacks while hidden", () => {
    const first = vi.fn(),
      second = vi.fn()
    warmEmojiPicker(setup)
    const picker = document.querySelector("[data-amby-emoji-picker]")!
    const releaseFirst = mountEmojiPicker(mount(), setup, first, vi.fn())
    const select = (
      picker as unknown as { props: { onEmojiSelect: (emoji: { native: string }) => void } }
    ).props.onEmojiSelect
    select({ native: "🇫🇮" })
    expect(first).toHaveBeenCalledOnce()
    releaseFirst()
    select({ native: "👍" })
    expect(first).toHaveBeenCalledOnce()
    const releaseSecond = mountEmojiPicker(mount(), setup, second, vi.fn())
    expect(document.querySelector("[data-amby-emoji-picker]")).toBe(picker)
    select({ native: "🐱" })
    expect(second).toHaveBeenCalledWith({ native: "🐱" })
    expect(calls.create).toHaveBeenCalledOnce()
    expect(calls.connect).toHaveBeenCalledOnce()
    expect(calls.disconnect).not.toHaveBeenCalled()
    releaseSecond()
    disposeEmojiPicker()
    expect(calls.disconnect).toHaveBeenCalledOnce()
  })
  it("cancels the discarded StrictMode mount before constructing a cold picker", () => {
    vi.useFakeTimers()
    const release = mountEmojiPicker(mount(), setup, vi.fn(), vi.fn())
    release()
    const releaseSecond = mountEmojiPicker(mount(), setup, vi.fn(), vi.fn())
    vi.advanceTimersByTime(32)
    expect(calls.create).toHaveBeenCalledOnce()
    expect(calls.connect).toHaveBeenCalledOnce()
    releaseSecond()
  })
  it("disposes the old grid and configures the new language or theme", () => {
    warmEmojiPicker(setup)
    warmEmojiPicker({ ...setup, language: "en" })
    warmEmojiPicker({ ...setup, language: "en", theme: "dark" })
    expect(calls.create).toHaveBeenCalledTimes(3)
    expect(calls.disconnect).toHaveBeenCalledTimes(2)
    expect(calls.configure).toHaveBeenLastCalledWith({}, "en")
    expect(document.querySelectorAll("[data-amby-emoji-picker]")).toHaveLength(1)
  })
  it("does not queue an old locale's grid refresh while retiring it", () => {
    warmEmojiPicker(setup)
    const release = mountEmojiPicker(mount(), setup, vi.fn(), vi.fn(), () => false)
    release()
    expect(calls.update).not.toHaveBeenCalled()
    warmEmojiPicker({ ...setup, language: "en" })
    expect(calls.configure).toHaveBeenLastCalledWith({}, "en")
  })
  it("closes an earlier owner and ignores its late cleanup", () => {
    warmEmojiPicker(setup)
    const close = vi.fn()
    const releaseOld = mountEmojiPicker(mount(), setup, vi.fn(), close)
    const current = mount()
    const releaseNew = mountEmojiPicker(current, setup, vi.fn(), vi.fn())
    expect(close).toHaveBeenCalledOnce()
    releaseOld()
    expect(current.querySelector("[data-amby-emoji-picker]")).not.toBeNull()
    releaseNew()
  })
})
