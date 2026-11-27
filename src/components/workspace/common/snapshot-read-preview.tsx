import type { JSONContent } from "@tiptap/core"
import * as React from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { useTranslation } from "react-i18next"
import { splitWebFrontmatter } from "@/lib/storage/web-frontmatter"
import { markdownToDoc } from "../tiptap/markdown"
import type { SnapshotAssets } from "./snapshot-assets"
import { buildSnapshotExtensions } from "./snapshot-extensions"

// Obsidian image embeds use the transclusion parser node; display only image
// targets here, while note/database transclusions remain isolated source text.
function displayImages(node: JSONContent): JSONContent {
  if (
    node.type === "transclusion" &&
    /\.(?:png|jpe?g|gif|webp|svg|avif)$/iu.test(node.attrs?.target ?? "")
  ) {
    return {
      type: "paragraph",
      content: [{ type: "image", attrs: { src: node.attrs?.target, alt: node.attrs?.target } }],
    }
  }
  return node.content ? { ...node, content: node.content.map(displayImages) } : node
}

/** Independent reader: no document ID, serializers, autosave, or active-vault context. */
export default function SnapshotReadPreview({
  content,
  assets,
}: {
  content: string
  assets?: SnapshotAssets
}) {
  const { t } = useTranslation()
  const doc = React.useMemo(() => {
    const text = content.replace(/^\uFEFF/u, "")
    return displayImages(markdownToDoc(splitWebFrontmatter(text)?.body ?? text))
  }, [content])
  const extensions = React.useMemo(() => buildSnapshotExtensions(assets), [assets])
  const label = t("snapshotPreview.read")
  // Reapplying DOM props on each render can wake node-view mutation observers.
  const editorProps = React.useMemo(
    () => ({
      attributes: { class: "amby-tiptap-prose", role: "document", "aria-label": label },
      handleDOMEvents: {
        click: (_view: unknown, event: MouseEvent) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            event.preventDefault()
            return true
          }
          return false
        },
      },
    }),
    [label],
  )
  const editor = useEditor(
    {
      extensions,
      content: doc,
      editable: false,
      injectCSS: false,
      autofocus: false,
      immediatelyRender: false,
      editorProps,
    },
    [content, label, assets],
  )
  return (
    <div className="amby-tiptap amby-snapshot-read min-w-0 select-text" data-editor-readonly="true">
      <EditorContent editor={editor} />
    </div>
  )
}
