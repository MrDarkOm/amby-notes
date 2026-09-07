"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { isTauri } from "@/lib/storage"
import { TiptapEditor } from "../tiptap/TiptapEditor"

export type PdfPageSize = "letter" | "a4" | "legal"
export type PdfMargin = "normal" | "narrow" | "wide"

export interface PdfExportOptions {
  useFilenameHeading: boolean
  pageSize: PdfPageSize
  landscape: boolean
  margin: PdfMargin
  scale: number
}

const DEFAULT_PDF_EXPORT_OPTIONS: PdfExportOptions = {
  useFilenameHeading: true,
  pageSize: "letter",
  landscape: false,
  margin: "normal",
  scale: 100,
}

interface NotePdfExportDialogProps {
  open: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onExport: (options: PdfExportOptions) => void
}

interface NotePdfExportProps {
  title: string
  content: string
  vaultPath?: string
  notePath: string
  options: PdfExportOptions
  onFinished: () => void
}

const NOOP = () => {}
const IMAGE_LOAD_TIMEOUT_MS = 4_000
const BROWSER_PRINT_FALLBACK_MS = 1_000
const NATIVE_PRINT_FALLBACK_MS = 5 * 60_000
const TITLE_RESTORE_DELAY_MS = 1_000

const PDF_PAGE_SIZES: Record<PdfPageSize, string> = {
  letter: "Letter",
  a4: "A4",
  legal: "Legal",
}

const PDF_MARGINS: Record<PdfMargin, string> = {
  normal: "18mm",
  narrow: "10mm",
  wide: "28mm",
}

export function NotePdfExportDialog({
  open,
  title,
  onOpenChange,
  onExport,
}: NotePdfExportDialogProps) {
  const { t } = useTranslation()
  const [options, setOptions] = React.useState<PdfExportOptions>(DEFAULT_PDF_EXPORT_OPTIONS)

  React.useEffect(() => {
    if (open) setOptions(DEFAULT_PDF_EXPORT_OPTIONS)
  }, [open])

  const update = <K extends keyof PdfExportOptions>(key: K, value: PdfExportOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle className="text-xl">{t("docEditor.exportPdfTitle")}</DialogTitle>
          <DialogDescription className="pt-2">
            {t("docEditor.exportPdfDescription", { name: title })}
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border">
          <div className="flex items-center justify-between gap-6 px-6 py-4">
            <span className="text-sm font-medium text-foreground">
              {t("docEditor.exportPdfUseFilenameHeading")}
            </span>
            <Switch
              checked={options.useFilenameHeading}
              onCheckedChange={(value) => update("useFilenameHeading", value)}
              aria-label={t("docEditor.exportPdfUseFilenameHeading")}
            />
          </div>

          <div className="flex items-center justify-between gap-6 px-6 py-4">
            <span className="text-sm font-medium text-foreground">
              {t("docEditor.exportPdfPageSize")}
            </span>
            <Select
              value={options.pageSize}
              onValueChange={(value) => update("pageSize", value as PdfPageSize)}
            >
              <SelectTrigger className="w-32" aria-label={t("docEditor.exportPdfPageSize")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="letter">{t("docEditor.exportPdfPageSize_letter")}</SelectItem>
                <SelectItem value="a4">{t("docEditor.exportPdfPageSize_a4")}</SelectItem>
                <SelectItem value="legal">{t("docEditor.exportPdfPageSize_legal")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-6 px-6 py-4">
            <span className="text-sm font-medium text-foreground">
              {t("docEditor.exportPdfLandscape")}
            </span>
            <Switch
              checked={options.landscape}
              onCheckedChange={(value) => update("landscape", value)}
              aria-label={t("docEditor.exportPdfLandscape")}
            />
          </div>

          <div className="flex items-center justify-between gap-6 px-6 py-4">
            <span className="text-sm font-medium text-foreground">
              {t("docEditor.exportPdfMargin")}
            </span>
            <Select
              value={options.margin}
              onValueChange={(value) => update("margin", value as PdfMargin)}
            >
              <SelectTrigger className="w-32" aria-label={t("docEditor.exportPdfMargin")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">{t("docEditor.exportPdfMargin_normal")}</SelectItem>
                <SelectItem value="narrow">{t("docEditor.exportPdfMargin_narrow")}</SelectItem>
                <SelectItem value="wide">{t("docEditor.exportPdfMargin_wide")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-5 px-6 py-4">
            <span className="shrink-0 text-sm font-medium text-foreground">
              {t("docEditor.exportPdfScale")}
            </span>
            <output className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
              {options.scale}
            </output>
            <input
              type="range"
              min="50"
              max="150"
              step="10"
              value={options.scale}
              onChange={(event) => update("scale", Number(event.target.value))}
              aria-label={t("docEditor.exportPdfScale")}
              className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
            />
          </div>
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4 sm:justify-end">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t("docEditor.exportPdfCancel")}
          </Button>
          <Button type="button" onClick={() => onExport(options)}>
            {t("docEditor.exportPdfSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function waitForImages(root: HTMLElement): Promise<void> {
  const pending = Array.from(root.querySelectorAll("img")).filter((image) => !image.complete)
  if (pending.length === 0) return

  let timeout: number | null = null
  const loaded = Promise.all(
    pending.map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true })
          image.addEventListener("error", () => resolve(), { once: true })
        }),
    ),
  ).then(() => undefined)
  const expired = new Promise<void>((resolve) => {
    timeout = window.setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS)
  })

  await Promise.race([loaded, expired])
  if (timeout !== null) window.clearTimeout(timeout)
}

/** Renders one note into an isolated print surface and opens the system PDF flow. */
export function NotePdfExport({
  title,
  content,
  vaultPath,
  notePath,
  options,
  onFinished,
}: NotePdfExportProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const root = rootRef.current
    let disposed = false
    let finished = false
    let fallbackTimer: number | null = null
    let titleTimer: number | null = null
    const printStyle = document.createElement("style")
    const previousTitle = document.title

    printStyle.dataset.ambyPdfPrintOptions = "true"
    printStyle.textContent = `@media print { @page { size: ${PDF_PAGE_SIZES[options.pageSize]} ${
      options.landscape ? "landscape" : "portrait"
    }; margin: ${PDF_MARGINS[options.margin]}; } }`
    document.head.appendChild(printStyle)

    const restoreTitle = () => {
      if (document.title === title) document.title = previousTitle
    }

    const finish = () => {
      if (disposed || finished) return
      finished = true
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      if (titleTimer !== null) window.clearTimeout(titleTimer)
      window.removeEventListener("afterprint", finish)
      restoreTitle()
      onFinished()
    }

    const print = async () => {
      if (!root) {
        finish()
        return
      }

      await Promise.all([document.fonts?.ready ?? Promise.resolve(), waitForImages(root)])
      await nextPaint()
      if (disposed) return

      for (const activeRoot of document.querySelectorAll(".amby-pdf-export-root--active")) {
        activeRoot.classList.remove("amby-pdf-export-root--active")
      }
      root.classList.add("amby-pdf-export-root--active")
      root.style.setProperty("--amby-pdf-scale", String(options.scale / 100))
      document.body.classList.add("amby-exporting-pdf")
      document.title = title
      window.addEventListener("afterprint", finish)
      try {
        // On macOS Tauri replaces window.print() with an asynchronous native
        // command. Awaiting it makes capability and platform failures visible.
        await Promise.resolve(window.print())
        if (disposed || finished) return
        titleTimer = window.setTimeout(restoreTitle, TITLE_RESTORE_DELAY_MS)
        // `afterprint` is the normal cleanup path. The fallback covers webviews
        // that expose print() but never publish the lifecycle event.
        fallbackTimer = window.setTimeout(
          finish,
          isTauri() ? NATIVE_PRINT_FALLBACK_MS : BROWSER_PRINT_FALLBACK_MS,
        )
      } catch (error) {
        console.error("Failed to open the PDF print dialog:", error)
        finish()
      }
    }

    void print()
    return () => {
      disposed = true
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      if (titleTimer !== null) window.clearTimeout(titleTimer)
      window.removeEventListener("afterprint", finish)
      printStyle.remove()
      root?.classList.remove("amby-pdf-export-root--active")
      if (!document.querySelector(".amby-pdf-export-root--active")) {
        document.body.classList.remove("amby-exporting-pdf")
      }
      restoreTitle()
    }
  }, [onFinished, options, title])

  return createPortal(
    <article ref={rootRef} className="amby-pdf-export-root" aria-hidden="true">
      {options.useFilenameHeading && <h1 className="amby-pdf-export-title">{title}</h1>}
      <TiptapEditor
        value={content}
        onChange={NOOP}
        editable={false}
        isReadOnly
        vaultPath={vaultPath}
        notePath={notePath}
      />
    </article>,
    document.body,
  )
}
