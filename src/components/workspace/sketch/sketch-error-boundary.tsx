import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"

interface SketchErrorBoundaryProps {
  children: React.ReactNode
  onReset?: () => void
}

interface SketchErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

function SketchErrorFallback({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center bg-background text-foreground">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive mb-4">
        <AlertTriangle className="size-6" />
      </div>
      <h3 className="text-base font-medium mb-1">{t("newItem.sketchErrorTitle")}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-4">{t("newItem.sketchErrorDesc")}</p>
      <Button variant="outline" size="sm" onClick={onReset}>
        {t("newItem.sketchRetry")}
      </Button>
    </div>
  )
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
      return <SketchErrorFallback onReset={this.handleRetry} />
    }

    return this.props.children
  }
}
