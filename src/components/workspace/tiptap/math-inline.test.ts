// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"

import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  roundTripCheck,
} from "./markdown"
import { InlineMathView, findInlineMath } from "./math-inline"
import { displayMathSource } from "./rendered-source"
import { schemaExtensions } from "./schema"

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

const formulas = (markdown: string) => {
  const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown))
  return findInlineMath(doc, 0, doc.content.size).map((math) => math.tex)
}

function mount(markdown: string): Editor {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [...schemaExtensions, InlineMathView],
    content: markdownToDoc(markdown),
  })
  return editor
}

describe("inline formulas", () => {
  it("finds formulas written between dollars", () => {
    expect(formulas("Energy is $E = mc^2$ here.")).toEqual(["E = mc^2"])
    expect(formulas("Two: $a$ and $b + c$.")).toEqual(["a", "b + c"])
    expect(formulas("With a command $\\frac{1}{2}$ inside.")).toEqual(["\\frac{1}{2}"])
    expect(formulas("An escaped dollar inside $a \\$ b$ stays.")).toEqual(["a \\$ b"])
  })

  it("does not take money or loose dollars for formulas", () => {
    expect(formulas("It costs $5 and $10 today.")).toEqual([])
    expect(formulas("From $5 to $10.")).toEqual([])
    expect(formulas("Price: $5, tax: $2")).toEqual([])
    expect(formulas("A lone $ sign and another $ sign.")).toEqual([])
    expect(formulas("US$5 and R$10")).toEqual([])
    expect(formulas("$$")).toEqual([])
  })

  it("leaves code alone", () => {
    expect(formulas("In code `$x$` it is text.")).toEqual([])
    expect(formulas("```\n$x$\n```")).toEqual([])
  })

  it("covers exactly the formula with its dollars", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("So $x^2$ it is"))
    const [math] = findInlineMath(doc, 0, doc.content.size)
    expect(doc.textBetween(math.from, math.to)).toBe("$x^2$")
  })

  it("draws a formula in place of its text and never changes the note", () => {
    const source = "Energy is $E = mc^2$ here."
    const target = mount(source)
    target.commands.setTextSelection(2)
    expect(target.view.dom.querySelectorAll(".amby-math-inline")).toHaveLength(1)
    expect(target.view.dom.querySelector(".amby-math-source")?.textContent).toBe("$E = mc^2$")
    expect(docToMarkdown(target.state.doc)).toBe(source)
  })

  it("shows the text again while the cursor touches the formula", () => {
    const target = mount("Energy is $E = mc^2$ here.")
    target.commands.setTextSelection(14)
    expect(target.view.dom.querySelector(".amby-math-inline")).toBeNull()
    expect(target.view.dom.querySelector(".amby-math-source")).toBeNull()
    target.commands.setTextSelection(25)
    expect(target.view.dom.querySelectorAll(".amby-math-inline")).toHaveLength(1)
  })

  it("follows edits: a formula appears when its closing dollar is typed", () => {
    const target = mount("Value $x")
    target.commands.focus("end")
    expect(target.view.dom.querySelector(".amby-math-source")).toBeNull()
    target.commands.insertContent("$ and more")
    expect(target.view.dom.querySelector(".amby-math-source")?.textContent).toBe("$x$")
    expect(docToMarkdown(target.state.doc)).toBe("Value $x$ and more")
  })
})

describe("a formula in the file", () => {
  const FORMULAS = [
    "Arrow $\\rightarrow$ here.",
    "Set $\\{a, b\\}$ here.",
    "Thin $a\\,b$ space.",
    "Row $a \\\\ b$ break.",
    "Subscripts $a_b$ and $c_d$ are not italics.",
    "Stars $a*b$ and $c*d$ are not italics.",
    "An escaped dollar inside $a \\$ b$ stays.",
    "**Bold** $x^2$ and a [link](https://example.com) with $y_1$.",
    "| a | $\\alpha_1$ |\n| --- | --- |\n| b | $\\beta\\,\\gamma$ |",
    "- item $\\frac{1}{2}$\n- other",
    "> quote $\\sum_{i=1}^n i$",
    "# Heading $\\pi$",
  ]

  it("is written back character for character when its block is rebuilt", () => {
    for (const source of FORMULAS) {
      const doc = editorSchema.nodeFromJSON(markdownToDoc(source))
      expect(docToNormalizedMarkdown(doc).trimEnd(), source).toBe(source)
      expect(roundTripCheck(source).ok, source).toBe(true)
    }
  })

  it("keeps its backslashes when the text around it is edited", () => {
    const target = mount("Arrow $\\rightarrow$ and set $\\{a\\}$ here.")
    target.commands.insertContentAt(1, "New ")
    expect(docToMarkdown(target.state.doc)).toBe("New Arrow $\\rightarrow$ and set $\\{a\\}$ here.")
    target.commands.focus("end")
    target.commands.insertContent(" More $\\frac{1}{2}$ typed.")
    const written = docToMarkdown(target.state.doc)
    expect(written).toBe(
      "New Arrow $\\rightarrow$ and set $\\{a\\}$ here. More $\\frac{1}{2}$ typed.",
    )
    expect(roundTripCheck(written).ok).toBe(true)
  })

  it("reads the text of a formula as it is written, with no emphasis inside", () => {
    const doc = editorSchema.nodeFromJSON(markdownToDoc("Subscripts $a_b$ and $c_d$ here."))
    expect(doc.firstChild?.childCount).toBe(1)
    expect(doc.textContent).toBe("Subscripts $a_b$ and $c_d$ here.")
  })

  it("still escapes what is not a formula", () => {
    // Money is ordinary text: a typed backslash in it is written escaped, as before.
    const target = mount("")
    target.commands.insertContent("Costs $5 \\ or $10")
    const written = docToMarkdown(target.state.doc)
    expect(written).toBe("Costs $5 \\\\ or $10")
    expect(editorSchema.nodeFromJSON(markdownToDoc(written)).textContent).toBe("Costs $5 \\ or $10")
  })
})

describe("display math", () => {
  it("takes the TeX from between the dollar lines", () => {
    expect(displayMathSource("$$\n\\int_0^1 x\\,dx\n$$")).toBe("\\int_0^1 x\\,dx")
    expect(displayMathSource("$$\r\na\r\nb\r\n$$")).toBe("a\r\nb")
  })

  it("draws the formula over a block that keeps its source text", async () => {
    const source = "Before\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter"
    const target = mount(source)
    const block = target.view.dom.querySelector(".amby-math-block")!
    expect(block).not.toBeNull()
    expect(block.querySelector("pre")?.textContent).toBe("$$\n\\int_0^1 x\\,dx\n$$")
    for (let turn = 0; turn < 20 && !block.classList.contains("is-drawn"); turn++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // The drawing itself needs a real browser document; it is checked in the browser
    // suite. Here: the block, its source and the untouched note.
    expect(block.querySelector(".amby-math-render")).not.toBeNull()
    expect(docToMarkdown(target.state.doc)).toBe(source)
  })

  it("draws other source blocks as their text", () => {
    const fence = '```js title="a.js"\nlet a\n```'
    const target = mount(`Text.\n\n${fence}`)
    const blocks = target.view.dom.querySelectorAll("pre.amby-opaque-markdown")
    expect(blocks).toHaveLength(1)
    expect(target.view.dom.querySelector(".amby-math-block")).toBeNull()
    expect(blocks[0].textContent).toBe(fence)
  })
})
