"use client"

import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  FileAudio,
  FileText,
  FileVideo,
  Image as ImageIcon,
} from "lucide-react"
import { motion } from "motion/react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { openAttachment, toAssetUrl } from "@/lib/storage"
import { cn } from "@/lib/utils"
import { IconValue } from "../icon-value"
import { EmojiGlyph } from "@/components/ui/emoji-glyph"
import type { AttachmentItem, PanelRenderProps } from "../panel-registry"
import { useDocStore } from "../use-doc-store"
import { PanelHeader, PanelSearch } from "./panel-header"

const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/iu
const AUDIO_FILE_RE = /\.(?:mp3|wav|ogg|m4a|flac|aac|opus)$/iu
const VIDEO_FILE_RE = /\.(?:mp4|webm|mov|m4v|mkv|ogv)$/iu
const PDF_FILE_RE = /\.pdf$/iu

function isImageAttachment(item: AttachmentItem): boolean {
  return IMAGE_FILE_RE.test(item.name) || Boolean(item.path && IMAGE_FILE_RE.test(item.path))
}

function FileAttachmentGlyph({ name }: { name: string }) {
  if (PDF_FILE_RE.test(name)) return <FileText className="size-4 text-muted-foreground" />
  if (AUDIO_FILE_RE.test(name)) return <FileAudio className="size-4 text-muted-foreground" />
  if (VIDEO_FILE_RE.test(name)) return <FileVideo className="size-4 text-muted-foreground" />
  return <FileIcon className="size-4 text-muted-foreground" />
}

/** Displays nested notes and local files referenced by the current note. */
export function AttachmentsPanel({
  attachments = [],
  attachmentImages = [],
  currentDocId,
  onSelectLink,
}: PanelRenderProps) {
  const { t } = useTranslation()
  const currentDocPath = useDocStore((state) =>
    currentDocId ? state.openDocs[currentDocId]?.path : undefined,
  )
  const [query, setQuery] = React.useState("")
  const [activeTab, setActiveTab] = React.useState("notes")
  const notes = attachments.filter((attachment) => attachment.kind !== "image")
  const files = attachmentImages
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleNotes = notes.filter((attachment) =>
    attachment.name.toLocaleLowerCase().includes(normalizedQuery),
  )
  const visibleFiles = files.filter((attachment) =>
    attachment.name.toLocaleLowerCase().includes(normalizedQuery),
  )
  const visibleImages = visibleFiles.filter(isImageAttachment)
  const total = notes.length + files.length
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
    const imageFiles = files.filter(isImageAttachment)
    if (!imageFiles.length) return
    void Promise.all(
      imageFiles.map(async (image) => {
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
  }, [files])

  React.useEffect(() => {
    if (previewImage && !files.some((file) => file.id === previewImage.id)) {
      setPreviewImage(null)
    }
  }, [files, previewImage])

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

  function renderItems(items: AttachmentItem[], emptyMessage: string, filesMode = false) {
    if (!items.length) return renderEmpty(emptyMessage)
    return items.map((attachment) => {
      const isImage = filesMode && isImageAttachment(attachment)
      return (
        <button
          key={attachment.id}
          type="button"
          title={attachment.name}
          className={cn(
            "flex w-full min-w-0 items-center gap-2.5 rounded-md border border-border bg-background/40 px-2.5 py-2 text-left text-xs text-foreground hover:bg-accent",
          )}
          onClick={() => {
            if (!filesMode) {
              onSelectLink?.(attachment.id)
            } else if (isImage) {
              setPreviewImage(attachment)
            } else if (currentDocPath && attachment.path) {
              void openAttachment(currentDocPath, attachment.path).catch(() => {})
            }
          }}
        >
          {filesMode ? (
            isImage ? (
              <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted/40">
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
                  <ImageIcon className="size-4 text-muted-foreground" />
                )}
              </span>
            ) : (
              <span className="flex size-10 shrink-0 items-center justify-center rounded border border-border bg-muted/40">
                <FileAttachmentGlyph name={attachment.name} />
              </span>
            )
          ) : (
            <IconValue
              value={
                attachment.icon &&
                !["file", "supernote", "supercanvas", "supersketch"].includes(attachment.icon)
                  ? attachment.icon
                  : undefined
              }
              fallback={<EmojiGlyph value="📄" />}
              className="mt-0.5 size-4 shrink-0"
            />
          )}
          <span className="min-w-0 flex-1 whitespace-normal break-words leading-4 [overflow-wrap:anywhere]">
            {attachment.name}
          </span>
        </button>
      )
    })
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
      <PanelHeader title={t("attachmentsPanel.title")} count={total} />
      <PanelSearch
        value={query}
        onChange={setQuery}
        ariaLabel={t("attachmentsPanel.search")}
        placeholder={t("attachmentsPanel.search")}
      />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
        <TabsList className="mx-4 mb-3 grid h-8 w-auto grid-cols-2">
          <TabsTrigger
            value="notes"
            title={t("attachmentsPanel.notes")}
            aria-label={t("attachmentsPanel.notes")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("attachmentsPanel.notes")}</span>
          </TabsTrigger>
          <TabsTrigger
            value="files"
            title={t("attachmentsPanel.files")}
            aria-label={t("attachmentsPanel.files")}
            className="min-w-0 px-2 text-[11px] leading-none"
          >
            <span className="truncate">{t("attachmentsPanel.files")}</span>
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
        <TabsContent value="files" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="space-y-1.5 px-4 pb-4">
              {renderItems(
                visibleFiles,
                files.length ? t("attachmentsPanel.noResults") : t("attachmentsPanel.emptyFiles"),
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
          <DialogTitle className="min-w-0 whitespace-normal break-words px-1 pr-10 text-sm font-medium leading-5 [overflow-wrap:anywhere]">
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
