// @vitest-environment happy-dom
import { DOMParser, DOMSerializer } from "@tiptap/pm/model"
import { describe, expect, it } from "vitest"
import { editorSchema } from "./schema"

describe("image fallback DOM", () => {
  it("keeps a remote attachment inert while preserving its attributes on HTML round trip", () => {
    const node = editorSchema.nodes.image.create({
      src: "https://example.com/clip.mp4",
      alt: "A clip",
      title: "Video",
    })
    const wrapper = document.createElement("div")
    wrapper.append(DOMSerializer.fromSchema(editorSchema).serializeNode(node))
    const link = wrapper.querySelector("a[data-amby-remote-attachment]")
    expect(link?.getAttribute("href")).toBe("https://example.com/clip.mp4")
    expect(wrapper.querySelector("img")).toBeNull()
    const parsed = DOMParser.fromSchema(editorSchema).parse(wrapper)
    expect(parsed.firstChild?.firstChild?.attrs).toMatchObject({
      src: "https://example.com/clip.mp4",
      alt: "A clip",
      title: "Video",
    })
  })

  it("keeps ordinary images as images", () => {
    const node = editorSchema.nodes.image.create({ src: "https://example.com/photo.png" })
    const element = DOMSerializer.fromSchema(editorSchema).serializeNode(node) as HTMLElement
    expect(element.tagName).toBe("IMG")
  })
})
