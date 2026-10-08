// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"

import { InlineSuggest, matchTrigger, readInlineSuggest } from "./inline-suggest"
import { setSuggestionSources, suggestNotes, suggestTags } from "./link-suggestions"
import { docToMarkdown, markdownToDoc } from "./markdown"
import { schemaExtensions } from "./schema"

let editor: Editor | null = null
let removeSources: (() => void) | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
  removeSources?.()
  removeSources = null
})

const NOTES = [
  { name: "Finnish grammar", path: "Languages/Finnish grammar" },
  { name: "Grammar", path: "Languages/Grammar" },
  { name: "Index", path: "Index" },
  { name: "Index", path: "Projects/Index" },
  { name: "Ёлка & <b>", path: "Ёлка & <b>" },
]

function useSources(tags: string[] = ["inbox", "inbox/to-read", "Project", "идея"]) {
  removeSources = setSuggestionSources({ notes: () => NOTES, tags: async () => tags })
}

function mount(markdown: string): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...schemaExtensions, InlineSuggest],
    content: markdownToDoc(markdown),
  })
  editor.commands.focus("end")
  return editor
}

function type(target: Editor, text: string) {
  for (const character of text) {
    const { from, to } = target.state.selection
    const handled = target.view.someProp("handleTextInput", (handler) =>
      handler(target.view, from, to, character, () =>
        target.state.tr.insertText(character, from, to),
      ),
    )
    if (!handled) target.view.dispatch(target.state.tr.insertText(character, from, to))
  }
}

function press(target: Editor, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  return Boolean(target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)))
}

/** Lets the Suggestion plugin's asynchronous item lookup finish. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("what is offered", () => {
  it("ranks notes by where the query matches and writes a path for a shared name", () => {
    useSources()
    expect(suggestNotes("gram").map((item) => item.value)).toEqual(["Grammar", "Finnish grammar"])
    expect(suggestNotes("").length).toBe(NOTES.length)
    expect(suggestNotes("zzz")).toEqual([])
    // Two notes are called "Index": the name alone would open the first one.
    expect(suggestNotes("index").map((item) => item.value)).toEqual(["Index", "Projects/Index"])
    // A folder name finds the notes in it, after the notes named so.
    expect(suggestNotes("languages").map((item) => item.label)).toEqual([
      "Grammar",
      "Finnish grammar",
    ])
  })

  it("offers existing tags, those of the open note included, never the typed one itself", async () => {
    useSources()
    expect((await suggestTags("in", [])).map((item) => item.value)).toEqual([
      "inbox",
      "inbox/to-read",
    ])
    expect((await suggestTags("inbox", [])).map((item) => item.value)).toEqual(["inbox/to-read"])
    expect((await suggestTags("ид", [])).map((item) => item.value)).toEqual(["идея"])
    expect((await suggestTags("lo", ["local"])).map((item) => item.value)).toEqual(["local"])
    expect((await suggestTags("PRO", ["project"])).map((item) => item.value)).toEqual(["project"])
  })

  it("still offers the tags of the note when the index cannot be read", async () => {
    removeSources = setSuggestionSources({
      notes: () => [],
      tags: async () => {
        throw new Error("no index")
      },
    })
    expect((await suggestTags("", ["one"])).map((item) => item.value)).toEqual(["one"])
  })
})

describe("the trigger", () => {
  const at = (markdown: string) => {
    const target = mount(markdown)
    return target.state.selection.$from
  }

  it("finds `[[` and the name typed after it", () => {
    expect(matchTrigger(at("See [[Gra"), "wikilink")).toMatchObject({ query: "Gra", text: "[[Gra" })
    expect(matchTrigger(at("See [["), "wikilink")?.query).toBe("")
    expect(matchTrigger(at("See [[Two words"), "wikilink")?.query).toBe("Two words")
  })

  it("is not a wikilink trigger once the link is closed, aliased or anchored", () => {
    expect(matchTrigger(at("See [[Note]] after"), "wikilink")).toBeNull()
    expect(matchTrigger(at("See [[Note|ali"), "wikilink")).toBeNull()
    expect(matchTrigger(at("See [[Note#Head"), "wikilink")).toBeNull()
    expect(matchTrigger(at("See [single"), "wikilink")).toBeNull()
  })

  it("finds `#` at the start of a word only", () => {
    expect(matchTrigger(at("A #in"), "tag")).toMatchObject({ query: "in", text: "#in" })
    expect(matchTrigger(at("Tag: #"), "tag")?.query).toBe("")
    expect(matchTrigger(at("word#in"), "tag")).toBeNull()
    expect(matchTrigger(at("A #in box"), "tag")).toBeNull()
  })

  it("covers exactly the typed trigger in the note", () => {
    const target = mount("A #in")
    const match = matchTrigger(target.state.selection.$from, "tag")!
    expect(target.state.doc.textBetween(match.range.from, match.range.to)).toBe("#in")
  })

  it("stays out of code", () => {
    const target = mount("```\n[[No\n```")
    target.commands.setTextSelection(5)
    expect(target.state.selection.$from.parent.type.name).toBe("codeBlock")
    expect(matchTrigger(target.state.selection.$from, "wikilink")).toBeNull()
  })
})

describe("typing in the editor", () => {
  it("offers notes after `[[` and writes the chosen one as a wikilink", async () => {
    useSources()
    const target = mount("See ")
    type(target, "[[gram")
    await settle()
    const state = readInlineSuggest(target)!
    expect(state.open).toBe(true)
    expect(state.kind).toBe("wikilink")
    expect(state.items.map((item) => item.label)).toEqual(["Grammar", "Finnish grammar"])

    expect(press(target, "ArrowDown")).toBe(true)
    expect(readInlineSuggest(target)!.index).toBe(1)
    expect(press(target, "Enter")).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe("See [[Finnish grammar]]")
    expect(target.state.selection.from).toBe(target.state.doc.content.size - 1)
    await settle()
    expect(readInlineSuggest(target)!.open).toBe(false)
  })

  it("writes a name with special characters as it is", async () => {
    useSources()
    const target = mount("")
    type(target, "[[Ёл")
    await settle()
    expect(press(target, "Tab")).toBe(true)
    expect(target.state.doc.textContent).toBe("[[Ёлка & <b>]]")
  })

  it("offers tags after `#` and writes the chosen one", async () => {
    useSources()
    const target = mount("Text ")
    type(target, "#inb")
    await settle()
    const state = readInlineSuggest(target)!
    expect(state.kind).toBe("tag")
    expect(state.items.map((item) => item.label)).toEqual(["#inbox", "#inbox/to-read"])
    expect(press(target, "Enter")).toBe(true)
    expect(docToMarkdown(target.state.doc)).toBe("Text #inbox ")
  })

  it("leaves every key to the note when there is nothing to offer", async () => {
    useSources([])
    const target = mount("")
    type(target, "#")
    await settle()
    expect(readInlineSuggest(target)!.open).toBe(false)
    // Enter is the ordinary one, which makes a heading of a lone `#`.
    press(target, "Enter")
    expect(target.state.doc.toString()).toBe("doc(heading)")
  })

  it("closes on Escape and does not come back for the same trigger", async () => {
    useSources()
    const target = mount("")
    type(target, "[[gr")
    await settle()
    expect(readInlineSuggest(target)!.open).toBe(true)
    expect(press(target, "Escape")).toBe(true)
    await settle()
    expect(readInlineSuggest(target)!.open).toBe(false)
    expect(target.state.doc.textContent).toBe("[[gr")
  })
})
