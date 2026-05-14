import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion"

import { markdownToDoc } from "./markdown"

interface SlashItem {
  title: string
  hint: string
  run: (editor: Editor, range: Range) => void
}

const ITEMS: SlashItem[] = [
  {
    title: "Callout",
    hint: "> [!NOTE]",
    run: (editor, range) => {
      const doc = markdownToDoc("> [!NOTE]\n> ") as { content?: object }
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent((doc.content as object) ?? "> [!NOTE]\n> ")
        .run()
    },
  },
  {
    title: "Tag",
    hint: "#tag",
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent("#tag ").run()
    },
  },
  {
    title: "Backlink",
    hint: "[[Note]]",
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent("[[Note]]").run()
    },
  },
]

// Lightweight plain-DOM popup for the `/` slash menu — keeps callout / tag /
// wikilink insertion available without a React renderer.
class SlashPopup {
  private root: HTMLElement
  private items: SlashItem[] = []
  private selected = 0
  private props: SuggestionProps<SlashItem> | null = null

  constructor() {
    this.root = document.createElement("div")
    this.root.className = "amby-slash-menu"
    this.root.style.position = "fixed"
    this.root.style.zIndex = "60"
  }

  update(props: SuggestionProps<SlashItem>) {
    this.props = props
    this.items = props.items
    this.selected = 0
    const rect = props.clientRect?.()
    if (!this.items.length || !rect) {
      this.hide()
      return
    }
    if (!this.root.isConnected) document.body.appendChild(this.root)
    this.root.style.left = `${rect.left}px`
    this.root.style.top = `${rect.bottom + 6}px`
    this.render()
  }

  private render() {
    this.root.replaceChildren()
    this.items.forEach((item, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "amby-slash-item" + (index === this.selected ? " is-active" : "")
      const title = document.createElement("span")
      title.className = "amby-slash-title"
      title.textContent = item.title
      const hint = document.createElement("span")
      hint.className = "amby-slash-hint"
      hint.textContent = item.hint
      button.append(title, hint)
      button.addEventListener("mousedown", event => {
        event.preventDefault()
        this.choose(index)
      })
      this.root.appendChild(button)
    })
  }

  private choose(index: number) {
    const item = this.items[index]
    const props = this.props
    if (item && props) item.run(props.editor, props.range)
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.items.length) return false
    if (event.key === "ArrowDown") {
      this.selected = (this.selected + 1) % this.items.length
      this.render()
      return true
    }
    if (event.key === "ArrowUp") {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length
      this.render()
      return true
    }
    if (event.key === "Enter") {
      this.choose(this.selected)
      return true
    }
    if (event.key === "Escape") {
      this.hide()
      return true
    }
    return false
  }

  hide() {
    if (this.root.isConnected) this.root.remove()
  }
}

export const SlashMenu = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        startOfLine: false,
        items: ({ query }) =>
          ITEMS.filter(item => item.title.toLowerCase().includes(query.toLowerCase())),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let popup: SlashPopup | null = null
          return {
            onStart: props => {
              popup = new SlashPopup()
              popup.update(props)
            },
            onUpdate: props => popup?.update(props),
            onKeyDown: ({ event }) => popup?.onKeyDown(event) ?? false,
            onExit: () => {
              popup?.hide()
              popup = null
            },
          }
        },
      }),
    ]
  },
})
