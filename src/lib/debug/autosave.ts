import { logger } from "@/lib/logger"
import type { AutosaveDiagnostic } from "@/components/workspace/autosave/autosave-coordinator"

export function recordAutosaveDiagnostic(event: AutosaveDiagnostic): void {
  const context = { operationId: event.operationId, subsystem: "autosave" }
  const metadata = { documentId: event.key.documentId, kind: event.key.kind }
  if (event.phase === "started") {
    logger.debug("autosave.queue", metadata, { ...context, durationMs: event.queueWaitMs })
    logger.info("autosave.save.started", metadata, context)
  } else {
    const level = event.phase === "failed" ? "error" : "info"
    logger[level](`autosave.save.${event.phase}`, metadata, {
      ...context,
      durationMs: event.durationMs,
    })
  }
}
