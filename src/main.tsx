import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { StartupErrorBoundary } from "./components/startup-error-boundary"
import "./lib/i18n"
import "./themes/app.css"
import { errorType, initBackendLogListener, logger, syncBackendLogs } from "./lib/logger"
import { isTauri } from "./lib/storage"

window.addEventListener("error", (event) => {
  logger.error("unhandled_window_error", { errorType: errorType(event.error) })
})

window.addEventListener("unhandledrejection", (event) => {
  logger.error("unhandled_promise_rejection", { errorType: errorType(event.reason) })
})

window.addEventListener("contextmenu", (event) => {
  event.preventDefault()
})

logger.info("frontend_started", { runtime: isTauri() ? "desktop" : "browser" })
void initBackendLogListener().then(() => syncBackendLogs())
void import("./lib/debug/health")
  .then(({ initDebugHealthBridge }) => initDebugHealthBridge())
  .catch(() => {
    // A diagnostics bridge is optional and must not prevent startup.
  })

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StartupErrorBoundary>
      <App />
    </StartupErrorBoundary>
  </React.StrictMode>,
)
