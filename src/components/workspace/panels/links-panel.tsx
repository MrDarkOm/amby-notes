"use client"

import * as React from "react"
import { Link as LinkIcon, Search } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { LinkGraphEdge, PanelRenderProps } from "../panel-registry"

export function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const nodes = linkGraph?.nodes ?? []
  const edges = linkGraph?.edges ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const q = query.trim().toLocaleLowerCase()
  const outgoing = currentDocId ? edges.filter((e) => e.source === currentDocId) : []
  const backlinks = currentDocId ? edges.filter((e) => e.target === currentDocId) : []
  const allLinks = edges.filter((edge) => {
    if (!q) return true
    const from = nodeById.get(edge.source)?.label ?? edge.source
    const to = nodeById.get(edge.target)?.label ?? edge.label
    return `${from} ${to} ${edge.label}`.toLocaleLowerCase().includes(q)
  })

  function LinkRow({ edge, direction }: { edge: LinkGraphEdge; direction: "out" | "in" | "all" }) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    const clickableId = direction === "in" ? edge.source : edge.target
    const clickableNode = nodeById.get(clickableId)
    return (
      <button
        disabled={!clickableNode || clickableNode.unresolved}
        onClick={() =>
          clickableNode && !clickableNode.unresolved && onSelectLink?.(clickableNode.id)
        }
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      >
        <LinkIcon
          className={cn(
            "size-3.5 shrink-0",
            edge.unresolved ? "text-muted-foreground" : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-[12px]",
              edge.unresolved ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {direction === "all"
              ? `${source?.label ?? edge.source} → ${target?.label ?? edge.label}`
              : (clickableNode?.label ?? edge.label)}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {edge.unresolved
              ? t("linksPanel.unresolved")
              : direction === "in"
                ? t("linksPanel.backlink")
                : t("linksPanel.wikiLink")}
          </p>
        </div>
      </button>
    )
  }

  function Section({
    title,
    list,
    direction,
  }: {
    title: string
    list: LinkGraphEdge[]
    direction: "out" | "in" | "all"
  }) {
    return (
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <span className="text-[10px] text-muted-foreground">{list.length}</span>
        </div>
        {list.length ? (
          list.map((edge, i) => (
            <LinkRow
              key={`${edge.source}-${edge.target}-${direction}-${i}`}
              edge={edge}
              direction={direction}
            />
          ))
        ) : (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("graph.noLinks")}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("linksPanel.search")}
            className="h-7 border-border bg-card pl-7 text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-1 py-2">
          <Section title={t("linksPanel.outgoing")} list={outgoing} direction="out" />
          <Section title={t("linksPanel.backlinks")} list={backlinks} direction="in" />
          <Section title={t("linksPanel.all")} list={allLinks} direction="all" />
        </div>
      </ScrollArea>
    </div>
  )
}
