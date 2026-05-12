"use client"

import * as React from "react"
import {
  Calendar,
  Clock,
  Hash,
  History,
  Info,
  Link,
  Plus,
  Search,
  Circle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"

type TabType = "info" | "history" | "links"

interface DocumentProperties {
  type: string
  status: string
  revisions: number
  backlinks: number
  created: string
  modified: string
  id: string
}

interface LinkGraphNode {
  id: string
  label: string
  unresolved?: boolean
}

interface LinkGraphEdge {
  source: string
  target: string
  label: string
  unresolved?: boolean
}

interface LinkGraph {
  nodes: LinkGraphNode[]
  edges: LinkGraphEdge[]
}

interface PropertiesPanelProps {
  properties: DocumentProperties | null
  linkGraph?: LinkGraph
  currentDocId?: string | null
  onSelectLink?: (id: string) => void
}

const tabs: { id: TabType; label: string; icon: React.ElementType }[] = [
  { id: "info", label: "Info", icon: Info },
  { id: "history", label: "History", icon: History },
  { id: "links", label: "Links", icon: Link },
]

function PropertyRow({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ElementType
  label: string
  value: React.ReactNode
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Icon className="size-3.5" />
        <span>{label}</span>
      </div>
      <div className={cn("text-xs text-zinc-300", valueClassName)}>{value}</div>
    </div>
  )
}

function LinksTab({
  graph, currentDocId, query, onSelectLink,
}: {
  graph?: LinkGraph
  currentDocId?: string | null
  query: string
  onSelectLink?: (id: string) => void
}) {
  const nodes = graph?.nodes ?? []
  const edges = graph?.edges ?? []
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const q = query.trim().toLocaleLowerCase()
  const outgoing = currentDocId ? edges.filter(edge => edge.source === currentDocId) : []
  const backlinks = currentDocId ? edges.filter(edge => edge.target === currentDocId) : []
  const allLinks = edges.filter(edge => {
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
        onClick={() => clickableNode && !clickableNode.unresolved && onSelectLink?.(clickableNode.id)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-zinc-800 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <Link className={cn("size-3.5 shrink-0", edge.unresolved ? "text-zinc-700" : "text-sky-400")} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-[12px]", edge.unresolved ? "text-zinc-600" : "text-zinc-300")}>
            {direction === "all" ? `${source?.label ?? edge.source} → ${target?.label ?? edge.label}` : clickableNode?.label ?? edge.label}
          </p>
          <p className="truncate text-[10px] text-zinc-600">{edge.unresolved ? "unresolved" : direction === "in" ? "backlink" : "wiki link"}</p>
        </div>
      </button>
    )
  }

  function Section({ title, list, direction }: { title: string; list: LinkGraphEdge[]; direction: "out" | "in" | "all" }) {
    return (
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{title}</p>
          <span className="text-[10px] text-zinc-700">{list.length}</span>
        </div>
        {list.length ? list.map((edge, i) => (
          <LinkRow key={`${edge.source}-${edge.target}-${direction}-${i}`} edge={edge} direction={direction} />
        )) : (
          <p className="px-2 py-1 text-[11px] text-zinc-700">Нет ссылок</p>
        )}
      </div>
    )
  }

  return (
    <div className="px-1 py-2">
      <Section title="Outgoing" list={outgoing} direction="out" />
      <Section title="Backlinks" list={backlinks} direction="in" />
      <Section title="All vault links" list={allLinks} direction="all" />
    </div>
  )
}

export function PropertiesPanel({ properties, linkGraph, currentDocId, onSelectLink }: PropertiesPanelProps) {
  const [activeTab, setActiveTab] = React.useState<TabType>("info")
  const [query, setQuery] = React.useState("")

  if (!properties) {
    return (
      <div className="flex h-full w-full flex-col border-l border-zinc-800 bg-[#0A0A0A]">
        <div className="flex h-9 items-center justify-center border-b border-zinc-800 text-xs text-zinc-500">
          No document selected
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-zinc-800 bg-[#0A0A0A]">
      {/* Tabs */}
      <div className="flex h-9 items-center gap-0.5 border-b border-zinc-800 px-2">
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 gap-1 px-2 text-[11px]",
              activeTab === tab.id
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:bg-zinc-800 hover:text-white"
            )}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon className="size-3" />
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="border-b border-zinc-800 p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={activeTab === "links" ? "Search links" : "Search properties"}
            className="h-7 border-zinc-800 bg-zinc-900 pl-7 text-xs text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
      </div>

      {/* Properties List */}
      <ScrollArea className="flex-1">
        {activeTab === "links" ? (
          <LinksTab graph={linkGraph} currentDocId={currentDocId} query={query} onSelectLink={onSelectLink} />
        ) : activeTab === "history" ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
            <History className="size-8 text-zinc-700" />
            <p className="text-[12px] text-zinc-600">История изменений скоро</p>
          </div>
        ) : (
        <div className="px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Properties
          </div>

          <div className="divide-y divide-zinc-800">
            <PropertyRow
              icon={Circle}
              label="Type"
              value={properties.type}
            />
            <PropertyRow
              icon={Info}
              label="Status"
              value={
                <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                  {properties.status}
                </span>
              }
            />
            <PropertyRow
              icon={History}
              label="Revisions"
              value={properties.revisions}
              valueClassName="text-blue-400"
            />
            <PropertyRow
              icon={Link}
              label="Backlinks"
              value={`${properties.backlinks} incoming`}
              valueClassName="text-blue-400"
            />
            <PropertyRow
              icon={Calendar}
              label="Created"
              value={properties.created}
              valueClassName="text-blue-400"
            />
            <PropertyRow
              icon={Clock}
              label="Modified"
              value={properties.modified}
            />
            <PropertyRow
              icon={Hash}
              label="ID"
              value={
                <span className="font-mono text-[10px] text-zinc-500">
                  {properties.id}
                </span>
              }
            />
          </div>

          <Button
            variant="ghost"
            className="mt-3 h-7 w-full justify-start gap-1.5 px-0 text-xs text-zinc-500 hover:text-white"
          >
            <Plus className="size-3.5" />
            Add a property
          </Button>
        </div>
        )}
      </ScrollArea>

    </div>
  )
}
