// @vitest-environment happy-dom
// Notices of the application that have no other place (docs/notices.md, section 3, rule 4): they live in the
// notification centre in the section of their level. Only danger and a decision are announced by a toast; a
// warning waits quietly, and the number on the bell counts it. The text comes from the locale, never from an error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { deriveCentre, centreCounter, type CentreInput } from "./centre-entries"
import { NoticesStack } from "./notices-stack"
import { useAppNoticesStore, type AppNotice } from "./use-app-notices-store"
import { useNoticeToastStore } from "./use-notice-toasts-store"
import { useNoticesStackStore } from "./use-notices-stack-store"
import { useNoticesCentreStore } from "./use-notices-centre-store"
import { createFakePort } from "../sync/fake-sync-port"

vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  readGlobalRaw: vi.fn(async () => null),
  writeGlobalRaw: vi.fn(async () => {}),
}))

const vaultFailed: AppNotice = {
  id: "vault-open-failed",
  level: "decision",
  titleKey: "notices.app.vaultOpenFailed.title",
  lineKey: "notices.app.vaultOpenFailed.line",
}
const recovery: AppNotice = {
  id: "recovery-notices",
  level: "warning",
  titleKey: "notices.app.recoveryNotices.title",
  lineKey: "notices.app.recoveryNotices.line",
  params: { count: 2 },
}

const emptyInput: CentreInput = {
  vault: "/vault",
  conflicts: [],
  stop: null,
  limits: [],
  itemErrors: 0,
  openDocs: {},
  tabbedDocIds: [],
  externalConflicts: {},
  saveFailed: {},
  propertyFailed: {},
  draftOffers: {},
  remoteDeleted: [],
  closedSaveFailures: {},
  hidden: [],
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useAppNoticesStore.setState(useAppNoticesStore.getInitialState())
  useNoticeToastStore.setState(useNoticeToastStore.getInitialState())
  useNoticesStackStore.setState(useNoticesStackStore.getInitialState())
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
})
afterEach(cleanup)

describe("the store", () => {
  it("keeps a notice until it is dismissed, and a repeat of the same cause is one notice", () => {
    useAppNoticesStore.getState().post(recovery)
    useAppNoticesStore.getState().post({ ...recovery, params: { count: 3 } })
    expect(useAppNoticesStore.getState().notices).toHaveLength(1)
    expect(useAppNoticesStore.getState().notices[0].params).toEqual({ count: 3 })
    useAppNoticesStore.getState().dismiss(recovery.id)
    expect(useAppNoticesStore.getState().notices).toEqual([])
  })

  it("announces danger and a decision by a toast that leads to the centre", () => {
    useAppNoticesStore.getState().post(vaultFailed)
    expect(useNoticeToastStore.getState().toasts).toMatchObject([
      { level: "decision", titleKey: vaultFailed.titleKey, target: { kind: "centre" } },
    ])
    useAppNoticesStore.getState().post({ ...vaultFailed, id: "x", level: "danger" })
    expect(useNoticeToastStore.getState().toasts).toHaveLength(2)
  })

  it("does not announce a warning: it waits in the centre", () => {
    useAppNoticesStore.getState().post(recovery)
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })

  it("takes the toast away with the notice", () => {
    useAppNoticesStore.getState().post(vaultFailed)
    useAppNoticesStore.getState().dismiss(vaultFailed.id)
    expect(useNoticeToastStore.getState().toasts).toEqual([])
  })
})

describe("what the centre derives", () => {
  it("puts a decision into 'Needs a decision' and a warning into 'Attention'", () => {
    const centre = deriveCentre({ ...emptyInput, appNotices: [vaultFailed, recovery] })
    expect(centre.decision.map((entry) => [entry.kind, entry.level])).toEqual([
      ["app-notice", "decision"],
    ])
    expect(centre.warning.map((entry) => [entry.kind, entry.level])).toEqual([
      ["app-notice", "warning"],
    ])
  })

  it("counts them on the bell, at the level of the most serious", () => {
    const centre = deriveCentre({ ...emptyInput, appNotices: [recovery] })
    expect(centreCounter(centre)).toEqual({ count: 1, level: "warning" })
    const both = deriveCentre({ ...emptyInput, appNotices: [recovery, vaultFailed] })
    expect(centreCounter(both)).toEqual({ count: 2, level: "decision" })
  })

  it("is the same without any notices of the application", () => {
    expect(deriveCentre(emptyInput)).toEqual({ decision: [], warning: [] })
  })
})

describe("the stack", () => {
  const open = () => {
    act(() => useNoticesStackStore.getState().open())
    return screen.findByTestId("notices-centre")
  }

  it("shows a card with the words of the locale and a way to close it", async () => {
    render(<NoticesStack port={createFakePort()} />)
    act(() => {
      useAppNoticesStore.getState().post(vaultFailed)
      useAppNoticesStore.getState().post(recovery)
    })
    const centre = await open()
    const decision = within(within(centre).getByTestId("notices-section-decision"))
    expect(decision.getByText(i18n.t(vaultFailed.titleKey))).toBeTruthy()
    expect(decision.getByText(i18n.t(vaultFailed.lineKey))).toBeTruthy()
    const warning = within(within(centre).getByTestId("notices-section-warning"))
    expect(warning.getByText(i18n.t(recovery.titleKey, recovery.params))).toBeTruthy()
    fireEvent.click(decision.getByRole("button", { name: "Закрыть" }))
    expect(useAppNoticesStore.getState().notices.map((notice) => notice.id)).toEqual([recovery.id])
  })

  it("lets a warning be closed too", async () => {
    render(<NoticesStack port={createFakePort()} />)
    act(() => useAppNoticesStore.getState().post(recovery))
    const centre = await open()
    fireEvent.click(within(centre).getByRole("button", { name: "Закрыть" }))
    expect(useAppNoticesStore.getState().notices).toEqual([])
  })
})
