"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, Image as ImageIcon } from "lucide-react"
import { motion } from "motion/react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toAssetUrl } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import type { AttachmentItem, PanelRenderProps } from "../panel-registry"
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
  const [imageUrls, setImageUrls] = React.useState<Record<string, string>>({})
  const [failedImageIds, setFailedImageIds] = React.useState<Set<string>>(() => new Set())
  const [previewImage, setPreviewImage] = React.useState<AttachmentItem | null>(null)
  const previewIndex = previewImage
    ? visibleImages.findIndex((image) => image.id === previewImage.id)
    : -1

  React.useEffect(() => {
    let cancelled = false
    setImageUrls({})
    setFailedImageIds(new Set())
    if (!images.length) return
    void Promise.all(
      images.map(async (image) => {
        if (!image.path) return [image.id, ""] as const
        try {
          return [image.id, await toAssetUrl(image.path)] as const
        } catch {
          return [image.id, ""] as const
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      setImageUrls(Object.fromEntries(entries.filter(([, url]) => url)))
    })
    return () => {
      cancelled = true
    }
  }, [images])

  React.useEffect(() => {
    if (previewImage && !images.some((image) => image.id === previewImage.id)) {
      setPreviewImage(null)
    }
  }, [images, previewImage])

  React.useEffect(() => {
    if (!previewImage || previewIndex < 0 || visibleImages.length < 2) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      event.preventDefault()
      const direction = event.key === "ArrowLeft" ? -1 : 1
      const nextIndex = (previewIndex + direction + visibleImages.length) % visibleImages.length
      setPreviewImage(visibleImages[nextIndex])
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [previewImage, previewIndex, visibleImages])

  function handleImageError(id: string) {
    setFailedImageIds((current) => {
      if (current.has(id)) return current
      const next = new Set(current)
      next.add(id)
      return next
    })
  }

  function renderEmpty(message: string) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
        {message}
      </div>
    )
  }

  function renderItems(items: AttachmentItem[], emptyMessage: string, imagesOnly = false) {
    if (!items.length) return renderEmpty(emptyMessage)
    return items.map((attachment) => (
      <button
        key={attachment.id}
        type="button"
        aria-label={imagesOnly ? attachment.name : undefined}
        title={imagesOnly ? attachment.name : undefined}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent",
          imagesOnly && "justify-center",
        )}
        onClick={() => {
          if (imagesOnly) setPreviewImage(attachment)
          else onSelectLink?.(attachment.id)
        }}
      >
        {imagesOnly ? (
          <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40">
            {imageUrls[attachment.id] && !failedImageIds.has(attachment.id) ? (
              <img
                src={imageUrls[attachment.id]}
                alt=""
                className="size-full object-cover"
                draggable={false}
                loading="lazy"
                onError={() => handleImageError(attachment.id)}
              />
            ) : (
              <ImageIcon className="size-5 text-muted-foreground" />
            )}
          </span>
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
        {!imagesOnly && <span className="min-w-0 truncate">{attachment.name}</span>}
      </button>
    ))
  }

  const previewUrl = previewImage ? imageUrls[previewImage.id] : undefined
  const previewFailed = previewImage ? failedImageIds.has(previewImage.id) : false

  function movePreview(direction: -1 | 1) {
    if (previewIndex < 0 || visibleImages.length < 2) return
    const nextIndex = (previewIndex + direction + visibleImages.length) % visibleImages.length
    setPreviewImage(visibleImages[nextIndex])
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
        <TabsList className="mx-4 mb-3 grid h-8 w-[calc(100%-2rem)] grid-cols-2">
          <TabsTrigger
            value="notes"
            title={t("attachmentsPanel.notes")}
            aria-label={t("attachmentsPanel.notes")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("attachmentsPanel.notes")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="images"
            title={t("attachmentsPanel.images")}
            aria-label={t("attachmentsPanel.images")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("attachmentsPanel.images")}</span>
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
      <Dialog
        open={previewImage !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewImage(null)
        }}
      >
        <DialogContent className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-3 border-border bg-background/95 p-3 shadow-2xl backdrop-blur">
          <DialogTitle className="min-w-0 truncate px-1 pr-10 text-sm font-medium">
            {previewImage?.name ?? t("attachmentsPanel.preview")}
          </DialogTitle>
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-muted/30 p-2">
            {previewUrl && previewImage && !previewFailed ? (
              <motion.img
                key={previewImage.id}
                src={previewUrl}
                alt={previewImage.name}
                className="max-h-full max-w-full object-contain"
                draggable={false}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.18 }}
                onError={() => handleImageError(previewImage.id)}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <ImageIcon className="size-8" />
                <span>{t("attachmentsPanel.previewUnavailable")}</span>
              </div>
            )}
            {visibleImages.length > 1 && (
              <>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute left-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-md"
                  aria-label={t("attachmentsPanel.previous")}
                  onClick={() => movePreview(-1)}
                >
                  <ChevronLeft className="size-5" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute right-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-md"
                  aria-label={t("attachmentsPanel.next")}
                  onClick={() => movePreview(1)}
                >
                  <ChevronRight className="size-5" />
                </Button>
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-end gap-3 px-1">
            {visibleImages.length > 1 && previewIndex >= 0 && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {previewIndex + 1} / {visibleImages.length}
              </span>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
