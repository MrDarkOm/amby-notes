// @vitest-environment happy-dom
// The notices and the texts about the limits of a plan (docs/sync-plan.md, appendix Е, У3): three
// cards in the stack of notices, each shown once per cause, gone when the cause is gone; the
// files that stay behind are listed with the limit; the wizard that meets `space_limit` offers the
// existing storages. Written before the code.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, syncErrorKey } from "@/lib/sync/sync-errors"
import { SyncPortError, type VaultSyncStatus } from "@/lib/sync/sync-port"
import { useNoteNoticesStore } from "../note-notices/use-note-notices-store"
import { useVaultStore } from "../use-vault-store"
import { limitNoticesOf } from "./limit-notices"
import { SyncNoticesHost } from "./sync-notices-host"
import { SyncVaultPanel } from "./sync-vault-panel"
import { useSyncNoticesStore } from "./use-sync-notices-store"
import { SPACES, VAULT_OFF, createFakePort, emitVaultStatus, vaultStatus } from "./fake-sync-port"

type Unsynced = VaultSyncStatus["unsynced"][number]

const tooLarge = (path: string, maxBytes = 20_000_000, limitSource = "plan"): Unsynced => ({
  path,
  reason: "tooLarge",
  detail: null,
  maxBytes,
  limitSource,
})
const quotaFull = (path: string): Unsynced => ({ path, reason: "quotaFull", detail: null })

beforeEach(async () => {
  await i18n.changeLanguage("ru")
  useVaultStore.setState({ vault: "/vault" })
  useSyncNoticesStore.setState(useSyncNoticesStore.getInitialState())
  useNoteNoticesStore.setState({ restored: [] })
})
afterEach(cleanup)

async function mount(status = vaultStatus()) {
  const port = createFakePort({ vaultStatus: async () => status })
  render(<SyncNoticesHost port={port} />)
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}

const push = async (unsynced: Unsynced[]) =>
  act(async () => emitVaultStatus(vaultStatus({ unsynced })))

const cards = (kind?: string) =>
  screen
    .queryAllByTestId("sync-limit-notice")
    .filter((card) => kind === undefined || card.getAttribute("data-kind") === kind)

describe("which notices the status asks for (У3)", () => {
  it("counts the files over the limit of the plan as one cause", () => {
    const notices = limitNoticesOf(
      vaultStatus({ unsynced: [tooLarge("a.bin"), tooLarge("b.bin"), quotaFull("c.bin")] }),
    )
    expect(notices).toEqual([
      { kind: "tooLarge", count: 2, maxBytes: 20_000_000 },
      { kind: "quotaFull" },
    ])
  })

  it("has none for a vault with nothing behind it", () => {
    expect(limitNoticesOf(vaultStatus({ unsynced: [] }))).toEqual([])
    expect(
      limitNoticesOf(vaultStatus({ unsynced: [{ path: "x", reason: "noAccess", detail: null }] })),
    ).toEqual([])
  })
})

describe("the cards in the stack of notices (У3)", () => {
  it("says that files were not sent, how many, the limit, and that nothing is lost", async () => {
    await mount()
    await push([tooLarge("a.bin"), tooLarge("b.bin"), tooLarge("c.bin")])
    const [card] = cards("tooLarge")
    expect(card).toBeTruthy()
    const text = card.textContent ?? ""
    expect(text).toMatch(/не отправлены/)
    expect(text).toMatch(/\b3\b/)
    expect(text).toMatch(/больше 20 МБ на вашем тарифе/)
    expect(text).toMatch(/остаются на этом компьютере/)
    expect(text).toMatch(/на других устройствах ничего не изменилось/)
    expect(within(card).getByRole("button", { name: "Показать список" })).toBeTruthy()
  })

  it("says that the storage is full, that receiving goes on, and what to do", async () => {
    await mount()
    await push([quotaFull("a.bin")])
    const [card] = cards("quotaFull")
    const text = card.textContent ?? ""
    expect(text).toMatch(/Хранилище заполнено/)
    expect(text).toMatch(/Новые и изменённые файлы не отправляются/)
    expect(text).toMatch(/файлы с других устройств приходят как обычно/)
    expect(text).toMatch(/Удалите ненужное или попросите владельца сервера увеличить тариф/)
  })

  it("shows both cards when both causes are there", async () => {
    await mount()
    await push([tooLarge("a.bin"), quotaFull("b.bin")])
    expect(cards()).toHaveLength(2)
  })

  it("shows one card per cause however many passes repeat the status", async () => {
    await mount()
    for (let pass = 0; pass < 4; pass += 1) {
      await push([tooLarge("a.bin"), quotaFull("b.bin")])
    }
    expect(cards("tooLarge")).toHaveLength(1)
    expect(cards("quotaFull")).toHaveLength(1)
  })

  it("takes a card away when its cause is gone and shows it again if the cause comes back", async () => {
    await mount()
    await push([tooLarge("a.bin"), quotaFull("b.bin")])
    await push([quotaFull("b.bin")])
    expect(cards("tooLarge")).toHaveLength(0)
    expect(cards("quotaFull")).toHaveLength(1)
    await push([])
    expect(cards()).toHaveLength(0)
    await push([tooLarge("a.bin")])
    expect(cards("tooLarge")).toHaveLength(1)
  })

  it("shows the card of a cause that was already there when the vault was opened", async () => {
    await mount(vaultStatus({ unsynced: [quotaFull("a.bin")] }))
    await waitFor(() => expect(cards("quotaFull")).toHaveLength(1))
  })

  it("has no cards on a server without limits", async () => {
    await mount()
    await push([{ path: "x", reason: "noAccess", detail: null }])
    expect(cards()).toHaveLength(0)
  })
})

describe("the list of files that stay behind (У3, Д74)", () => {
  async function panelWith(unsynced: Unsynced[]) {
    const port = createFakePort({ vaultStatus: async () => vaultStatus({ unsynced }) })
    render(<SyncVaultPanel port={port} />)
    return screen.findByTestId("sync-unsynced")
  }

  it("names the limit of the plan next to a file that is too big", async () => {
    const list = await panelWith([tooLarge("Big/huge.bin")])
    expect(list.textContent).toMatch(/Big\/huge\.bin/)
    expect(list.textContent).toMatch(/20 МБ/)
    expect(list.textContent).toMatch(/тариф/i)
  })

  it("names the server when the limit is the server's own", async () => {
    const list = await panelWith([tooLarge("Big/huge.bin", 536_870_912, "server")])
    expect(list.textContent).toMatch(/537 МБ/)
    expect(list.textContent).toMatch(/сервер/i)
  })

  it("explains a file that waits for place", async () => {
    const list = await panelWith([quotaFull("New/big.bin")])
    expect(list.textContent).toMatch(/заполнено/i)
  })
})

describe("the wizard meets the limit of storages (У3, Д77)", () => {
  async function refused() {
    const port = createFakePort({
      vaultStatus: async () => ({ ...VAULT_OFF, gateClosed: true }),
      enableVault: async () => {
        throw new SyncPortError("space_limit")
      },
      listSpaces: async () => SPACES,
    })
    render(<SyncVaultPanel port={port} />)
    fireEvent.click(await screen.findByTestId("sync-test-vault"))
    fireEvent.click(screen.getByRole("button", { name: "Включить синхронизацию" }))
    return port
  }

  it("says that the plan has no room, creates nothing and offers the existing storages", async () => {
    const port = await refused()
    const message = await screen.findByRole("alert")
    expect(message.textContent).toMatch(/На вашем тарифе/)
    expect(message.textContent).toMatch(/Подключите существующее/)
    expect(message.textContent).toMatch(/обратитесь к владельцу сервера/)
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Выбрать существующее" }))
    await waitFor(() => expect(port.listSpaces).toHaveBeenCalled())
    expect(await screen.findByText("Рабочее")).toBeTruthy()
    expect((screen.getByLabelText(/Подключить существующее/) as HTMLInputElement).checked).toBe(
      true,
    )
  })

  it("knows the code in both languages", async () => {
    expect(KNOWN_SYNC_ERROR_CODES).toContain("space_limit")
    expect(syncErrorKey("space_limit")).toBe("sync.errors.space_limit")
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      expect(i18n.exists("sync.errors.space_limit"), language).toBe(true)
      expect(i18n.t("sync.errors.space_limit")).not.toBe("sync.errors.space_limit")
    }
  })
})

describe("an empty list of spaces is not a dead end (owner's request, row «Пустой список пространств»)", () => {
  async function chooseExistingWithNoSpaces() {
    const port = createFakePort({
      vaultStatus: async () => ({ ...VAULT_OFF, gateClosed: true }),
      listSpaces: async () => [],
    })
    render(<SyncVaultPanel port={port} />)
    fireEvent.click(await screen.findByLabelText(/Подключить существующее/))
    await waitFor(() => expect(port.listSpaces).toHaveBeenCalled())
    return port
  }

  it("says what to do first and offers a button that switches to «Создать новое»", async () => {
    await chooseExistingWithNoSpaces()
    expect(
      await screen.findByText(/Сначала создайте пространство на одном из устройств/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Создать новое/ }))
    expect((screen.getByLabelText(/Создать новое/) as HTMLInputElement).checked).toBe(true)
  })

  it("leaves «Создать новое» selected when the list comes back empty", async () => {
    await chooseExistingWithNoSpaces()
    await waitFor(() =>
      expect((screen.getByLabelText(/Создать новое/) as HTMLInputElement).checked).toBe(true),
    )
  })

  it("has the hint in both languages", async () => {
    for (const language of ["ru", "en"]) {
      await i18n.changeLanguage(language)
      expect(i18n.exists("sync.vault.noSpacesHint"), language).toBe(true)
    }
  })
})
