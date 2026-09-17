import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"
import i18n from "@/lib/i18n"

interface SketchErrorBoundaryProps {
  children: React.ReactNode
  onReset?: () => void
}

interface SketchErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class SketchErrorBoundary extends React.Component<
  SketchErrorBoundaryProps,
  SketchErrorBoundaryState
> {
  override state: SketchErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): SketchErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error("sketch_render_error", {
      errorType: errorType(error),
      componentStackPresent: Boolean(errorInfo.componentStack),
    })
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null })
    this.props.onReset?.()
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center bg-background text-foreground">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-4">
            <AlertTriangle className="size-6" />
          </div>
          <h3 className="text-base font-medium mb-1">{i18n.t("newNote.sketchErrorTitle")}</h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            {i18n.t("newNote.sketchErrorDesc")}
          </p>
          <Button variant="outline" size="sm" onClick={this.handleRetry}>
            {i18n.t("newNote.sketchRetry")}
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
