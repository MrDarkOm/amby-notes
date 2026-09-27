// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "@/lib/i18n"
import { clearLogEntries } from "@/lib/logger"
import { StartupErrorBoundary } from "./startup-error-boundary"

const exports = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  exportTextFile: exports.save,
}))

function FailedStartup() {
  throw new Error("PRIVATE_STARTUP_BODY /private/notes/secret.md sk-private-token")
  return null
}

describe("startup diagnostic recovery screen", () => {
  beforeEach(() => {
    clearLogEntries()
    exports.save.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function renderFailure() {
    return render(
      <StartupErrorBoundary>
        <FailedStartup />
      </StartupErrorBoundary>,
    )
  }

  it("offers a safe export when the workspace cannot mount", async () => {
    exports.save.mockResolvedValue("/test/report.json")
    const screen = renderFailure()
    expect(screen.getByRole("heading", { name: i18n.t("startup.title") })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.export") }))
    await waitFor(() => expect(screen.getByText(i18n.t("startup.exported"))).toBeTruthy())
    const [text, filename] = exports.save.mock.calls[0]
    expect(filename).toBe("amby-diagnostic-report.json")
    const report = JSON.parse(text)
    expect(report.schemaVersion).toBe(1)
    expect(report.events.at(-1).event).toBe("startup.failure")
    expect(text).not.toContain("PRIVATE_STARTUP_BODY")
    expect(text).not.toContain("secret.md")
    expect(text).not.toContain("sk-private-token")
  })

  it("does not announce success when the native save dialog is cancelled", async () => {
    exports.save.mockResolvedValue(null)
    const screen = renderFailure()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.export") }))
    await waitFor(() => expect(exports.save).toHaveBeenCalledOnce())
    expect(screen.queryByText(i18n.t("startup.exported"))).toBeNull()
    expect(screen.queryByText(i18n.t("startup.exportFailed"))).toBeNull()
  })

  it("shows an export failure and allows a successful retry", async () => {
    exports.save.mockRejectedValueOnce(new Error("PRIVATE_DISK_ERROR"))
    exports.save.mockResolvedValueOnce("/test/report.json")
    const screen = renderFailure()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.export") }))
    await waitFor(() => expect(screen.getByText(i18n.t("startup.exportFailed"))).toBeTruthy())
    expect(screen.queryByText("PRIVATE_DISK_ERROR")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: i18n.t("startup.export") }))
    await waitFor(() => expect(screen.getByText(i18n.t("startup.exported"))).toBeTruthy())
    expect(screen.queryByText(i18n.t("startup.exportFailed"))).toBeNull()
  })
})
