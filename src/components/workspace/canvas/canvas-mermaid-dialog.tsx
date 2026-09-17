"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { AlertCircle, AlertTriangle, CheckCircle2, Workflow } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { Edge } from "@xyflow/react"
import type { CanvasFlowNode } from "@/lib/canvas-format"
import {
  parseMermaidFlowchart,
  convertMermaidToCanvas,
  type MermaidParseResult,
} from "./canvas-mermaid"

export interface CanvasMermaidDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInsert: (nodes: CanvasFlowNode[], edges: Edge[]) => void
  flowCenter: { x: number; y: number }
}

const DEFAULT_EXAMPLE = `flowchart TD
  A[Начало] --> B[Обработка]
  B -->|Успех| C[Готово]
  B -->|Ошибка| D[Повтор]
  D --> B`

export function CanvasMermaidDialog({
  open,
  onOpenChange,
  onInsert,
  flowCenter,
}: CanvasMermaidDialogProps) {
  const { t } = useTranslation()
  const [code, setCode] = React.useState(DEFAULT_EXAMPLE)
  const [directionOverride, setDirectionOverride] = React.useState<"auto" | "TD" | "LR">("auto")

  const parsed = React.useMemo<MermaidParseResult>(() => {
    const res = parseMermaidFlowchart(code)
    if (directionOverride !== "auto") {
      return { ...res, direction: directionOverride }
    }
    return res
  }, [code, directionOverride])

  const handleInsert = () => {
    if (!parsed.isValid) return
    const result = convertMermaidToCanvas(parsed, flowCenter)
    onInsert(result.nodes, result.edges)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl border-border bg-background p-6 text-foreground shadow-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Workflow className="size-5 text-primary" />
            <DialogTitle className="text-base font-semibold">
              {t("canvas.mermaidTitle")}
            </DialogTitle>
          </div>
          <p className="text-xs text-muted-foreground">{t("canvas.mermaidDesc")}</p>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("canvas.mermaidDirection")}:</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDirectionOverride("auto")}
                className={cn(
                  "rounded px-2 py-0.5 text-xs",
                  directionOverride === "auto"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {t("canvas.mermaidDirectionAuto")}
              </button>
              <button
                type="button"
                onClick={() => setDirectionOverride("TD")}
                className={cn(
                  "rounded px-2 py-0.5 text-xs",
                  directionOverride === "TD"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {t("canvas.mermaidDirectionTD")}
              </button>
              <button
                type="button"
                onClick={() => setDirectionOverride("LR")}
                className={cn(
                  "rounded px-2 py-0.5 text-xs",
                  directionOverride === "LR"
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {t("canvas.mermaidDirectionLR")}
              </button>
            </div>
          </div>

          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("canvas.mermaidCodePlaceholder")}
            rows={8}
            className="w-full resize-none rounded-md border border-border bg-card p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />

          {/* Diagnostics and preview stats */}
          <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs">
            {parsed.isValid ? (
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                <span>
                  {t("canvas.mermaidSyntaxValid")} ·{" "}
                  {t("canvas.mermaidNodesDetected", { count: parsed.nodes.size })} ·{" "}
                  {t("canvas.mermaidEdgesDetected", { count: parsed.edges.length })}
                </span>
              </div>
            ) : code.trim() ? (
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>
                  {parsed.diagnostics.find((d) => d.severity === "error")?.message ??
                    t("canvas.mermaidEmptyInput")}
                </span>
              </div>
            ) : (
              <span className="text-muted-foreground">{t("canvas.mermaidEmptyInput")}</span>
            )}

            {parsed.diagnostics
              .filter((d) => d.severity === "warning")
              .map((w, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-[11px]"
                >
                  <AlertTriangle className="size-3 shrink-0" />
                  <span>{w.message}</span>
                </div>
              ))}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              {t("canvas.cancel")}
            </button>
            <button
              type="button"
              disabled={!parsed.isValid}
              onClick={handleInsert}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium",
                parsed.isValid
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground cursor-not-allowed opacity-50",
              )}
            >
              {t("canvas.mermaidInsert")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
