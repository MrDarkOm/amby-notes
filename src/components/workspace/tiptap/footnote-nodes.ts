import { Extension, Node, mergeAttributes } from "@tiptap/core"
import { Fragment } from "@tiptap/pm/model"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"

// Footnotes as nodes of the note. Nothing here decides how a footnote is written to the
// file: see markdown-footnotes.ts (reading) and the serializer (writing).

const labelAttribute = (attribute: string) => ({
  default: "",
  parseHTML: (element: HTMLElement) => element.getAttribute(attribute) ?? "",
  renderHTML: () => ({}),
})

/** `[^label]` in the text: a small raised mark that leads to its definition. */
export const FootnoteReference = Node.create({
  name: "footnoteReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { label: labelAttribute("data-footnote-ref") }
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote-ref]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "sup",
      mergeAttributes(HTMLAttributes, {
        class: "amby-footnote-ref",
        "data-footnote-ref": node.attrs.label,
      }),
      String(node.attrs.label),
    ]
  },

  renderText({ node }) {
    return `[^${node.attrs.label}]`
  },
})

/** `^[text]`: a note written where it is referred to. Its text is kept as written. */
export const FootnoteInline = Node.create({
  name: "footnoteInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: {
        default: "",
        parseHTML: (element: HTMLElement) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote-inline]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "sup",
      mergeAttributes(HTMLAttributes, {
        class: "amby-footnote-inline",
        "data-footnote-inline": "",
      }),
      String(node.attrs.value),
    ]
  },

  renderText({ node }) {
    return `^[${node.attrs.value}]`
  },
})

/** `[^label]: text`: the text of a footnote, an ordinary line of the note. */
export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return { label: labelAttribute("data-footnote-def") }
  },

  parseHTML() {
    return [{ tag: "div[data-footnote-def]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: "amby-footnote-def",
        "data-footnote-def": node.attrs.label,
      }),
      0,
    ]
  },
})

type Dispatch = ((tr: Transaction) => void) | undefined

/** The first number no footnote of the note uses yet. */
export function nextFootnoteLabel(state: EditorState): string {
  const used = new Set<string>()
  state.doc.descendants((node) => {
    if (node.type.name === "footnoteReference" || node.type.name === "footnoteDefinition") {
      used.add(String(node.attrs.label))
    }
  })
  let number = 1
  while (used.has(String(number))) number++
  return String(number)
}

/**
 * Puts a footnote reference at the cursor and its empty definition at the end of the
 * note, with the cursor in the definition, ready for its text.
 */
export function insertFootnote(state: EditorState, dispatch?: Dispatch): boolean {
  const { footnoteReference, footnoteDefinition } = state.schema.nodes
  const { $from } = state.selection
  if (!footnoteReference || !footnoteDefinition) return false
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
  const label = nextFootnoteLabel(state)
  const tr = state.tr.replaceSelectionWith(footnoteReference.create({ label }))
  const end = tr.doc.content.size
  tr.insert(end, footnoteDefinition.create({ label }))
  tr.setSelection(TextSelection.create(tr.doc, end + 1))
  dispatch?.(tr.scrollIntoView())
  return true
}

const REFERENCE_TYPED = /\[\^([^\]\s[^]+)$/u
const INLINE_TYPED = /\^\[([^[\]\n]+)$/u

/**
 * What typing one character turns into a footnote:
 * - `]` after `[^label` — a reference;
 * - `]` after `^[text` — an inline note;
 * - a space after `[^label]:` at the start of a paragraph — a definition.
 */
export function footnoteTyped(
  state: EditorState,
  from: number,
  to: number,
  typed: string,
): Transaction | null {
  const { footnoteReference, footnoteInline, footnoteDefinition, paragraph } = state.schema.nodes
  if (from !== to) return null
  const $from = state.doc.resolve(from)
  const block = $from.parent
  if (!block.isTextblock || block.type.spec.code) return null
  if ($from.marks().some((mark) => mark.type.spec.code)) return null
  // Only the text node the cursor is in: a footnote does not cross a mark's edge.
  const before = $from.nodeBefore?.isText ? ($from.nodeBefore.text ?? "") : ""

  if (typed === "]") {
    // Inside backticks that are still being typed it is code, not a footnote.
    if ((before.match(/`/gu)?.length ?? 0) % 2 === 1) return null
    const reference = REFERENCE_TYPED.exec(before)
    if (reference) {
      const start = from - reference[0].length
      return state.tr.replaceWith(start, from, footnoteReference.create({ label: reference[1] }))
    }
    const inline = INLINE_TYPED.exec(before)
    if (inline) {
      const start = from - inline[0].length
      return state.tr.replaceWith(start, from, footnoteInline.create({ value: inline[1] }))
    }
    return null
  }

  if (typed === " " && block.type === paragraph && $from.depth === 1) {
    const first = block.firstChild
    if (first?.type !== footnoteReference || before !== ":") return null
    if ($from.parentOffset !== first.nodeSize + 1) return null
    const text = block.content.cut($from.parentOffset)
    const definition = footnoteDefinition.create({ label: first.attrs.label }, Fragment.from(text))
    const tr = state.tr.replaceWith($from.before(), $from.after(), definition)
    return tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1))
  }
  return null
}

/** Typing footnotes, and a click on a reference that leads to its definition. */
export const FootnoteTyping = Extension.create({
  name: "footnoteTyping",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ambyFootnoteTyping"),
        props: {
          handleTextInput(view, from, to, text) {
            const tr = footnoteTyped(view.state, from, to, text)
            if (!tr) return false
            view.dispatch(tr)
            return true
          },
          handleClickOn(view, _pos, node, _nodePos, event) {
            if (node.type.name !== "footnoteReference" || !(event.metaKey || event.ctrlKey)) {
              return false
            }
            const target = Array.from(
              view.dom.querySelectorAll<HTMLElement>("[data-footnote-def]"),
            ).find((element) => element.dataset.footnoteDef === String(node.attrs.label))
            target?.scrollIntoView({ block: "center" })
            return Boolean(target)
          },
        },
      }),
    ]
  },
})
