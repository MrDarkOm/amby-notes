import { describe, expect, it } from "vitest"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { EditorState, TextSelection } from "@tiptap/pm/state"

import {
  docToMarkdown,
  docToNormalizedMarkdown,
  editorSchema,
  markdownToDoc,
  restoreSourceFormatting,
  roundTripCheck,
} from "./markdown"
import { sameDocument } from "./markdown-block-source"
import { markdownMeaning } from "./markdown-meaning"

const parse = (markdown: string) => editorSchema.nodeFromJSON(markdownToDoc(markdown))

/** The state with the cursor right before `find` in the note. */
function at(markdown: string, find: string): EditorState {
  const doc = parse(markdown)
  let pos = -1
  doc.descendants((node, nodePos) => {
    if (pos === -1 && node.isText && node.text?.includes(find)) {
      pos = nodePos + node.text.indexOf(find)
    }
  })
  expect(pos, `"${find}"`).toBeGreaterThan(-1)
  const base = EditorState.create({ schema: editorSchema, doc })
  return base.apply(base.tr.setSelection(TextSelection.create(doc, pos)))
}

const typeAt = (markdown: string, find: string, text: string) => {
  const state = at(markdown, find)
  return state.apply(state.tr.insertText(text, state.selection.from)).doc
}

/** Whatever was written must be the document the editor holds, for both readings. */
function expectSound(doc: PMNode) {
  const written = docToMarkdown(doc)
  expect(sameDocument(parse(written), doc), written).toBe(true)
  expect(markdownMeaning(written).content).toBe(
    markdownMeaning(docToNormalizedMarkdown(doc)).content,
  )
  expect(roundTripCheck(written).ok, written).toBe(true)
  return written
}

// Lists as people and other editors write them: none of these is the editor's own form.
const SPARSE = "* first\n\n* second\n\n* third"
const ESCAPED = "- one\n- 1\\. not a number\n- three"
const FOUR_SPACES = "- parent\n    - child a\n    - child b\n- sibling"
const PAREN = "1) alpha\n2) beta\n3) gamma"
const TASKS = "- [ ] open\n- [x] 1\\. done\n- [ ] later"
const STAR_TASKS = "* [ ] open\n* [x] done\n* [ ] later"
const WRAPPED = "- first line\n  continues here\n- second"

describe("a list written item by item", () => {
  it("is saved unchanged when nothing is edited", () => {
    for (const markdown of [SPARSE, ESCAPED, FOUR_SPACES, PAREN, TASKS, STAR_TASKS, WRAPPED]) {
      expect(roundTripCheck(markdown), markdown).toEqual({ ok: true, result: markdown })
      expect(restoreSourceFormatting(docToMarkdown(parse(markdown)), markdown)).toBe(markdown)
    }
  })

  it("rewrites only the edited item of a list with escapes", () => {
    const written = expectSound(typeAt(ESCAPED, "three", "new "))
    // The second item keeps the escape it was written with.
    expect(written).toBe("- one\n- 1\\. not a number\n- new three")
  })

  it("rewrites only the edited item of a sparse list and keeps its blank lines elsewhere", () => {
    const written = expectSound(typeAt(SPARSE, "third", "the "))
    expect(written).toBe("* first\n\n* second\n* the third")
    const first = expectSound(typeAt(SPARSE, "first", "the "))
    expect(first).toBe("* the first\n* second\n\n* third")
  })

  it("keeps the indentation of an untouched nested list", () => {
    const written = expectSound(typeAt(FOUR_SPACES, "sibling", "a "))
    expect(written).toBe("- parent\n    - child a\n    - child b\n- a sibling")
  })

  it("rewrites an item together with what is nested in it, and nothing else", () => {
    const written = expectSound(typeAt(FOUR_SPACES, "child b", "the "))
    expect(written).toBe("- parent\n  - child a\n  - the child b\n- sibling")
  })

  it("keeps untouched task items as they were ticked", () => {
    const written = expectSound(typeAt(TASKS, "later", "much "))
    expect(written).toBe("- [ ] open\n- [x] 1\\. done\n- [ ] much later")
  })

  it("keeps a wrapped item as it was wrapped", () => {
    const written = expectSound(typeAt(WRAPPED, "second", "the "))
    expect(written).toBe("- first line\n  continues here\n- the second")
  })

  it("leaves the blocks around the list as they were written", () => {
    const note = `Setext\n======\n\n${ESCAPED}\n\n* * *`
    const written = expectSound(typeAt(note, "three", "new "))
    expect(written).toBe("Setext\n======\n\n- one\n- 1\\. not a number\n- new three\n\n* * *")
  })

  it("writes a new item in the editor's form between untouched ones", () => {
    const doc = parse(ESCAPED)
    const list = doc.child(0)
    const item = editorSchema.nodes.listItem.create(
      null,
      editorSchema.nodes.paragraph.create(null, editorSchema.text("added")),
    )
    const items: PMNode[] = []
    list.forEach((child, _offset, index) => {
      items.push(child)
      if (index === 0) items.push(item)
    })
    const edited = doc.copy(Fragment.from(list.copy(Fragment.fromArray(items))))
    expect(expectSound(edited)).toBe("- one\n- added\n- 1\\. not a number\n- three")
  })

  it("keeps the other items when one is deleted from a bullet list", () => {
    const doc = parse(ESCAPED)
    const list = doc.child(0)
    const edited = doc.copy(
      Fragment.from(list.copy(Fragment.fromArray([list.child(1), list.child(2)]))),
    )
    expect(expectSound(edited)).toBe("- 1\\. not a number\n- three")
  })

  it("renumbers a numbered list when an item is deleted, since its numbers changed", () => {
    const doc = parse(PAREN)
    const list = doc.child(0)
    const edited = doc.copy(
      Fragment.from(list.copy(Fragment.fromArray([list.child(0), list.child(2)]))),
    )
    // `1)` kept beside a rewritten `2.` would be two lists, so the whole list is
    // written in the editor's form.
    expect(expectSound(edited)).toBe("1. alpha\n2. gamma")
  })

  it("keeps the indent of untouched items of a list that is indented as a whole", () => {
    const indented = "  - one\n  - two\n  - three"
    const written = expectSound(typeAt(indented, "three", "new "))
    expect(written).toBe("  - one\n  - two\n- new three")
  })

  it("falls back to the editor's form of the whole list when mixing would change it", () => {
    // A task list is rewritten with `-`: beside items kept with `*` it would be two lists.
    const written = expectSound(typeAt(STAR_TASKS, "later", "much "))
    expect(written).toBe("- [ ] open\n- [x] done\n- [ ] much later")
  })

  it("is the same list as before after Undo", () => {
    const state = at(SPARSE, "third")
    const edited = state.apply(state.tr.insertText("x", state.selection.from))
    const undone = edited.apply(edited.tr.delete(state.selection.from, state.selection.from + 1))
    expect(docToMarkdown(undone.doc)).toBe(SPARSE)
  })
})

describe("any edit of any list", () => {
  const LISTS = [
    SPARSE,
    ESCAPED,
    FOUR_SPACES,
    PAREN,
    TASKS,
    STAR_TASKS,
    WRAPPED,
    "  - one\n  - two\n  - three",
    "+ a\n+ b\n\n+ c\n  more\n\n  second paragraph\n+ d",
    " 9. nine\n10. ten\n11. eleven",
    "3. three\n4. four\n7. seven",
    "- a\n  1. x\n  2. y\n- b\n  > quote\n- c\n  ```\n  code\n  ```",
    "Intro\n\n- one\n- two\n\nOutro\n\n* x\n* y",
    "- [ ] a\n  - [x] nested\n- [ ] b",
  ]

  it("is written as the list the editor holds", () => {
    // A fixed sequence, so that a failure can be reproduced.
    let seed = 7
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % below
    }
    const texts = ["x", " new", "1. ", "- ", "*", "# ", "> ", "[^1]", "$a_b$", "\\", "  "]
    for (const markdown of LISTS) {
      let doc = parse(markdown)
      for (let step = 0; step < 14; step++) {
        const state = EditorState.create({ schema: editorSchema, doc })
        const positions: number[] = []
        doc.descendants((node, pos) => {
          if (node.isTextblock && !node.type.spec.code)
            positions.push(pos + 1 + random(node.content.size + 1))
        })
        const at = positions[random(positions.length)]
        const tr = state.tr
        const kind = random(4)
        try {
          if (kind === 0) tr.insertText(texts[random(texts.length)], at)
          else if (kind === 1) tr.delete(at, Math.min(doc.content.size, at + 1 + random(3)))
          else if (kind === 2) tr.split(at, Math.min(2, tr.doc.resolve(at).depth))
          else {
            // Remove a whole item of some list.
            const items: Array<{ from: number; to: number }> = []
            doc.descendants((node, pos) => {
              if (node.type.name === "listItem" || node.type.name === "taskItem") {
                items.push({ from: pos, to: pos + node.nodeSize })
              }
            })
            const item = items[random(items.length)]
            const parent = doc.resolve(item.from).parent
            if (parent.childCount > 1) tr.delete(item.from, item.to)
          }
        } catch {
          continue
        }
        if (!tr.docChanged) continue
        doc = tr.doc
        const written = docToMarkdown(doc)
        const label = `${JSON.stringify(markdown)} step ${step}: ${JSON.stringify(written)}`
        expect(
          sameDocument(parse(written), doc) ||
            sameDocument(parse(written), parse(docToNormalizedMarkdown(doc))),
          label,
        ).toBe(true)
        expect(markdownMeaning(written).content, label).toBe(
          markdownMeaning(docToNormalizedMarkdown(doc)).content,
        )
      }
    }
  })
})

describe("two lists one after the other", () => {
  const cut = (markdown: string) => {
    const doc = parse(markdown)
    const blocks: PMNode[] = []
    doc.forEach((child) => {
      if (child.type.name !== "paragraph") blocks.push(child)
    })
    return doc.copy(Fragment.fromArray(blocks))
  }
  const types = (doc: PMNode) => {
    const names: string[] = []
    doc.forEach((child) => names.push(`${child.type.name}:${child.childCount}`))
    return names
  }

  it("stay two lists when the paragraph between them is deleted", () => {
    const doc = cut("- a\n- b\n\nmiddle\n\n- c\n- d")
    const written = expectSound(doc)
    expect(written).toBe("- a\n- b\n\n* c\n* d")
    expect(types(parse(written))).toEqual(["bulletList:2", "bulletList:2"])
  })

  it("keep the bullet of the first list, whatever it is", () => {
    const written = expectSound(cut("* a\n\nmiddle\n\n* c"))
    expect(written).toBe("* a\n\n- c")
    expect(types(parse(written))).toEqual(["bulletList:1", "bulletList:1"])
  })

  it("stay apart when one of them is a task list", () => {
    const written = expectSound(cut("- [ ] a\n\nmiddle\n\n- [x] c"))
    expect(types(parse(written))).toEqual(["taskList:1", "taskList:1"])
    const mixed = expectSound(cut("- a\n\nmiddle\n\n- [ ] c"))
    expect(types(parse(mixed))).toEqual(["bulletList:1", "taskList:1"])
  })

  it("alternate through three lists in a row", () => {
    const written = expectSound(cut("- a\n\nx\n\n- b\n\ny\n\n- c"))
    expect(written).toBe("- a\n\n* b\n\n- c")
    expect(types(parse(written))).toEqual(["bulletList:1", "bulletList:1", "bulletList:1"])
  })

  it("are left as written when they already use different bullets", () => {
    const markdown = "- a\n\n+ c"
    expect(roundTripCheck(markdown)).toEqual({ ok: true, result: markdown })
    expect(types(parse(markdown))).toEqual(["bulletList:1", "bulletList:1"])
  })
})
