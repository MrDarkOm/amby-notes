import { createServer } from "vite"
import console from "node:console"
import { performance } from "node:perf_hooks"
import process from "node:process"

// Synthetic CPU-only workload. Never opens a vault, enables disk logging or sends IPC.
const server = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
})
try {
  const { logger, configureLogger, clearLogEntries, getLoggerStatus } =
    await server.ssrLoadModule("/src/lib/logger.ts")
  const previousDebug = console.debug
  const samples = []
  console.debug = () => {}
  try {
    for (const enabled of [false, true]) {
      configureLogger({ enabled, logLevel: "debug", logToFile: false })
      for (let round = 0; round < 7; round++) {
        clearLogEntries()
        const start = performance.now()
        for (let index = 0; index < 10_000; index++)
          logger.debug("watcher.event_received", { count: index })
        const elapsedMs = performance.now() - start
        const { buffered, dropped } = getLoggerStatus()
        samples.push({ enabled, round, elapsedMs, buffered, dropped })
        if (buffered !== (enabled ? 1000 : 0) || dropped !== (enabled ? 9000 : 0))
          throw new Error("Synthetic logger workload exceeded its expected bounds")
      }
    }
  } finally {
    console.debug = previousDebug
  }
  const summary = [false, true].map((enabled) => {
    // Discard the first warm-up round; six measured samples are enough to expose cost.
    const measured = samples.filter((sample) => sample.enabled === enabled).slice(1)
    const values = measured.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
    const medianMs = (values[2] + values[3]) / 2
    return {
      enabled,
      events: 10_000,
      measuredRounds: measured.length,
      medianMs,
      microsecondsPerCall: medianMs / 10,
      minMs: values[0],
      maxMs: values.at(-1),
      buffered: measured.at(-1).buffered,
      dropped: measured.at(-1).dropped,
    }
  })
  console.log(
    JSON.stringify(
      {
        scope:
          "Synthetic frontend logger CPU cost; excludes disk, IPC, console output, rendering and real vaults",
        node: process.version,
        summary,
      },
      null,
      2,
    ),
  )
} finally {
  await server.close()
}
