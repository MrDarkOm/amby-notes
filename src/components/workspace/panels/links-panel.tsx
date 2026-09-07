"use client"

import * as React from "react"
import { ArrowDownLeft, ArrowUpRight, Link as LinkIcon, Link2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { LinkGraphEdge, PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

export function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const nodes = linkGraph?.nodes ?? []
  const edges = linkGraph?.edges ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const q = query.trim().toLocaleLowerCase()
  const [activeTab, setActiveTab] = React.useState("outgoing")
  const outgoing = currentDocId ? edges.filter((e) => e.source === currentDocId) : []
  const backlinks = currentDocId ? edges.filter((e) => e.target === currentDocId) : []
  const matchesQuery = (edge: LinkGraphEdge) => {
    if (!q) return true
    const from = nodeById.get(edge.source)?.label ?? edge.source
    const to = nodeById.get(edge.target)?.label ?? edge.label
    return `${from} ${to} ${edge.label}`.toLocaleLowerCase().includes(q)
  }
  const visibleOutgoing = outgoing.filter(matchesQuery)
  const visibleBacklinks = backlinks.filter(matchesQuery)
  const allLinks = edges.filter(matchesQuery)

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
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
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
    list,
    direction,
  }: {
    list: LinkGraphEdge[]
    direction: "out" | "in" | "all"
  }) {
    return list.length ? (
      list.map((edge, i) => (
        <LinkRow
          key={`${edge.source}-${edge.target}-${direction}-${i}`}
          edge={edge}
          direction={direction}
        />
      ))
    ) : (
      <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("graph.noLinks")}</p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={t("panels.links")} />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("linksPanel.search")} />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-4 mb-3 h-8 w-fit">
          <TabsTrigger
            value="outgoing"
            title={t("linksPanel.outgoing")}
            aria-label={t("linksPanel.outgoing")}
            className="size-8 flex-none p-0"
          >
            <ArrowUpRight className="size-3.5" />
          </TabsTrigger>
          <TabsTrigger
            value="incoming"
            title={t("linksPanel.backlinks")}
            aria-label={t("linksPanel.backlinks")}
            className="size-8 flex-none p-0"
          >
            <ArrowDownLeft className="size-3.5" />
          </TabsTrigger>
          <TabsTrigger
            value="all"
            title={t("linksPanel.all")}
            aria-label={t("linksPanel.all")}
            className="size-8 flex-none p-0"
          >
            <Link2 className="size-3.5" />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="outgoing" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1 px-4 pb-4">
              <Section list={visibleOutgoing} direction="out" />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="incoming" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1 px-4 pb-4">
              <Section list={visibleBacklinks} direction="in" />
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="all" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1 px-4 pb-4">
              <Section list={allLinks} direction="all" />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
