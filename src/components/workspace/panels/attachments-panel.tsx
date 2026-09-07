"use client"

import * as React from "react"
import { FileText, Image as ImageIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { IconValue } from "../icon-value"
import type { PanelRenderProps } from "../panel-registry"
import { PanelHeader, PanelSearch } from "./panel-header"

/** Displays nested notes and local images referenced by the current note. */
export function AttachmentsPanel({
  attachments = [],
  attachmentImages = [],
  onSelectLink,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const [activeTab, setActiveTab] = React.useState("notes")
  const notes = attachments.filter((attachment) => attachment.kind !== "image")
  const images = attachmentImages
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleNotes = notes.filter((attachment) =>
    attachment.name.toLocaleLowerCase().includes(normalizedQuery),
  )
  const visibleImages = images.filter((attachment) =>
    attachment.name.toLocaleLowerCase().includes(normalizedQuery),
  )
  const total = notes.length + images.length

  function renderEmpty(message: string) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
        {message}
      </div>
    )
  }

  function renderItems(items: typeof attachments, emptyMessage: string, imagesOnly = false) {
    if (!items.length) return renderEmpty(emptyMessage)
    return items.map((attachment) => (
      <button
        key={attachment.id}
        type="button"
        disabled={imagesOnly}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent disabled:cursor-default disabled:hover:bg-background/40"
        onClick={() => !imagesOnly && onSelectLink?.(attachment.id)}
      >
        {imagesOnly ? (
          <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <IconValue
            value={
              attachment.icon && !["file", "supernote"].includes(attachment.icon)
                ? attachment.icon
                : undefined
            }
            fallback="📄"
            className="size-4 shrink-0"
          />
        )}
        <span className="min-w-0 truncate">{attachment.name}</span>
      </button>
    ))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={t("attachmentsPanel.title")}
        actions={
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {total}
          </span>
        }
      />
      {total > 0 && (
        <PanelSearch
          value={query}
          onChange={setQuery}
          ariaLabel={t("attachmentsPanel.search")}
          placeholder={t("attachmentsPanel.search")}
        />
      )}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-4 mb-3 grid h-8 w-auto grid-cols-2">
          <TabsTrigger value="notes" className="text-xs">
            <FileText className="size-3.5" />
            {t("attachmentsPanel.notes")}
            <span className="ml-0.5 text-[10px] text-muted-foreground">{notes.length}</span>
          </TabsTrigger>
          <TabsTrigger value="images" className="text-xs">
            <ImageIcon className="size-3.5" />
            {t("attachmentsPanel.images")}
            <span className="ml-0.5 text-[10px] text-muted-foreground">{images.length}</span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="notes" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1.5 px-4 pb-4">
              {renderItems(
                visibleNotes,
                notes.length ? t("attachmentsPanel.noResults") : t("attachmentsPanel.empty"),
              )}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="images" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1.5 px-4 pb-4">
              {renderItems(
                visibleImages,
                images.length ? t("attachmentsPanel.noResults") : t("attachmentsPanel.emptyImages"),
                true,
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
