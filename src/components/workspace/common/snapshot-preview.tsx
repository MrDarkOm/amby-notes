import * as React from "react"
import { Loader2 } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { MotionSpinner } from "@/lib/motion"

import type { SnapshotAssets } from "./snapshot-assets"

const SnapshotReadPreview = React.lazy(() => import("./snapshot-read-preview"))
export type SnapshotMode = "read" | "source"

export function SnapshotModeToggle({
  value,
  onChange,
}: {
  value: SnapshotMode
  onChange: (value: SnapshotMode) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t("snapshotPreview.mode")}
    >
      {(["read", "source"] as const).map((mode) => (
        <Button
          key={mode}
          variant={value === mode ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {t(`snapshotPreview.${mode}`)}
        </Button>
      ))}
    </div>
  )
}

class SnapshotBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function SnapshotPreview({
  content,
  mode,
  markdown = true,
  assets,
}: {
  content: string
  mode: SnapshotMode
  markdown?: boolean
  assets?: SnapshotAssets
}) {
  const { t } = useTranslation()
  const source = (
    <pre className="select-text whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 [overflow-wrap:anywhere]">
      {content}
    </pre>
  )
  if (mode === "source" || !markdown) return source
  return (
    <SnapshotBoundary
      key={content}
      fallback={
        <div>
          <p role="status" className="px-4 pt-4 text-xs text-muted-foreground">
            {t("snapshotPreview.readFailed")}
          </p>
          {source}
        </div>
      }
    >
      <React.Suspense
        fallback={
          <div
            role="status"
            aria-label={t("snapshotPreview.loading")}
            className="flex justify-center p-6"
          >
            <MotionSpinner>
              <Loader2 className="size-4" />
            </MotionSpinner>
          </div>
        }
      >
        <SnapshotReadPreview content={content} assets={assets} />
      </React.Suspense>
    </SnapshotBoundary>
  )
}
