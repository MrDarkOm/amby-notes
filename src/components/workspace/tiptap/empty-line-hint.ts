import { Extension } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import i18n from "@/lib/i18n"

/**
 * The slash-menu hint on the empty line the cursor is on, inside columns, lists,
 * quotes and callouts. The Placeholder extension only does this for top-level lines
 * cheaply: with `includeChildren` it keeps its decorations incrementally and leaves
 * a stale hint behind when the cursor moves from a top-level line into a column.
 */
export const EmptyLineHint = Extension.create({
  name: "emptyLineHint",

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          decorations: ({ selection }) => {
            if (!editor.isEditable || !selection.empty) return null
            const { $from } = selection
            if ($from.depth < 2 || $from.parent.type.name !== "paragraph") return null
            if ($from.parent.content.size > 0) return null
            return DecorationSet.create($from.doc, [
              Decoration.node($from.before(), $from.after(), {
                class: "is-empty",
                "data-placeholder": i18n.t("editor.slashHint"),
              }),
            ])
          },
        },
      }),
    ]
  },
})
