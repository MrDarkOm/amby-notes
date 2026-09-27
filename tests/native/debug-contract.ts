import {
  appendDebugEvents,
  clearDebugLogs,
  configureDebug,
  flushDebugLogs,
  getDebugEvents,
  getDebugHistory,
  getDebugStatus,
  settingsRepository,
} from "../../src/lib/storage"
import type { DebugEvent } from "../../src/lib/debug/types"
import type { StorageContractContext } from "../../src/lib/storage/storage-contract"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sample(level: DebugEvent["level"] = "info"): DebugEvent {
  return {
    id: `evt_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    level,
    event: "frontend_started",
    source: "frontend",
    metadata: {
      runtime: "desktop",
      path: "PRIVATE_PATH_SENTINEL",
      title: "PRIVATE_TITLE_SENTINEL",
      content: "PRIVATE_CONTENT_SENTINEL",
      token: "PRIVATE_TOKEN_SENTINEL",
      error: "PRIVATE_ERROR_SENTINEL",
    },
  }
}

export const nativeDebugCases: Array<{
  name: string
  run: (context: StorageContractContext) => Promise<void>
}> = [
  {
    name: "native Debug thresholds, privacy and duplicate acknowledgement",
    async run() {
      await clearDebugLogs()
      await configureDebug({ enabled: true, logLevel: "warn", logToFile: false })
      check((await appendDebugEvents([sample("info")])).length === 0, "Info is filtered")
      const event = sample("warn")
      const first = await appendDebugEvents([event])
      const duplicate = await appendDebugEvents([event])
      check(first.length === 1 && duplicate.length === 1, "Accepted stable IDs are acknowledged")
      const stored = (await getDebugEvents()).filter((entry) => entry.id === event.id)
      check(stored.length === 1, "Retries do not duplicate a native event")
      check(
        !JSON.stringify(stored).includes("PRIVATE_"),
        "Native buffer contains no raw private fields",
      )
      const status = await getDebugStatus()
      check(
        status?.config.logLevel === "warn" && !status.config.logToFile,
        "Applied config is returned",
      )
      const racing = sample("warn")
      await Promise.all([
        appendDebugEvents([racing]),
        appendDebugEvents([racing]),
        clearDebugLogs(),
      ])
      const afterRace = (await getDebugEvents()).filter((entry) => entry.id === racing.id)
      check(afterRace.length <= 1, "Concurrent append and clear never duplicate a stable ID")
      await clearDebugLogs()
      await configureDebug({ enabled: false, logLevel: "debug", logToFile: false })
      check(
        (await appendDebugEvents([sample("debug")])).length === 0,
        "Debug off suppresses verbose events",
      )
    },
  },
  {
    name: "native Debug disk history, flush and clear use the isolated profile",
    async run() {
      await clearDebugLogs()
      try {
        await configureDebug({ enabled: true, logLevel: "info", logToFile: true })
        const event = sample()
        await appendDebugEvents([event])
        await flushDebugLogs()
        const history = await getDebugHistory()
        check(
          history.some((entry) => entry.id === event.id),
          "Flushed event is retained on disk",
        )
        check(!JSON.stringify(history).includes("PRIVATE_"), "Disk history is sanitized")
        await clearDebugLogs()
        check((await getDebugHistory()).length === 0, "Clear removes retained records")
        check((await getDebugEvents()).length === 0, "Clear removes the native ring")
      } finally {
        await configureDebug({ enabled: false, logLevel: "info", logToFile: false })
      }
    },
  },
  {
    name: "native Debug note correlation preserves saved content",
    async run({ adapter, vaultPath }) {
      await clearDebugLogs()
      await configureDebug({ enabled: true, logLevel: "debug", logToFile: false })
      try {
        const note = await adapter.createNote(vaultPath, vaultPath, "Diagnostic fixture")
        const id = note.primaryId!
        const loaded = await adapter.loadActiveVaultData()
        const readOperation = crypto.randomUUID()
        const before = await adapter.readNote(vaultPath, id, readOperation)
        const writeOperation = crypto.randomUUID()
        const content = "Synthetic Unicode body 日本語\nSecond line\n"
        await adapter.writeNote(
          vaultPath,
          id,
          content,
          loaded.generation,
          before.revision,
          "main",
          writeOperation,
        )
        check(
          (await adapter.readNote(vaultPath, id)).content === content,
          "Diagnostic context does not change note body",
        )
        const events = await getDebugEvents()
        for (const [operation, prefix] of [
          [readOperation, "note.read"],
          [writeOperation, "note.write"],
        ]) {
          const chain = events.filter((entry) => entry.operationId === operation)
          check(
            chain.some((entry) => entry.event === `${prefix}.started`),
            "Native start keeps operation ID",
          )
          check(
            chain.some(
              (entry) =>
                entry.event === `${prefix}.succeeded` && typeof entry.durationMs === "number",
            ),
            "Native result includes duration and operation ID",
          )
        }
        check(!JSON.stringify(events).includes(content), "Native diagnostics exclude note content")
        check(
          !JSON.stringify(events).includes("Diagnostic fixture"),
          "Native diagnostics exclude note title",
        )
      } finally {
        await configureDebug({ enabled: false, logLevel: "info", logToFile: false })
      }
    },
  },
  {
    name: "native Debug reports isolated disk failure within bounded flush time",
    async run() {
      await clearDebugLogs()
      // The native harness gives this test a disposable app-data root. Making
      // the configured file path a directory forces a real writer open error
      // without touching the user's profile or introducing a test IPC hook.
      await settingsRepository.writeGlobalRaw("logs/amby-debug.jsonl/blocked", "fixture")
      await configureDebug({ enabled: true, logLevel: "info", logToFile: true })
      try {
        await appendDebugEvents([sample()])
        const started = performance.now()
        let flushFailed = false
        try {
          await flushDebugLogs()
        } catch {
          flushFailed = true
        }
        check(flushFailed, "A real disk writer failure is returned to the caller")
        check(performance.now() - started < 5000, "Failure reporting stays bounded")
        const status = await getDebugStatus()
        check(status?.fileError === "IoError", "Status reports the sanitized writer error")
      } finally {
        await configureDebug({ enabled: false, logLevel: "info", logToFile: false })
      }
    },
  },
]
