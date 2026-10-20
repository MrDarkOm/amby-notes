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

  it("is not there while the module is off", () => {
    renderDialog(["files", "tags"])
    expect(screen.queryByRole("tab", { name: /Синхронизация/ })).toBeNull()
  })

  it("appears when the module is on and opens the connect screen", async () => {
    renderDialog(["files", "sync"])
    const tab = screen.getByRole("tab", { name: /Синхронизация/ })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    expect(await screen.findByLabelText("Адрес сервера")).toBeTruthy()
  })

  it("is found by the search of the settings", async () => {
    renderDialog(["files", "sync"])
    fireEvent.change(screen.getByPlaceholderText(/Поиск/), { target: { value: "синхрон" } })
    expect((await screen.findAllByText(/Синхронизация/)).length).toBeGreaterThan(0)
  })
})
