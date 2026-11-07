// @vitest-environment happy-dom
// The notices button of the dock (docs/notices.md, section 5): an ordinary button of the dock with a bell,
// always there, above the settings. It carries the number of conflicts and limit notices, coloured by the
// most serious level (a conflict is a decision, a limit a warning). A click opens the list of conflicts
// beside it, until the notification centre (step 2) takes the place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { ACTION_DEFS, PERSISTENT_ACTION_BUTTONS } from "../panel-definitions"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useVaultStore } from "../use-vault-store"
import { createFakePort, vaultStatus } from "./fake-sync-port"
import { NoticesDock, dockButton } from "./dock-test-harness"
import { SyncNoticesHost } from "./sync-notices-host"
import { useSyncNoticesStore } from "./use-sync-notices-store"

const conflict = (id: string) => ({
  id,
  kind: "bothEdited",
  originalPath: "Заметки/идея.md",
  copyPath: `Заметки/идея.${id}-conflict.md`,
  createdMs: 1_760_000_000_000,
})

const count = () => screen.queryByTestId("notices-dock-count")

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState({ restored: [] })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("where the button stands", () => {
  it("is one of the persistent actions of the dock, between help and settings", () => {
    const def = ACTION_DEFS.find((item) => item.id === "notices")
    expect(def?.kind).toBe("action")
    expect(def?.persistent).toBe(true)
    const order = (id: string) => PERSISTENT_ACTION_BUTTONS.find((b) => b.defId === id)!.order
    expect(PERSISTENT_ACTION_BUTTONS.map((b) => b.defId)).toContain("notices")
    expect(order("notices")).toBeGreaterThan(order("help"))
    expect(order("notices")).toBeLessThan(order("settings"))
  })
})

describe("the button in the dock", () => {
  it("is always there, with a bell, like the other buttons, and no number while nothing is wrong", () => {
    render(<NoticesDock />)
    const button = dockButton()!
    expect(button).not.toBeNull()
    expect(button.getAttribute("data-activity-zone")).toBe("action")
    expect(button.getAttribute("class")).toContain("amby-activity-button")
    expect(button.querySelector("svg.lucide-bell")).not.toBeNull()
    expect(button.getAttribute("aria-label")).toBe("Уведомления")
    expect(button.getAttribute("title")).toBe("Уведомления")
    expect(count()).toBeNull()
  })

  it("counts conflicts and limit notices together and takes the colour of the most serious", () => {
    render(<NoticesDock />)
    act(() =>
      useSyncNoticesStore.setState({
        conflicts: [conflict("aaaaaaaaaaaa"), conflict("bbbbbbbbbbbb")],
        limits: [{ kind: "quotaFull" }],
      }),
    )
    expect(count()!.textContent).toBe("3")
    expect(count()!.getAttribute("data-level")).toBe("decision")
    expect(dockButton()!.getAttribute("aria-label")).toBe("Уведомления: 3")
    expect(count()!.getAttribute("class")).toContain("--notice-decision-")
  })

  it("is a warning when only a limit speaks", () => {
    render(<NoticesDock />)
    act(() =>
      useSyncNoticesStore.setState({ limits: [{ kind: "tooLarge", count: 2, maxBytes: 1 }] }),
    )
    expect(count()!.textContent).toBe("1")
    expect(count()!.getAttribute("data-level")).toBe("warning")
    expect(count()!.getAttribute("class")).toContain("--notice-warning-")
    expect(count()!.getAttribute("class")).not.toMatch(/amber/)
  })

  it("loses the number with the last cause and stays", () => {
    render(<NoticesDock />)
    act(() => useSyncNoticesStore.setState({ conflicts: [conflict("aaaaaaaaaaaa")] }))
    expect(count()).not.toBeNull()
    act(() => useSyncNoticesStore.setState({ conflicts: [] }))
    expect(count()).toBeNull()
    expect(dockButton()).not.toBeNull()
  })
})

describe("what a click does for now", () => {
  async function mountBoth(conflicts = [conflict("aaaaaaaaaaaa")]) {
    const port = createFakePort({ vaultStatus: async () => vaultStatus({ conflicts }) })
    render(
      <>
        <SyncNoticesHost port={port} />
        <NoticesDock />
      </>,
    )
    await screen.findByTestId("notices-dock-count")
  }

  it("opens the list of conflicts, and closes it on the next click", async () => {
    await mountBoth()
    expect(screen.queryByTestId("sync-conflict-popover")).toBeNull()
    fireEvent.click(dockButton()!)
    expect(await screen.findByTestId("sync-conflict-popover")).toBeTruthy()
    expect(screen.getByTestId("sync-conflicts")).toBeTruthy()
    fireEvent.click(dockButton()!)
    await waitFor(() => expect(screen.queryByTestId("sync-conflict-popover")).toBeNull())
  })

  it("opens nothing while there is no conflict", async () => {
    render(
      <>
        <SyncNoticesHost port={createFakePort()} />
        <NoticesDock />
      </>,
    )
    fireEvent.click(dockButton()!)
    expect(screen.queryByTestId("sync-conflict-popover")).toBeNull()
  })

  it("leaves no floating badge in the corner of the window", async () => {
    await mountBoth()
    expect(screen.queryByTestId("sync-conflict-badge")).toBeNull()
  })
})
