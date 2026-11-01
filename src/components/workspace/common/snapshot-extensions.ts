import { ReactNodeViewRenderer } from "@tiptap/react"
import { SnapshotImage } from "./snapshot-image"
import type { SnapshotAssets } from "./snapshot-assets"
import { Extension } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"
import i18n from "@/lib/i18n"
import { schemaExtensions } from "../tiptap/schema"
import { AmbyImage } from "../tiptap/amby-image"
import { AmbyBlockNode } from "../tiptap/amby-block-node"
import { TransclusionNode } from "../tiptap/transclusion-node"
import { InlineMathView } from "../tiptap/math-inline"
import { TableAlignment } from "../tiptap/table-alignment"

const immutableSnapshot = Extension.create({
  name: "immutableSnapshot",
  addProseMirrorPlugins() {
    return [new Plugin({ filterTransaction: (transaction) => !transaction.docChanged })]
  },
})

// A snapshot carries text, not historical sidecars or the current state of another
// note/database. Never mount a live database or fetch transclusions. Images use
// an explicit snapshot path; the DOM fallback stays inert.
const snapshotImage = AmbyImage.extend<
  import("@tiptap/extension-image").ImageOptions & { snapshotAssets?: SnapshotAssets }
>({
  addOptions() {
    return {
      inline: true,
      allowBase64: false,
      HTMLAttributes: {},
      resize: false,
      ...this.parent?.(),
      snapshotAssets: undefined,
    }
  },
  renderHTML({ node }) {
    return [
      "span",
      { "data-snapshot-image": "" },
      i18n.t("snapshotPreview.image", { name: node.attrs.alt || node.attrs.src }),
    ]
  },
  addNodeView() {
    return ReactNodeViewRenderer(SnapshotImage)
  },
})
const snapshotBlock = AmbyBlockNode.extend({
  renderHTML({ node }) {
    return [
      "pre",
      { class: "amby-opaque-markdown" },
      `\`\`\`amby-${node.attrs.blockType}\n${node.attrs.blockId}\n\`\`\``,
    ]
  },
  addNodeView() {
    return null
  },
})
const snapshotTransclusion = TransclusionNode.extend({
  renderHTML({ node }) {
    return ["pre", { class: "amby-opaque-markdown" }, node.attrs.raw || `![[${node.attrs.target}]]`]
  },
  addNodeView() {
    return null
  },
})

export function buildSnapshotExtensions(assets?: SnapshotAssets) {
  return [
    ...schemaExtensions.filter(
      (extension) => !["image", "ambyBlock", "transclusion"].includes(extension.name),
    ),
    snapshotImage.configure({ inline: true, snapshotAssets: assets }),
    snapshotBlock,
    snapshotTransclusion,
    InlineMathView,
    TableAlignment,
    immutableSnapshot,
  ]
}
