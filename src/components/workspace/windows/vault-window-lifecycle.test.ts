import { describe, expect, it } from "vitest"
import {
  activationMatchesCurrentVault,
  ownsWorkspacePersistence,
  ownsVaultWatcher,
  planVaultStartup,
} from "./vault-window-lifecycle"

describe("vault window lifecycle", () => {
  it("lets only the desktop main window own the process-wide watcher", () => {
    expect(ownsVaultWatcher(true, "main")).toBe(true)
    expect(ownsVaultWatcher(true, "note-01ABC")).toBe(false)
    expect(ownsVaultWatcher(false, "main")).toBe(false)
  })

  it("prevents detached windows from overwriting main-window session metadata", () => {
    expect(ownsWorkspacePersistence(true, "main")).toBe(true)
    expect(ownsWorkspacePersistence(true, "note-01ABC")).toBe(false)
    expect(ownsWorkspacePersistence(false, "main")).toBe(true)
  })

  it("attaches detached windows to the active backend regardless of reopen preference", () => {
    expect(
      planVaultStartup({
        isDesktop: true,
        windowLabel: "note-01ABC",
        lastOpened: "/stale/workspace",
        reopenLastVault: false,
      }),
    ).toEqual({ kind: "attach-active" })
  })

  it("activates the saved vault only from the main desktop window", () => {
    expect(
      planVaultStartup({
        isDesktop: true,
        windowLabel: "main",
        lastOpened: "/vault/current",
        reopenLastVault: true,
      }),
    ).toEqual({ kind: "activate", path: "/vault/current" })
    expect(
      planVaultStartup({
        isDesktop: true,
        windowLabel: "main",
        lastOpened: "/vault/current",
        reopenLastVault: false,
      }),
    ).toEqual({ kind: "idle" })
  })

  it("keeps same-path activation events so their generation can be updated", () => {
    const payload = { path: "/vault/current", generation: 9 }
    expect(activationMatchesCurrentVault(payload, "/vault/current")).toBe(true)
    expect(activationMatchesCurrentVault(payload, "/vault/other")).toBe(false)
  })
})
