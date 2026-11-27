import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const rules = (css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\s+/gu, " ")
    .trim()

describe("ProseMirror base rules", () => {
  it("are the rules Tiptap would inject, so turning injection off changes nothing", () => {
    const tiptap = read("../../node_modules/@tiptap/core/src/style.ts")
    // The gap cursor's blink is left out on purpose (no animation in CSS).
    const injected = tiptap
      .slice(tiptap.indexOf("`") + 1, tiptap.lastIndexOf("`"))
      .replace(/\n\s*animation: ProseMirror-cursor-blink[^\n]*/u, "")
      .replace(/@keyframes ProseMirror-cursor-blink \{[^}]*\}\s*\}/u, "")
    expect(rules(read("./prosemirror-base.css"))).toBe(rules(injected))
  })

  it("keep a single line break of a note as a line break", () => {
    expect(read("./prosemirror-base.css")).toMatch(/white-space: break-spaces/u)
  })

  it("are loaded by the application and not injected by the editors", () => {
    expect(read("../main.tsx")).toContain('import "./themes/prosemirror-base.css"')
    expect(read("../components/workspace/tiptap/TiptapEditor.tsx")).toContain("injectCSS: false")
    expect(read("../components/workspace/common/snapshot-read-preview.tsx")).toContain(
      "injectCSS: false",
    )
  })
})
