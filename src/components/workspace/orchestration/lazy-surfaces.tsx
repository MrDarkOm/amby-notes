import * as React from "react"
import { SurfaceErrorBoundary } from "../surface-error-boundary"
import { MotionSpinner } from "@/lib/motion"

// Lazy-loaded so @xyflow/react and d3-force are excluded from the initial bundle.
// They are fetched from their own chunks the first time the user opens a Canvas
// or Graph tab, then cached by the browser.
export const GraphTabView = React.lazy(() =>
  import("../graph-tab-view").then((m) => ({ default: m.GraphTabView })),
)
export const ProjectPage = React.lazy(() =>
  import("../creative/project-page").then((m) => ({ default: m.ProjectPage })),
)
// The rich-text/source editor pulls in Tiptap, CodeMirror, and emoji-mart.

export const DatabaseWorkspace = React.lazy(() =>
  import("../database/database-workspace").then((m) => ({ default: m.DatabaseWorkspace })),
)

/** Lazy surface whose crash stays inside its own tab instead of replacing the window. */
export function SurfaceSuspense({
  scope,
  resetKey,
  children,
}: {
  scope: string
  resetKey?: string | number
  children: React.ReactNode
}) {
  return (
    <SurfaceErrorBoundary scope={scope} resetKey={resetKey}>
      <React.Suspense fallback={<LazyEditorFallback />}>{children}</React.Suspense>
    </SurfaceErrorBoundary>
  )
}

/** Spinner shown while a lazy chunk (Canvas / Graph) is being fetched. */
export function LazyEditorFallback() {
  return (
    <div className="flex h-full flex-1 items-center justify-center">
      <MotionSpinner>
        <span className="size-5 rounded-full border-2 border-muted-foreground border-t-transparent" />
      </MotionSpinner>
    </div>
  )
}
