"use client"

import * as React from "react"
import { ArrowRight, Link as LinkIcon, List } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { LinkGraphEdge, PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

export function LinksPanel({ linkGraph, currentDocId, onSelectLink }: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [allOpen, setAllOpen] = React.useState(false)
  const [allQuery, setAllQuery] = React.useState("")
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
  const allSearch = allQuery.trim().toLocaleLowerCase()
  const allLinks = edges.filter((edge) => {
    const from = nodeById.get(edge.source)?.label ?? edge.source
    const to = nodeById.get(edge.target)?.label ?? edge.label
    return `${from} ${to} ${edge.label}`.toLocaleLowerCase().includes(allSearch)
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
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      >
        <LinkIcon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            edge.unresolved ? "text-muted-foreground" : "text-primary",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "break-words text-[12px] leading-4 [overflow-wrap:anywhere]",
              edge.unresolved ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {direction === "all"
              ? `${source?.label ?? edge.source} → ${target?.label ?? edge.label}`
              : (clickableNode?.label ?? edge.label)}
          </p>
          <p className="break-words text-[10px] leading-4 text-muted-foreground [overflow-wrap:anywhere]">
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
      <PanelHeader
        title={t("panels.links")}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("linksPanel.all")}
            aria-label={t("linksPanel.all")}
            onClick={() => setAllOpen(true)}
          >
            <List className="size-4" />
          </Button>
        }
      />
      <PanelSearch value={query} onChange={setQuery} placeholder={t("linksPanel.search")} />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-4 mb-3 grid h-8 w-[calc(100%-2rem)] grid-cols-2">
          <TabsTrigger
            value="outgoing"
            title={t("linksPanel.outgoing")}
            aria-label={t("linksPanel.outgoing")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("linksPanel.outgoing")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="incoming"
            title={t("linksPanel.backlinks")}
            aria-label={t("linksPanel.backlinks")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("linksPanel.backlinks")}</span>
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
      </Tabs>
      <Dialog open={allOpen} onOpenChange={setAllOpen}>
        <DialogContent
          className="flex h-[min(76vh,720px)] min-h-0 flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-4xl"
          aria-describedby={undefined}
        >
          <div className="border-b px-5 pb-4 pt-5 pr-12">
            <DialogTitle className="text-xl tracking-tight">{t("linksPanel.all")}</DialogTitle>
            <Input
              className="mt-4"
              value={allQuery}
              onChange={(event) => setAllQuery(event.target.value)}
              placeholder={t("linksPanel.search")}
              aria-label={t("linksPanel.search")}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {allLinks.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("graph.noLinks")}</p>
            ) : (
              <div className="space-y-1">
                {allLinks.map((edge, index) => {
                  const source = nodeById.get(edge.source)
                  const target = nodeById.get(edge.target)
                  const select = (id: string) => {
                    setAllOpen(false)
                    onSelectLink?.(id)
                  }
                  return (
                    <div
                      key={`${edge.source}-${edge.target}-${index}`}
                      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/50"
                    >
                      <button
                        className="min-w-0 flex-1 truncate rounded text-left text-sm hover:text-primary focus-visible:outline focus-visible:outline-1"
                        disabled={!source || source.unresolved}
                        onClick={() => source && select(source.id)}
                      >
                        {source?.label ?? edge.source}
                      </button>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      <button
                        className="min-w-0 flex-1 truncate rounded text-left text-sm hover:text-primary focus-visible:outline focus-visible:outline-1 disabled:text-muted-foreground"
                        disabled={!target || target.unresolved}
                        onClick={() => target && select(target.id)}
                      >
                        {target?.label ?? edge.label}
                      </button>
                      {edge.unresolved && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t("linksPanel.unresolved")}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
