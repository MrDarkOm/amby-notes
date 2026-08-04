"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { Node, mergeAttributes } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { markdownToHtml } from "./markdown"
import { getTransclusionFetcher } from "./transclusion-context"

type LoadState = "idle" | "loading" | "done" | "error"

/**
 * NodeView for an `![[Note]]` transclusion block.
 * Fetches the referenced note's markdown content and renders it as a
 * read-only inline preview using the shared `markdownToHtml` renderer.
 */
function TransclusionView({ node, editor }: NodeViewProps) {
  const { t } = useTranslation()
  const target = node.attrs.target as string
  const [html, setHtml] = React.useState<string | null>(null)
  const [state, setState] = React.useState<LoadState>("idle")

  React.useEffect(() => {
    if (!target) return
    const fetch = getTransclusionFetcher(editor)
    if (!fetch) {
      setState("error")
      return
    }
    setState("loading")
    setHtml(null)
    let cancelled = false
    fetch(target)
      .then((content) => {
        if (cancelled) return
        if (content === null) {
          setState("error")
        } else {
          setHtml(markdownToHtml(content))
          setState("done")
        }
      })
      .catch(() => {
        if (!cancelled) setState("error")
      })
    return () => {
      cancelled = true
    }
  }, [target, editor])

  return (
    <NodeViewWrapper
      as="div"
      data-type="transclusion"
      data-target={target}
      contentEditable={false}
      className="transclusion-embed my-2 rounded border border-border bg-card/40 overflow-hidden select-none"
    >
      {/* Header row */}
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {/* Embed icon (two overlapping rectangles) */}
        <svg viewBox="0 0 16 16" fill="none" className="size-3 shrink-0" aria-hidden>
          <rect
            x="1"
            y="3"
            width="10"
            height="10"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <rect
            x="5"
            y="1"
            width="10"
            height="10"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
        <span className="truncate font-medium">{target}</span>
      </div>

      {/* Content area */}
      <div className="px-3 py-2 text-[13px] leading-relaxed text-foreground">
        {state === "idle" || state === "loading" ? (
          <span className="italic text-muted-foreground">{t("dbBlock.loading")}</span>
        ) : state === "error" ? (
          <span className="italic text-muted-foreground">
            {t("transclusion.notFound")}{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{target}</code>
          </span>
        ) : (
          <div
            className="prose prose-sm dark:prose-invert max-w-none pointer-events-none
              [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-0 [&_h1]:mb-1
              [&_h2]:text-sm  [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1
              [&_h3]:text-sm  [&_h3]:font-medium  [&_h3]:mt-1 [&_h3]:mb-0.5
              [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1
              [&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-2 [&_blockquote]:my-1
              [&_pre]:bg-muted [&_pre]:rounded [&_pre]:p-1 [&_pre]:my-1 [&_pre]:text-[11px] [&_pre]:overflow-auto"
            dangerouslySetInnerHTML={{ __html: html! }}
          />
        )}
      </div>
    </NodeViewWrapper>
  )
}

/**
 * Tiptap node for `![[Note Name]]` transclusion embeds.
 *
 * - On disk:  `![[Note Name]]` (Obsidian-compatible)
 * - In editor: renders as a read-only embed card showing the note's content
 * - atom: true — the block cannot be edited in place
 */
export const TransclusionNode = Node.create({
  name: "transclusion",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      target: { default: "" },
      raw: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="transclusion"]',
        getAttrs: (el) => ({
          target: (el as HTMLElement).getAttribute("data-target") ?? "",
          raw: (el as HTMLElement).getAttribute("data-raw") ?? "",
        }),
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "transclusion",
        "data-target": node.attrs.target as string,
        "data-raw": node.attrs.raw as string,
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TransclusionView)
  },
})
