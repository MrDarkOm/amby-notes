import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({
  native: false,
  append: vi.fn<(...args: never[]) => Promise<never[]>>(),
  configure: vi.fn<(...args: never[]) => Promise<never>>(),
  flush: vi.fn<(...args: never[]) => Promise<void>>(),
  clear: vi.fn<(...args: never[]) => Promise<void>>(),
  history: vi.fn<(...args: never[]) => Promise<never[]>>(),
  events: vi.fn<(...args: never[]) => Promise<never[]>>(),
  status: vi.fn<(...args: never[]) => Promise<null>>(),
}))
const eventBus = vi.hoisted(() => ({ registered: 0, stopped: 0 }))

vi.mock("./storage", () => ({
  isTauri: () => transport.native,
  appendDebugEvents: (...args: never[]) => transport.append(...args),
  configureDebug: (...args: never[]) => transport.configure(...args),
  flushDebugLogs: (...args: never[]) => transport.flush(...args),
  clearDebugLogs: (...args: never[]) => transport.clear(...args),
  getDebugHistory: (...args: never[]) => transport.history(...args),
  getDebugEvents: (...args: never[]) => transport.events(...args),
  getDebugStatus: (...args: never[]) => transport.status(...args),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => {
    eventBus.registered += 1
    return () => {
      eventBus.stopped += 1
    }
  }),
}))

import {
  clearLogEntries,
  configureLogger,
  getLoggerStatus,
  initBackendLogListener,
  flushLogs,
  logger,
} from "./logger"

describe("logger delivery queue", () => {
  beforeEach(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {})
    transport.native = false
    eventBus.registered = 0
    eventBus.stopped = 0
    transport.append.mockReset()
    transport.configure.mockReset()
    transport.flush.mockReset()
    transport.clear.mockReset()
    transport.history.mockReset()
    transport.events.mockReset()
    transport.status.mockReset()
    clearLogEntries()
    configureLogger({ enabled: false, logLevel: "info", logToFile: false })
  })

  afterEach(() => {
    transport.native = false
    vi.restoreAllMocks()
  })

  it("bounds the native delivery queue and accounts for overwritten queued events", async () => {
    transport.native = true
    transport.configure.mockResolvedValue({
      config: { enabled: true, logLevel: "debug", logToFile: false },
      sessionId: "s",
      buffered: 0,
      dropped: 0,
      pending: 0,
      fileBytes: 0,
      fileError: null,
      watcherRunning: false,
      indexReady: true,
      vaultOpen: false,
    } as never)
    let release!: (events: never[]) => void
    transport.append.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    transport.append.mockImplementation(() => Promise.resolve([]))
    configureLogger({ enabled: true, logLevel: "debug", logToFile: false })
    for (let index = 0; index < 2001; index += 1)
      logger.debug("watcher.event_received", { count: index })
    expect(getLoggerStatus().pending).toBe(2000)
    expect(getLoggerStatus().dropped).toBeGreaterThanOrEqual(1001)
    await vi.waitFor(() => expect(transport.append).toHaveBeenCalledTimes(1))
    release([])
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it("retries failed delivery and exposes a stable transport error", async () => {
    transport.native = true
    transport.configure.mockResolvedValue({} as never)
    transport.append.mockRejectedValue(new Error("private system path"))
    configureLogger({ enabled: true, logLevel: "debug" })
    logger.debug("watcher.refresh_failed", { count: 1 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(transport.append).toHaveBeenCalledTimes(3)
    expect(getLoggerStatus().transportError).toBe("DEBUG_TRANSPORT_FAILED")
    expect(getLoggerStatus().pending).toBe(0)
  })

  it("disposes only its own backend listener registrations across reinitialization", async () => {
    transport.native = true
    const disposeFirst = await initBackendLogListener()
    disposeFirst()
    const disposeSecond = await initBackendLogListener()
    expect(eventBus.registered).toBe(4)
    disposeFirst()
    expect(eventBus.stopped).toBe(2)
    disposeSecond()
    expect(eventBus.stopped).toBe(4)
  })

  it("bounds a native flush when the final writer barrier never resolves", async () => {
    vi.useFakeTimers()
    try {
      transport.native = true
      transport.configure.mockResolvedValue({} as never)
      transport.flush.mockImplementation(() => new Promise(() => {}))
      configureLogger({ enabled: true, logLevel: "debug" })
      const result = expect(flushLogs()).rejects.toThrow("DEBUG_FLUSH_TIMEOUT")
      await vi.advanceTimersByTimeAsync(5000)
      await result
      expect(getLoggerStatus().transportError).toBe("DEBUG_FLUSH_TIMEOUT")
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds native flush when configuration synchronization never resolves", async () => {
    vi.useFakeTimers()
    try {
      transport.native = true
      transport.configure.mockImplementation(() => new Promise(() => {}))
      configureLogger({ enabled: true, logLevel: "debug" })
      const result = expect(flushLogs()).rejects.toThrow("DEBUG_FLUSH_TIMEOUT")
      await vi.advanceTimersByTimeAsync(5000)
      await result
      expect(transport.flush).not.toHaveBeenCalled()
      expect(getLoggerStatus().transportError).toBe("DEBUG_FLUSH_TIMEOUT")
    } finally {
      vi.useRealTimers()
    }
  })
})
