// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { EmojiGlyph } from "./emoji-glyph"
import { installPickerImageFallback } from "@/lib/emoji/picker-data"
import { installPickerStyles } from "@/lib/emoji/picker-styles"
import { Search } from "lucide-react"
import { readFileSync } from "node:fs"

const pickerCss = readFileSync("src/themes/emoji-mart-base.css", "utf8")

describe("EmojiGlyph", () => {
  it("keeps the picker search mask identical to the installed Lucide Search", () => {
    const encoded = /--amby-search-mask:\s*url\("data:image\/svg\+xml,([^"]+)"\)/u.exec(
      pickerCss,
    )?.[1]
    expect(encoded).toBeDefined()
    const mask = new DOMParser().parseFromString(
      decodeURIComponent(encoded!),
      "image/svg+xml",
    ).documentElement
    const { container } = render(<Search />)
    const icon = container.querySelector("svg")!
    for (const attribute of [
      "viewBox",
      "fill",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ]) {
      expect(mask.getAttribute(attribute)).toBe(icon.getAttribute(attribute))
    }
    const shapes = (svg: Element) =>
      Array.from(svg.children).map((node) => [
        node.localName,
        Object.fromEntries(Array.from(node.attributes).map((attr) => [attr.name, attr.value])),
      ])
    expect(shapes(mask)).toEqual(shapes(icon))
  })
  it("installs bundled styles after a delayed first picker render, surviving search updates", async () => {
    const root = document.createElement("div").attachShadow({ mode: "open" })
    root.innerHTML = "<style>constructor styles</style>"
    const remove = installPickerStyles(root)
    // Mart's asynchronous initial render replaces constructor-injected shadow content.
    root.innerHTML = '<section id="root"><input type="search" /></section>'
    await waitFor(() =>
      expect(root.querySelector("link[data-amby-emoji-mart-base]")).not.toBeNull(),
    )
    root.querySelector("#root")!.append(document.createElement("button"))
    expect(root.querySelectorAll("link[data-amby-emoji-mart-base]")).toHaveLength(1)
    remove()
  })
  it("falls back to the original sequence after a load error and recovers for a new value", () => {
    const { container, rerender } = render(<EmojiGlyph value="👩🏽‍💻" />)
    const image = container.querySelector("img")!
    expect(image.getAttribute("src")).toContain("/emoji/noto/")
    expect(image.alt).toBe("")
    fireEvent.error(image)
    expect(container.textContent).toBe("👩🏽‍💻")
    expect(container.querySelector("img")).toBeNull()
    rerender(<EmojiGlyph value="🇫🇮" />)
    expect(container.querySelector("img")).not.toBeNull()
  })

  it.each(["☀︎", "not an emoji", "\u{10ffff}"])("keeps unsupported %s intact", (value) => {
    const { container } = render(<EmojiGlyph value={value} />)
    expect(container.textContent).toBe(value)
    expect(container.querySelector("img")).toBeNull()
  })

  it("handles non-bubbling picker image failures inside the shadow root", () => {
    const host = document.createElement("div")
    const root = host.attachShadow({ mode: "open" })
    root.innerHTML = '<span class="emoji-mart-emoji"><img alt="🇫🇮" /></span>'
    const remove = installPickerImageFallback(root)
    root.querySelector("img")!.dispatchEvent(new Event("error"))
    expect(root.textContent).toBe("🇫🇮")
    expect(root.querySelector("img")).toBeNull()
    remove()
  })
})
