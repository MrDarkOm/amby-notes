// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { EditorState } from "@tiptap/pm/state"
import type { DecorationSet } from "@tiptap/pm/view"

import { markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"
import { TagsWikilinks, inlineTokenRange, tagsWikilinksKey } from "./tags-wikilinks"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function mount(markdown: string): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...schemaExtensions, TagsWikilinks],
    content: markdownToDoc(markdown),
  })
  return editor
}

const setOf = (state: EditorState) => tagsWikilinksKey.getState(state) as DecorationSet

/** What is decorated, as text: independent of how the set came to be. */
function shown(state: EditorState): string[] {
  return setOf(state)
    .find()
    .map((decoration) => {
      const text = state.doc.textBetween(decoration.from, decoration.to)
      return `${decoration.from}-${decoration.to}:${text}`
    })
    .sort()
}

/** The same document decorated from scratch. */
function rebuilt(state: EditorState): string[] {
  const fresh = new Editor({
    extensions: [...schemaExtensions, TagsWikilinks],
    content: state.doc.toJSON(),
  })
  try {
    return shown(fresh.state)
  } finally {
    fresh.destroy()
  }
}

const NOTE = [
  "# Title with #heading-tag",
  "",
  "First #one and [[Note A]] here.",
  "",
  "- item #two",
  "- [[Note B|alias]] item",
  "",
  "| a | b |",
  "| --- | --- |",
  "| #cell | [[Note C]] |",
  "",
  "Last **bold #three** paragraph.",
].join("\n")

describe("tag and wikilink decorations", () => {
  it("decorates tags and wikilinks when a note is opened", () => {
    const target = mount(NOTE)
    const texts = shown(target.state).map((entry) => entry.split(":")[1])
    for (const expected of ["#heading-tag", "#one", "[[Note A]]", "#two", "#cell", "#three"]) {
      expect(texts).toContain(expected)
    }
  })

  it("keeps the very same decorations when only the cursor moves", () => {
    const target = mount(NOTE)
    const before = setOf(target.state)
    target.commands.setTextSelection(5)
    target.commands.setTextSelection(40)
    expect(setOf(target.state)).toBe(before)
  })

  it("matches a fresh build after every kind of edit", () => {
    const target = mount(NOTE)
    const check = (label: string) =>
      expect(shown(target.state), label).toEqual(rebuilt(target.state))
    const end = () => target.state.doc.content.size

    target.commands.insertContentAt(3, "new #early ")
    check("typing in the heading")
    target.commands.insertContentAt(end() - 1, " and [[Late]]")
    check("typing at the end")
    target.commands.insertContentAt(1, { type: "text", text: "#" })
    check("a tag made by one character")
    target.commands.deleteRange({ from: 1, to: 2 })
    check("a tag removed by one character")

    // Split a paragraph inside a tag, then join it back.
    let inOne = 0
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes("#one")) inOne = pos + node.text.indexOf("#one") + 2
    })
    target.commands.setTextSelection(inOne)
    target.commands.splitBlock()
    check("splitting a paragraph inside a tag")
    target.commands.joinBackward()
    check("joining it back")

    // A mark over half of a wikilink cuts its text node in two.
    let inLink = 0
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes("[[Note A]]")) {
        inLink = pos + node.text.indexOf("[[Note A]]")
      }
    })
    target
      .chain()
      .setTextSelection({ from: inLink, to: inLink + 5 })
      .toggleBold()
      .run()
    check("a mark over half of a wikilink")
    target
      .chain()
      .setTextSelection({ from: inLink, to: inLink + 5 })
      .toggleBold()
      .run()
    check("the mark removed again")

    target.commands.deleteRange({ from: 1, to: 30 })
    check("deleting across blocks")
    target.commands.insertContentAt(
      end(),
      markdownToDoc("New #block with [[Link]]").content as never,
    )
    check("a block added at the end")
    target.commands.undo()
    check("undo")
    target.commands.setContent(markdownToDoc("Only #fresh [[One]]"), { emitUpdate: false })
    check("the whole note replaced")
  })

  it("matches a fresh build through a long run of arbitrary edits", () => {
    const target = mount(NOTE)
    // A fixed sequence, so a failure can be reproduced.
    let seed = 20261007
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % below
    }
    const pieces = ["#", "[[", "]]", " ", "a", "#tag ", "[[Note]]", "x y", "/", "-"]
    for (let step = 0; step < 120; step++) {
      const size = target.state.doc.content.size
      const from = random(size + 1)
      const tr = target.state.tr
      try {
        if (random(3) === 0) tr.delete(from, Math.min(size, from + 1 + random(6)))
        else tr.insertText(pieces[random(pieces.length)], from)
      } catch {
        continue
      }
      if (!tr.docChanged) continue
      target.view.dispatch(tr)
      expect(shown(target.state), `step ${step}`).toEqual(rebuilt(target.state))
    }
  })

  it("reports where a token is now, not where it was when it was drawn", () => {
    const target = mount("Intro\n\nSee [[Note A]] and #tag here.")
    const before = shown(target.state)
    // Text typed in the paragraph above moves both tokens; their decorations are kept.
    target.commands.insertContentAt(1, "Longer ")
    expect(shown(target.state)).not.toEqual(before)

    const button = target.view.dom.querySelector<HTMLElement>(".amby-live-wikilink-button")!
    const tag = target.view.dom.querySelector<HTMLElement>(".amby-live-tag")!
    const link = inlineTokenRange(target.view, button)!
    expect(target.state.doc.textBetween(link.from, link.to)).toBe("[[Note A]]")
    expect(button.dataset.ambySource).toBe("[[Note A]]")
    const tagRange = inlineTokenRange(target.view, tag)!
    expect(target.state.doc.textBetween(tagRange.from, tagRange.to)).toBe("#tag")
    expect(tag.dataset.ambySource).toBe("#tag")
  })
})

describe("clicking a tag", () => {
  function clickTag(editable: boolean, modifiers: Partial<MouseEvent> = {}) {
    editor?.destroy()
    const tags: string[] = []
    const target = new Editor({
      element: document.body.appendChild(document.createElement("div")),
      extensions: [
        ...schemaExtensions,
        TagsWikilinks.configure({
          callbacks: { current: { onTagClick: (tag) => tags.push(tag) } },
        }),
      ],
      content: markdownToDoc("Learning #finnish today"),
      editable,
    })
    editor = target
    const tagStart = target.state.doc.textContent.indexOf("#finnish") + 1
    const event = new MouseEvent("click", modifiers)
    const handled = target.view.someProp("handleClick", (f) => f(target.view, tagStart + 3, event))
    return { tags, handled: Boolean(handled) }
  }

  it("shows the tag from a read-only note on a plain click", () => {
    expect(clickTag(false)).toEqual({ tags: ["finnish"], handled: true })
  })

  it("places the caret while editing and follows the tag on Cmd/Ctrl-click", () => {
    expect(clickTag(true)).toEqual({ tags: [], handled: false })
    expect(clickTag(true, { metaKey: true })).toEqual({ tags: ["finnish"], handled: true })
  })
})
