// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import i18n from "@/lib/i18n"
import { SettingsDialog } from "@/components/workspace/settings-dialog"
import { createFakePort } from "@/components/workspace/sync/fake-sync-port"

const port = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("@/lib/sync/sync-port", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/sync-port")>()
  return { ...actual, resolveSyncPort: () => port.current }
})

function renderDialog(activeModules: string[]) {
  return render(
    <SettingsDialog
      open={true}
      onOpenChange={() => {}}
      vault={null}
      activeModules={activeModules}
      onModuleEnabledChange={() => {}}
    />,
  )
}

describe("the Synchronization tab of the settings", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
    port.current = createFakePort()
  })
  afterEach(cleanup)

  it("is always there, whatever modules are on", () => {
    renderDialog(["files", "tags"])
    expect(screen.getByRole("tab", { name: /Синхронизация/ })).toBeTruthy()
  })

  it("opens the connect screen and ignores a retired sync module id", async () => {
    renderDialog(["files", "sync"])
    const tab = screen.getByRole("tab", { name: /Синхронизация/ })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    expect(await screen.findByRole("radio", { name: /Сервер Amby/ })).toBeTruthy()
  })

  it("is found by the search of the settings", async () => {
    renderDialog(["files"])
    fireEvent.change(screen.getByPlaceholderText("Найти настройку…"), {
      target: { value: "синхрон" },
    })
    expect((await screen.findAllByText(/Синхронизация/)).length).toBeGreaterThan(0)
  })
})
