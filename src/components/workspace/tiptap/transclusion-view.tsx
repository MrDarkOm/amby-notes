"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"

import { markdownToHtml } from "./markdown"
import { getTransclusionFetcher } from "./transclusion-context"

type LoadState = "idle" | "loading" | "done" | "error"

/** Renders an Obsidian-compatible transclusion as a read-only preview. */
export function TransclusionView({ node, editor }: NodeViewProps) {
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
  }, [editor, target])

  return (
    <NodeViewWrapper
      as="div"
      data-type="transclusion"
      data-target={target}
      contentEditable={false}
      className="transclusion-embed my-2 overflow-hidden rounded border border-border bg-card/40 select-none"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
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
