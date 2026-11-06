// @vitest-environment happy-dom
// The menu of an inactive sync button (docs/sync-plan.md, stage Э4, the interface): one line of the
// reason in the words of the person, one action, and the ordinary refresh of the files.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SyncPortError } from "@/lib/sync/sync-port"
import { syncCodeMessage } from "@/lib/sync/sync-errors"
import {
  syncInactiveText,
  type SyncFixAction,
  type SyncInactiveReason,
  type SyncInactiveReasonId,
} from "./sync-inactive"
import { SyncInactiveMenuContent } from "./sync-inactive-menu"

const ALL: [SyncInactiveReasonId, SyncFixAction | null][] = [
  ["unavailable", null],
  ["signedOut", "settings"],
  ["keysMissing", "settings"],
  ["pendingAccount", "settings"],
  ["keychainLocked", "reconnect"],
  ["vaultOff", "resume"],
  ["vaultNotSetUp", "settings"],
  ["cannotStart", "reconnect"],
  ["waiting", "runNow"],
  ["stopMassIncoming", "settings"],
  ["stopMassOutgoing", "settings"],
  ["stopVaultMissing", "runNow"],
  ["stopVaultEmpty", "settings"],
  ["stopServerReset", "settings"],
  ["stopServerBehind", "settings"],
  ["stopRollback", "settings"],
  ["stopAuthRequired", "settings"],
  ["stopIncompatible", "settings"],
  ["stopped", "settings"],
  ["failed", "refresh"],
]

const make = (
  id: SyncInactiveReasonId,
  action: SyncFixAction | null,
  more: Partial<SyncInactiveReason> = {},
): SyncInactiveReason => ({
  id,
  action,
  code: ["cannotStart", "waiting", "stopped", "failed"].includes(id) ? "network" : null,
  waitSecs: id === "waiting" ? 30 : null,
  count: id.startsWith("stopMass") ? 12 : null,
  ...more,
})

function show(reason: SyncInactiveReason, error: unknown = null) {
  const onFix = vi.fn()
  const onRefresh = vi.fn()
  const onOpenSettings = vi.fn()
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>sync</DropdownMenuTrigger>
      <SyncInactiveMenuContent
        reason={reason}
        busy={false}
        error={error}
        onFix={onFix}
        onRefresh={onRefresh}
        onOpenSettings={onOpenSettings}
      />
    </DropdownMenu>,
  )
  return { onFix, onRefresh, onOpenSettings }
}

afterEach(cleanup)

describe("the reason in words, in every language", () => {
  for (const language of ["ru", "en"]) {
    it(`${language}: every reason and every action has a text of its own`, async () => {
      await i18n.changeLanguage(language)
      const texts = new Set<string>()
      for (const [id, action] of ALL) {
        const text = syncInactiveText(make(id, action), i18n.t)
        expect(text).not.toMatch(/sync\.inactive/)
        expect(text.length).toBeGreaterThan(5)
        texts.add(text)
        if (action) {
          const key = `sync.inactive.action.${id}`
          expect(i18n.exists(key), key).toBe(true)
        }
      }
      expect(texts.size).toBe(ALL.length)
    })
  }

  it("names the code, the pause and the number of files", async () => {
    await i18n.changeLanguage("ru")
    expect(syncInactiveText(make("cannotStart", "reconnect"), i18n.t)).toContain(
      syncCodeMessage("network", i18n.t),
    )
    expect(syncInactiveText(make("waiting", "runNow"), i18n.t)).toContain(
      syncCodeMessage("network", i18n.t),
    )
    expect(syncInactiveText(make("stopMassIncoming", "settings"), i18n.t)).toContain("12")
  })
})

describe("the menu of an inactive sync button", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ru")
  })

  it("shows the reason and runs the action in place", () => {
    const reason = make("vaultOff", "resume")
    const { onFix, onOpenSettings } = show(reason)
    expect(screen.getByTestId("sync-inactive-reason").textContent).toBe(
      syncInactiveText(reason, i18n.t),
    )
    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("sync.inactive.action.vaultOff") }))
    expect(onFix).toHaveBeenCalledWith("resume")
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it("opens the settings for what needs more than one click", () => {
    const { onFix, onOpenSettings } = show(make("stopMassIncoming", "settings"))
    fireEvent.click(
      screen.getByRole("menuitem", { name: i18n.t("sync.inactive.action.stopMassIncoming") }),
    )
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onFix).not.toHaveBeenCalled()
  })

  it("keeps the refresh of the files and the way to the settings", () => {
    const { onRefresh, onOpenSettings } = show(make("waiting", "runNow"))
    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("sync.inactive.refreshFiles") }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("sync.inactive.openSettings") }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it("the browser build offers no sync action", () => {
    show(make("unavailable", null))
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(items).toEqual([i18n.t("sync.inactive.refreshFiles")])
  })

  it("shows the failure of the last action under the reason", () => {
    show(make("vaultOff", "resume"), new SyncPortError("timeout"))
    expect(screen.getByRole("alert").textContent).toBe(syncCodeMessage("timeout", i18n.t))
  })
})
