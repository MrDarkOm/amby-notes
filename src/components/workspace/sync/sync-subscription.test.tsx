// @vitest-environment happy-dom
// The subscription in the interface (docs/sync-plan.md, appendix Н, Н10–Н12): the account says
// whether its plan allows sending; "Оформить подписку" is a stub with one calm line; the wizard that
// meets `subscription_required` offers the same button; files that wait for a subscription are
// listed and make one "Attention" record. Behaviour only. Written before the code.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, syncErrorKey } from "@/lib/sync/sync-errors"
import { SyncPortError, type AccountOverview, type VaultSyncStatus } from "@/lib/sync/sync-port"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useVaultStore } from "../use-vault-store"
import { NoticesStack } from "../notices/notices-stack"
import { useNoticesStackStore } from "../notices/use-notices-stack-store"
import { useNoticesCentreStore } from "../notices/use-notices-centre-store"
import { AccountStorage } from "./account-storage"
import { limitNoticesOf } from "./limit-notices"
import { SyncNoticesHost } from "./sync-notices-host"
import { SyncVaultPanel } from "./sync-vault-panel"
import { useSyncNoticesStore } from "./use-sync-notices-store"
import {
  ACCOUNT_STANDARD,
  ACCOUNT_UNLIMITED,
  VAULT_OFF,
  createFakePort,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"

type Unsynced = VaultSyncStatus["unsynced"][number]

const FREE: AccountOverview = {
  ...ACCOUNT_STANDARD,
  plan: { name: "free", title: "Free", pinned: false, sync: false, untilMs: null },
  usage: { ...ACCOUNT_STANDARD.usage, liveBytes: 0, pendingBytes: 0, spaces: 0 },
  spaces: [],
}
/** 13 December 2026 23:59:59.999 UTC is the last moment of «--until 2026-12-13» (Н3). */
const UNTIL = Date.UTC(2026, 11, 14) - 1
const SUBSCRIBED: AccountOverview = {
  ...ACCOUNT_STANDARD,
  plan: { name: "notes", title: "Notes", pinned: true, sync: true, untilMs: UNTIL },
}
const waiting = (path: string): Unsynced => ({ path, reason: "subscriptionRequired", detail: null })

const SUBSCRIPTION_KEYS = [
  "sync.account.noSubscription",
  "sync.account.buySubscription",
  "sync.account.buyStub",
  "sync.account.planUntil",
  "sync.errors.subscription_required",
  "notices.centre.subscriptionRequired",
  "notices.centre.subscriptionRequiredLine",
]

async function mountAccount(data: AccountOverview) {
  const port = createFakePort({ accountOverview: async () => data })
  render(<AccountStorage port={port} />)
  await screen.findByTestId("account-storage")
  return port
}

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({
    vault: "/vault",
    vaults: [{ id: "1", name: "Work", path: "/vault" }],
  })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState({ restored: [] })
  useNoticesCentreStore.setState(useNoticesCentreStore.getInitialState())
  useNoticesStackStore.setState({ isOpen: true })
})
afterEach(cleanup)

describe("the account without a subscription (Н10, Н11)", () => {
  it("says that sync is not available and offers the subscription", async () => {
    await mountAccount(FREE)
    expect(screen.getByTestId("subscription-none").textContent).toMatch(
      /Без подписки · синхронизация недоступна/,
    )
    expect(screen.getByRole("button", { name: "Оформить подписку" })).toBeTruthy()
  })

  it("the button is a stub: one calm line, no request to the application", async () => {
    const port = await mountAccount(FREE)
    const before = Object.values(port).filter(
      (fn) => typeof fn === "function" && "mock" in fn && fn.mock.calls.length > 0,
    ).length
    expect(screen.queryByTestId("subscription-stub")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Оформить подписку" }))
    const line = await screen.findByTestId("subscription-stub")
    expect(line.textContent).toBe(
      "Оплата скоро появится. Пока подписку выдаёт администратор сервера",
    )
    expect(line.getAttribute("role")).not.toBe("alert")
    expect(screen.queryByRole("dialog")).toBeNull()
    const after = Object.values(port).filter(
      (fn) => typeof fn === "function" && "mock" in fn && fn.mock.calls.length > 0,
    ).length
    expect(after).toBe(before)
  })

  it("names no price: the owner of the server sets it (Н10)", async () => {
    await mountAccount(FREE)
    fireEvent.click(screen.getByRole("button", { name: "Оформить подписку" }))
    await screen.findByTestId("subscription-stub")
    expect(screen.getByTestId("account-storage").textContent).not.toMatch(/\$|₽|€/)
  })
})

describe("the account with a subscription (Н10)", () => {
  it("shows the end of the subscription and no button", async () => {
    await mountAccount(SUBSCRIBED)
    expect(screen.getByTestId("plan-until").textContent).toMatch(/до 13 декабря 2026/)
    expect(screen.queryByRole("button", { name: "Оформить подписку" })).toBeNull()
    expect(screen.queryByTestId("subscription-none")).toBeNull()
  })

  it("shows no end for a subscription without one, and nothing new on an own server", async () => {
    await mountAccount({ ...SUBSCRIBED, plan: { ...SUBSCRIBED.plan!, untilMs: null } })
    expect(screen.queryByTestId("plan-until")).toBeNull()
    cleanup()
    await mountAccount(ACCOUNT_UNLIMITED)
    expect(screen.queryByTestId("subscription-none")).toBeNull()
    expect(screen.queryByRole("button", { name: "Оформить подписку" })).toBeNull()
  })
})

describe("the wizard meets `subscription_required` (Н12)", () => {
  async function refused() {
    const port = createFakePort({
      vaultStatus: async () => VAULT_OFF,
      enableVault: async () => {
        throw new SyncPortError("subscription_required")
      },
    })
    render(<SyncVaultPanel port={port} />)
    await screen.findByTestId("sync-backup-before-enable")
    fireEvent.click(screen.getByRole("button", { name: "Включить синхронизацию" }))
    return port
  }

  it("says that a subscription is needed and offers the stub button", async () => {
    const port = await refused()
    const message = await screen.findByRole("alert")
    expect(message.textContent).toMatch(/подписк/i)
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Оформить подписку" }))
    expect((await screen.findByTestId("subscription-stub")).textContent).toMatch(
      /Оплата скоро появится/,
    )
  })

  it("knows the code in both languages", async () => {
    expect(KNOWN_SYNC_ERROR_CODES).toContain("subscription_required")
    expect(syncErrorKey("subscription_required")).toBe("sync.errors.subscription_required")
  })
})

describe("files that wait for a subscription (Н12)", () => {
  it("make one notice of their own", () => {
    const notices = limitNoticesOf(vaultStatus({ unsynced: [waiting("a.md"), waiting("b.md")] }))
    expect(notices).toEqual([{ kind: "subscriptionRequired" }])
  })

  it("are listed with a reason the interface knows", async () => {
    const port = createFakePort({
      vaultStatus: async () => vaultStatus({ unsynced: [waiting("Notes/a.md")] }),
    })
    render(<SyncVaultPanel port={port} />)
    const list = await screen.findByTestId("sync-unsynced")
    expect(list.textContent).toMatch(/Notes\/a\.md/)
    expect(list.textContent).toMatch(/подписк/i)
  })

  it("show one «Attention» record in the centre, gone with the cause", async () => {
    const port = createFakePort({ vaultStatus: async () => vaultStatus() })
    render(
      <>
        <SyncNoticesHost port={port} />
        <NoticesStack port={port} />
      </>,
    )
    await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
    await act(async () =>
      emitVaultStatus(vaultStatus({ unsynced: [waiting("a.md"), waiting("b.md")] })),
    )
    const record = () =>
      screen
        .queryAllByTestId("notices-entry")
        .filter((card) => card.getAttribute("data-entry-id") === "limit:subscriptionRequired")
    await waitFor(() => expect(record()).toHaveLength(1))
    expect(record()[0].getAttribute("data-level")).toBe("warning")
    expect(record()[0].textContent).toMatch(/Нужна подписка/)
    await act(async () => emitVaultStatus(vaultStatus({ unsynced: [] })))
    await waitFor(() => expect(record()).toHaveLength(0))
  })
})

describe("the texts (Н12)", () => {
  it("exist in both languages", async () => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      for (const key of SUBSCRIPTION_KEYS) {
        expect(i18n.exists(key), `${language}: ${key}`).toBe(true)
      }
    }
  })
})
