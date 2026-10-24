// @vitest-environment happy-dom
// "Хранилища аккаунта" (docs/sync-plan.md, appendix Е, У1, У2, У4): the plan and its limits, the
// gauge of the place, one row per storage. Behaviour only; how it looks is checked in a native
// window. Written before the component.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { unavailableSyncPort, type AccountOverview } from "@/lib/sync/sync-port"
import { useVaultStore } from "../use-vault-store"
import { AccountStorage } from "./account-storage"
import { SyncSettings } from "./sync-settings"
import {
  ACCOUNT_STANDARD,
  ACCOUNT_UNLIMITED,
  CONNECTED,
  createFakePort,
  emitVaultStatus,
  vaultStatus,
} from "./fake-sync-port"

/** The keys the section and the notices of appendix Е need, in both languages. */
const APPENDIX_E_KEYS = [
  "sync.account.title",
  "sync.account.refresh",
  "sync.account.plan",
  "sync.account.ownServerUnlimited",
  "sync.account.usedOf",
  "sync.account.used",
  "sync.account.historyLine",
  "sync.account.limitSpaces",
  "sync.account.limitFile",
  "sync.account.limitHistory",
  "sync.account.limitHistoryDays",
  "sync.account.ownerChangesPlan",
  "sync.account.thisVault",
  "sync.account.boundHere",
  "sync.account.elsewhere",
  "sync.account.nameUnavailable",
  "sync.account.rowHistory",
  "sync.vault.unsynced.quotaFull",
  "sync.errors.space_limit",
]

const PLURAL_KEYS = ["sync.notices.tooLarge"]
const PLAIN_NOTICE_KEYS = [
  "sync.notices.tooLargeShow",
  "sync.notices.quotaFull",
  "sync.notices.spaceLimit",
  "sync.notices.chooseExisting",
]

function overview(patch: Partial<AccountOverview> = {}): AccountOverview {
  return { ...ACCOUNT_STANDARD, ...patch }
}

function withUsage(liveBytes: number, pendingBytes = 0): AccountOverview {
  return overview({
    usage: { ...ACCOUNT_STANDARD.usage, liveBytes, pendingBytes },
  })
}

async function mount(data: AccountOverview) {
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
})
afterEach(cleanup)

describe("the header of the section (У2)", () => {
  it("asks the application for the overview with the folders of the known vaults", async () => {
    const port = await mount(ACCOUNT_STANDARD)
    expect(port.accountOverview).toHaveBeenCalledWith(["/vault"])
  })

  it("names the plan and the place used, in decimal units", async () => {
    await mount(ACCOUNT_STANDARD)
    expect(screen.getByText("Тариф: Стандарт")).toBeTruthy()
    expect(screen.getByText("312 МБ из 1 ГБ")).toBeTruthy()
    const gauge = screen.getByRole("progressbar")
    expect(Number(gauge.getAttribute("aria-valuenow"))).toBeCloseTo(31.2, 1)
  })

  it("shows only the limits that are set, and the history apart", async () => {
    await mount(ACCOUNT_STANDARD)
    expect(screen.getByText("Хранилищ: 1 из 1")).toBeTruthy()
    expect(screen.getByText("Файл до 20 МБ")).toBeTruthy()
    expect(screen.getByText("История 30 дней, до 1 ГБ")).toBeTruthy()
    expect(screen.getByTestId("account-history").textContent).toMatch(/40 МБ/)
    expect(screen.getByText("Тариф меняет владелец сервера")).toBeTruthy()
    cleanup()
    await mount(
      overview({
        limits: {
          ...ACCOUNT_STANDARD.limits,
          maxSpaces: null,
          maxFileBytes: null,
          maxHistoryBytes: null,
        },
      }),
    )
    expect(screen.queryByText(/Хранилищ:/)).toBeNull()
    expect(screen.queryByText(/Файл до/)).toBeNull()
    expect(screen.getByText("История 30 дней")).toBeTruthy()
  })

  it("changes the colour of the gauge at 80% and at 100%, counting the waiting uploads", async () => {
    const levelOf = async (data: AccountOverview) => {
      cleanup()
      await mount(data)
      return screen.getByRole("progressbar").getAttribute("data-level")
    }
    expect(await levelOf(withUsage(790_000_000))).toBe("ok")
    expect(await levelOf(withUsage(800_000_000))).toBe("warn")
    expect(await levelOf(withUsage(999_000_000))).toBe("warn")
    expect(await levelOf(withUsage(1_000_000_000))).toBe("full")
    expect(await levelOf(withUsage(700_000_000, 100_000_000))).toBe("warn")
    expect(await levelOf(withUsage(1_200_000_000))).toBe("full")
  })

  it("has no gauge and no percent without a quota: only what is taken", async () => {
    await mount(ACCOUNT_UNLIMITED)
    expect(screen.getByText("Свой сервер: без ограничений")).toBeTruthy()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByText("Занято 312 МБ")).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/%/)
    cleanup()
    await mount(
      overview({
        plan: { name: "free", title: "Free", pinned: true },
        limits: { ...ACCOUNT_STANDARD.limits, maxTotalBytes: null },
      }),
    )
    expect(screen.getByText("Тариф: Free")).toBeTruthy()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByText("Занято 312 МБ")).toBeTruthy()
  })

  it("treats a server that does not know the account as a server without limits", async () => {
    await mount({ ...ACCOUNT_UNLIMITED, limitsKnown: false })
    expect(screen.getByText("Свой сервер: без ограничений")).toBeTruthy()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("takes the plan name when the plan has no title", async () => {
    await mount(overview({ plan: { name: "standard", title: null, pinned: false } }))
    expect(screen.getByText("Тариф: standard")).toBeTruthy()
  })

  it("speaks English when the language is English", async () => {
    await i18n.changeLanguage("en")
    await mount({
      ...ACCOUNT_STANDARD,
      plan: { name: "standard", title: "Standard", pinned: false },
    })
    expect(screen.getByText("Plan: Standard")).toBeTruthy()
    expect(screen.getByText("312 MB of 1 GB")).toBeTruthy()
    expect(screen.getByText("File up to 20 MB")).toBeTruthy()
    expect(screen.getByText("This storage")).toBeTruthy()
  })
})

describe("the rows (У1)", () => {
  const rows = () => screen.getAllByTestId("storage-row")

  it("lists this storage first and then by size, and says which is which", async () => {
    await mount(
      overview({
        usage: { ...ACCOUNT_STANDARD.usage, spaces: 4 },
        spaces: [
          {
            spaceId: "a1".repeat(16),
            name: "Большое",
            liveBytes: 900_000_000,
            historyBytes: 0,
            thisVault: false,
            boundFolder: null,
          },
          {
            spaceId: "b2".repeat(16),
            name: "Это",
            liveBytes: 5_000_000,
            historyBytes: 0,
            thisVault: true,
            boundFolder: "Work",
          },
          {
            spaceId: "c3".repeat(16),
            name: "Среднее",
            liveBytes: 50_000_000,
            historyBytes: 0,
            thisVault: false,
            boundFolder: "Notes",
          },
          {
            spaceId: "d4".repeat(16),
            name: null,
            liveBytes: 1_000,
            historyBytes: 0,
            thisVault: false,
            boundFolder: null,
          },
        ],
      }),
    )
    const list = rows()
    expect(list).toHaveLength(4)
    expect(list.map((row) => within(row).getByTestId("storage-name").textContent)).toEqual([
      "Это",
      "Большое",
      "Среднее",
      "Название недоступно",
    ])
    expect(within(list[0]).getByText("Это хранилище")).toBeTruthy()
    expect(within(list[0]).queryByText(/Привязано на этом компьютере/)).toBeNull()
    expect(within(list[1]).getByText("Подключено на других устройствах или нигде")).toBeTruthy()
    expect(within(list[2]).getByText("Привязано на этом компьютере: Notes")).toBeTruthy()
    expect(within(list[1]).getByText("900 МБ")).toBeTruthy()
    expect(within(list[2]).getByText("50 МБ")).toBeTruthy()
  })

  it("shows the history of a storage on a second grey line and not when it is empty", async () => {
    await mount(ACCOUNT_STANDARD)
    expect(within(rows()[0]).getByText("и история 40 МБ")).toBeTruthy()
    cleanup()
    await mount(ACCOUNT_UNLIMITED)
    expect(screen.queryByText(/и история/)).toBeNull()
  })

  it("has no way to delete a storage from the server yet (Э5)", async () => {
    await mount(ACCOUNT_UNLIMITED)
    expect(rows().length).toBeGreaterThan(0)
    expect(screen.queryByText(/Удалить с сервера/)).toBeNull()
    expect(screen.queryByRole("menu")).toBeNull()
    for (const row of rows()) {
      expect(within(row).queryByRole("button")).toBeNull()
    }
  })
})

describe("when the section reads the server (У1)", () => {
  it("reads when opened, again on the button, and never by a timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const port = await mount(ACCOUNT_STANDARD)
      expect(port.accountOverview).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
      })
      expect(port.accountOverview).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Обновить" }))
      await waitFor(() => expect(port.accountOverview).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it("reads again when a pass ends and a limit was announced, and not otherwise", async () => {
    const port = await mount(ACCOUNT_STANDARD)
    await act(async () => emitVaultStatus(vaultStatus({ unsynced: [] })))
    expect(port.accountOverview).toHaveBeenCalledTimes(1)
    await act(async () =>
      emitVaultStatus(
        vaultStatus({
          unsynced: [{ path: "a.bin", reason: "quotaFull", detail: null }],
        }),
      ),
    )
    await waitFor(() => expect(port.accountOverview).toHaveBeenCalledTimes(2))
  })

  it("says what went wrong in words when the server cannot be reached", async () => {
    const port = createFakePort({
      accountOverview: async () => {
        throw new (await import("@/lib/sync/sync-port")).SyncPortError("network")
      },
    })
    render(<AccountStorage port={port} />)
    expect(await screen.findByRole("alert")).toBeTruthy()
  })
})

describe("the section in the settings (У1, У5)", () => {
  it("is shown when connected, next to the devices, and not in the browser build", async () => {
    const port = createFakePort({ status: async () => CONNECTED })
    render(<SyncSettings port={port} />)
    expect(await screen.findByText("Хранилища аккаунта")).toBeTruthy()
    expect(await screen.findByTestId("account-storage")).toBeTruthy()
    cleanup()
    render(<SyncSettings port={unavailableSyncPort} />)
    await screen.findAllByText(/Синхронизация/)
    expect(screen.queryByText("Хранилища аккаунта")).toBeNull()
  })
})

describe("the texts of appendix Е exist in every language", () => {
  it("has every key in Russian and in English", async () => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      for (const key of APPENDIX_E_KEYS) {
        expect(i18n.exists(key), `${language} ${key}`).toBe(true)
        expect(i18n.t(key, { defaultValue: "∅" })).not.toBe("∅")
      }
      for (const key of PLAIN_NOTICE_KEYS) {
        expect(i18n.exists(key), `${language} ${key}`).toBe(true)
      }
      for (const key of PLURAL_KEYS) {
        for (const count of [1, 2, 5, 21]) {
          expect(i18n.exists(key, { count }), `${language} ${key} ${count}`).toBe(true)
        }
      }
    }
  })
})
