import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { errorType, logger } from "@/lib/logger"

interface SurfaceErrorBoundaryProps {
  /** Which area this guards; recorded with the error so logs say what crashed. */
  scope: string
  children: React.ReactNode
  /** The fallback clears itself when this changes (for example, another file shown). */
  resetKey?: string | number
}

interface SurfaceErrorBoundaryState {
  hasError: boolean
}

function SurfaceErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="amby-surface-error">
      <div className="amby-surface-error__icon">
        <AlertTriangle className="size-6" />
      </div>
      <h3 className="text-base font-medium">{t("surfaceError.title")}</h3>
      <p className="amby-surface-error__desc">{t("surfaceError.desc")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t("surfaceError.retry")}
      </Button>
    </div>
  )
}

/**
 * Keeps one crashed tab or panel from replacing the whole window. The
 * children are unmounted while the fallback shows, so retrying remounts them.
 */
export class SurfaceErrorBoundary extends React.Component<
  SurfaceErrorBoundaryProps,
  SurfaceErrorBoundaryState
> {
  override state: SurfaceErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): SurfaceErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error("surface_render_error", {
      scope: this.props.scope,
      errorType: errorType(error),
      componentStackPresent: Boolean(errorInfo.componentStack),
    })
  }

  override componentDidUpdate(previous: SurfaceErrorBoundaryProps) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  private retry = () => {
    this.setState({ hasError: false })
  }

  override render() {
    if (this.state.hasError) return <SurfaceErrorFallback onRetry={this.retry} />
    return this.props.children
  }
}
