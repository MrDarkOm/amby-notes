import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import { StartupErrorBoundary } from "./components/startup-error-boundary"
import "./lib/i18n"
import "./themes/app.css"
import { errorType, logger } from "./lib/logger"

window.addEventListener("error", (event) => {
  logger.error("unhandled_window_error", { errorType: errorType(event.error) })
})

window.addEventListener("unhandledrejection", (event) => {
  logger.error("unhandled_promise_rejection", { errorType: errorType(event.reason) })
})

logger.info("frontend_started", { runtime: "browser" })

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StartupErrorBoundary>
      <App />
    </StartupErrorBoundary>
  </React.StrictMode>,
)
