import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearLogEntries,
  configureLogger,
  formatLogsForExport,
  getLogEntries,
  getLoggerConfig,
  getLoggerStatus,
  ingestLogLine,
  logger,
  parseLogLine,
  subscribeToLogs,
  type LogEntry,
} from "./logger"

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    clearLogEntries()
    configureLogger({ enabled: false, logLevel: "info", logToFile: false })
  })

  it("buffers log entries in memory with timestamps and levels", () => {
    logger.info("frontend_started", { version: "1.0" })
    logger.warn("watcher.refresh_failed", { key: "abc" })
    logger.error("storage.read_file", { status: 500 })

    const entries = getLogEntries()
    expect(entries).toHaveLength(3)

    expect(entries[0].event).toBe("frontend_started")
    expect(entries[0].level).toBe("info")
    expect(entries[0].metadata?.version).toBeUndefined()

    expect(entries[1].event).toBe("watcher.refresh_failed")
    expect(entries[1].level).toBe("warn")

    expect(entries[2].event).toBe("storage.read_file")
    expect(entries[2].level).toBe("error")
  })

  it("supports subscription to new log entries", () => {
    const received: LogEntry[] = []
    const unsubscribe = subscribeToLogs((entry) => received.push(entry))

    logger.info("frontend_started")
    logger.error("storage.read_file")

    expect(received).toHaveLength(2)
    expect(received[0].event).toBe("frontend_started")
    expect(received[1].event).toBe("storage.read_file")

    unsubscribe()
    logger.info("watcher.event_received")
    expect(received).toHaveLength(2)
  })

  it("clears entries when clearLogEntries is called", () => {
    logger.info("frontend_started")
    logger.info("watcher.event_received")
    expect(getLogEntries()).toHaveLength(2)

    clearLogEntries()
    expect(getLogEntries()).toHaveLength(0)
  })

  it("advances the clear revision for subscribers in other windows", () => {
    const before = getLoggerStatus().clearRevision
    clearLogEntries()
    expect(getLoggerStatus().clearRevision).toBe(before + 1)
  })

  it("formats only privacy-filtered fields for export", () => {
    logger.info("frontend_started", { user: "tester" })
    const exported = formatLogsForExport()
    expect(exported).toContain('"event":"frontend_started"')
    expect(exported).not.toContain("tester")
  })

  it("updates logger configuration dynamically", () => {
    configureLogger({ enabled: true, logLevel: "debug", logToFile: true })
    const cfg = getLoggerConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.logLevel).toBe("debug")
    expect(cfg.logToFile).toBe(true)
  })

  it("applies the disabled-mode minimum threshold before buffering", () => {
    configureLogger({ enabled: false, logLevel: "debug" })
    logger.debug("frontend_started")
    logger.info("frontend_started")
    expect(getLogEntries().map((entry) => entry.event)).toEqual(["frontend_started"])
    configureLogger({ enabled: false, logLevel: "warn" })
    logger.info("frontend_started")
    logger.warn("watcher.refresh_failed")
    expect(getLogEntries().map((entry) => entry.event)).toEqual([
      "frontend_started",
      "watcher.refresh_failed",
    ])
  })

  it("deduplicates structured events using their stable event ids", () => {
    const id = "evt_550e8400-e29b-41d4-a716-446655440000"
    const event = {
      id,
      timestamp: "2026-09-27T08:00:00.000Z",
      level: "info" as const,
      event: "index.refresh",
      source: "backend" as const,
      metadata: { count: 2 },
    }
    logger.record(event)
    logger.record(event)
    expect(getLogEntries().filter((entry) => entry.id === id)).toHaveLength(1)
  })

  it("records external log entries via logger.record", () => {
    logger.record({
      level: "warn",
      event: "watcher.refresh_failed",
      source: "backend",
      metadata: { durationMs: 450 },
    })

    const entries = getLogEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].source).toBe("backend")
    expect(entries[0].event).toBe("watcher.refresh_failed")
  })

  it("parses and ingests frontend and backend log lines", () => {
    // Frontend line
    const feLine =
      '[2026-09-27T08:35:49.897Z] [INFO] [frontend] frontend_started {"runtime":"desktop"}'
    const parsedFe = parseLogLine(feLine)
    expect(parsedFe).not.toBeNull()
    expect(parsedFe?.event).toBe("frontend_started")

    const feEntry = ingestLogLine(feLine)
    expect(feEntry).not.toBeNull()
    expect(feEntry?.source).toBe("frontend")
    expect(feEntry?.event).toBe("frontend_started")
    expect(feEntry?.metadata?.runtime).toBe("desktop")

    // Backend tracing line
    const beLine =
      '2026-09-27T08:35:49.123456Z  INFO amby_notes::commands::database: event="create_database_row" database_id="db1" title="New Row"'
    const parsedBe = parseLogLine(beLine)
    expect(parsedBe).not.toBeNull()
    expect(parsedBe?.event).toBe("create_database_row")

    const beEntry = ingestLogLine(beLine)
    expect(beEntry).not.toBeNull()
    expect(beEntry?.source).toBe("backend")
    expect(beEntry?.event).toBe("create_database_row")
    expect(beEntry?.metadata?.database_id).toMatch(/^id_/)
    expect(beEntry?.metadata?.title).toBeUndefined()

    // Deduplication check: ingesting the exact same line again returns null
    const duplicate = ingestLogLine(beLine)
    expect(duplicate).toBeNull()

    const all = getLogEntries()
    expect(all).toHaveLength(2)
  })

  it("strips ANSI escape codes from backend tracing lines", () => {
    const ansiLine =
      '\u001b[2m2026-09-27T08:44:45.425499Z\u001b[0m \u001b[32m INFO\u001b[0m \u001b[2mamby_notes_lib::commands::database\u001b[0m\u001b[2m:\u001b[0m \u001b[3mevent\u001b[0m\u001b[2m=\u001b[0m"apply_database_value_batch" \u001b[3mdatabase_id\u001b[0m\u001b[2m=\u001b[0m01M2NKE \u001b[3mupdates_count\u001b[0m\u001b[2m=\u001b[0m1'
    const entry = ingestLogLine(ansiLine)
    expect(entry).not.toBeNull()
    expect(entry?.event).toBe("apply_database_value_batch")
    expect(entry?.metadata?.database_id).toMatch(/^id_/)
    expect(entry?.metadata?.updates_count).toBe(1)
  })

  it("handles multiline log chunks in ingestLogLine", () => {
    const chunk = [
      '[2026-09-27T08:00:00.000Z] [INFO] [frontend] frontend_started {"a":"1"}',
      '[2026-09-27T08:00:01.000Z] [INFO] [frontend] watcher.event_received {"b":"2"}',
    ].join("\n")

    const last = ingestLogLine(chunk)
    expect(last?.event).toBe("watcher.event_received")

    const entries = getLogEntries()
    expect(entries.some((e) => e.event === "frontend_started")).toBe(true)
    expect(entries.some((e) => e.event === "watcher.event_received")).toBe(true)
  })

  it("keeps the memory buffer capped under sustained traffic", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    configureLogger({ enabled: true, logLevel: "debug", logToFile: false })
    for (let index = 0; index < 10_000; index += 1) {
      logger.info("watcher.event_received", { count: index })
    }
    expect(getLoggerStatus().buffered).toBe(1000)
    expect(getLoggerStatus().dropped).toBe(9000)
  })
})
