import { Mark } from "@tiptap/core"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ambyUnderline: {
      toggleAmbyUnderline: () => ReturnType
    }
  }
}

// Underline mark. In-editor renders as <u>; on disk serialized by markdown.ts.
export const AmbyUnderline = Mark.create({
  name: "ambyUnderline",
  priority: 90,

  parseHTML() {
    return [
      { tag: "u" },
      {
        style: "text-decoration",
        consuming: false,
        getAttrs: value => (String(value).includes("underline") ? null : false),
      },
    ]
  },

  renderHTML() {
    return ["u", 0]
  },

  addCommands() {
    return {
      toggleAmbyUnderline:
        () =>
        ({ chain }) =>
          chain().toggleMark(this.name).run(),
    }
  },

  addKeyboardShortcuts() {
    return {
      "Mod-u": () => this.editor.commands.toggleAmbyUnderline(),
    }
  },
})
