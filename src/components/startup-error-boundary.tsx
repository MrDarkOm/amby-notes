import { Component, type ErrorInfo, type ReactNode } from "react"
import { startupDiagnosticReport } from "@/lib/diagnostics"
import { errorType, logger } from "@/lib/logger"
import { exportTextFile } from "@/lib/storage"
import i18n from "@/lib/i18n"

interface StartupErrorBoundaryProps {
  children: ReactNode
}

interface StartupErrorBoundaryState {
  error: Error | null
  reportStatus: "idle" | "saved" | "failed"
}

export class StartupErrorBoundary extends Component<
  StartupErrorBoundaryProps,
  StartupErrorBoundaryState
> {
  state: StartupErrorBoundaryState = { error: null, reportStatus: "idle" }

  static getDerivedStateFromError(error: Error): StartupErrorBoundaryState {
    return { error, reportStatus: "idle" }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error("startup_failure", {
      errorType: errorType(error),
      componentStackPresent: Boolean(errorInfo.componentStack),
    })
  }

  private restart = () => {
    window.location.reload()
  }

  private exportDiagnostic = async () => {
    const { error } = this.state
    if (!error) return

    try {
      await exportTextFile(startupDiagnosticReport(error), "amby-diagnostic-report.txt")
      this.setState({ reportStatus: "saved" })
    } catch {
      this.setState({ reportStatus: "failed" })
    }
  }

  render() {
    const { children } = this.props
    const { error, reportStatus } = this.state
    if (!error) return children

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-lg rounded-xl border border-border bg-card p-7 shadow-sm">
          <p className="text-sm font-medium text-destructive">{i18n.t("startup.recover")}</p>
          <h1 className="mt-2 text-2xl font-semibold">{i18n.t("startup.title")}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {i18n.t("startup.description")}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={this.restart}
              type="button"
            >
              {i18n.t("startup.restart")}
            </button>
            <button
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
              onClick={this.exportDiagnostic}
              type="button"
            >
              {i18n.t("startup.export")}
            </button>
          </div>
          {reportStatus === "saved" && (
            <p className="mt-4 text-sm text-muted-foreground">{i18n.t("startup.exported")}</p>
          )}
          {reportStatus === "failed" && (
            <p className="mt-4 text-sm text-destructive">{i18n.t("startup.exportFailed")}</p>
          )}
        </section>
      </main>
    )
  }
}
