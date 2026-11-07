// @vitest-environment happy-dom
// The sync of the open vault (docs/sync-plan.md, stage Э4): behaviour only — what the person sees
// and what the screen asks of the application. How it looks is checked in a native window.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useNoticeJournalStore } from "@/lib/notices/use-notice-journal-store"
import i18n from "@/lib/i18n"
import { KNOWN_SYNC_ERROR_CODES, syncErrorKey } from "@/lib/sync/sync-errors"
import { SyncPortError } from "@/lib/sync/sync-port"
import type { VaultSyncStatus } from "@/lib/sync/sync-port"
import { SyncVaultPanel } from "./sync-vault-panel"
import {
  SPACES,
  VAULT_OFF,
  createFakePort,
  emitVaultStatus,
  vaultListenerCount,
  vaultStatus,
  type FakePort,
} from "./fake-sync-port"

async function show(
  status: VaultSyncStatus,
  overrides: Partial<Parameters<typeof createFakePort>[0]> = {},
): Promise<FakePort> {
  const port = createFakePort({ vaultStatus: async () => status, ...overrides })
  render(<SyncVaultPanel port={port} />)
  await screen.findByTestId("sync-vault")
  await waitFor(() => expect(port.vaultStatus).toHaveBeenCalled())
  return port
}

const button = (name: string | RegExp) => screen.getByRole("button", { name })
const click = (name: string | RegExp) => fireEvent.click(button(name))

describe("sync of the open vault: switching it on", () => {
  beforeEach(async () => {
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("ignores legacy gate and test-vault flags and allows switching sync on", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true, testVault: true })
    const panel = await screen.findByTestId("sync-vault")
    expect(panel.textContent).not.toMatch(/экспериментальн|тестов/i)
    expect(screen.queryByTestId("sync-test-warning")).toBeNull()
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, false),
    )
  })

  it("sends the name the person typed", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true, testVault: true })
    fireEvent.change(await screen.findByLabelText("Название"), {
      target: { value: "  Мои заметки " },
    })
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "Мои заметки" }, false),
    )
  })

  it("does not demand the test mark when the gate is open", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: false })
    await screen.findByRole("button", { name: "Включить синхронизацию" })
    expect(screen.queryByTestId("sync-test-warning")).toBeNull()
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, false),
    )
  })

  it("explains the complete backup made before sync starts", async () => {
    await show({ ...VAULT_OFF, gateClosed: false })
    const panel = await screen.findByTestId("sync-vault")
    expect(panel.textContent).toMatch(/полную копию/i)
    expect(panel.textContent).toMatch(/рядом с папкой/i)
    expect(panel.textContent).toMatch(/синхронизация не начнётся.*если.*ошиб/i)
  })

  it("ignores legacy test-vault metadata even when the old gate is closed", async () => {
    await show({ ...VAULT_OFF, gateClosed: true, testVault: true })
    expect(screen.queryByTestId("sync-test-warning")).toBeNull()
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
  })

  it("offers the backup manager instead of a manual restore procedure", async () => {
    await show({ ...VAULT_OFF, backupPath: "/notes.amby-backups/01J9TEST/vault" })
    const panel = await screen.findByTestId("sync-vault")
    expect(panel.querySelector("summary")?.textContent).toContain("Резервные копии")
    expect(panel.textContent).not.toMatch(/переименуйте|закройте Amby/)
  })

  it("does not enable sync when creating its pre-sync backup fails", async () => {
    const port = await show(
      { ...VAULT_OFF, gateClosed: false },
      {
        enableVault: async () => {
          throw new SyncPortError("backup_failed")
        },
      },
    )
    click("Включить синхронизацию")
    expect(await screen.findByRole("alert").then((alert) => alert.textContent)).toMatch(
      /резервн.*коп/i,
    )
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("sync-status")).toBeNull()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
  })

  it("lists the spaces of the account to connect an existing one", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true })
    fireEvent.click(await screen.findByRole("radio", { name: /Подключить существующее/ }))
    await waitFor(() => expect(port.listSpaces).toHaveBeenCalled())
    const first = await screen.findByRole("radio", { name: /Рабочее/ })
    expect(screen.getByRole("radio", { name: /Без названия/ })).toBeTruthy()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(true)
    fireEvent.click(first)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith(
        { kind: "existing", spaceId: SPACES[0].spaceId },
        false,
      ),
    )
  })

  it("says so when the account has no spaces yet", async () => {
    await show({ ...VAULT_OFF }, { listSpaces: async () => [] })
    fireEvent.click(await screen.findByRole("radio", { name: /Подключить существующее/ }))
    expect(await screen.findByText(/пока нет пространств/i)).toBeTruthy()
  })

  it("shows the text of the error when switching on fails, and stays usable", async () => {
    const port = await show(
      { ...VAULT_OFF },
      {
        enableVault: async () => {
          throw new SyncPortError("storage_error")
        },
      },
    )
    click("Включить синхронизацию")
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/сохран/i)
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    expect(port.enableVault).toHaveBeenCalledTimes(1)
  })

  it("does not start creating a space from the top switch before the form is submitted", async () => {
    const port = await show({ ...VAULT_OFF })
    const toggle = screen.getByRole("switch", { name: "Синхронизация" })
    expect(toggle.hasAttribute("disabled")).toBe(true)
    fireEvent.click(toggle)
    expect(port.enableVault).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Amby" } })
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "Amby" }, false),
    )
  })

  it("does not switch on twice while the first request is running", async () => {
    let release: (status: VaultSyncStatus) => void = () => {}
    const port = await show(
      { ...VAULT_OFF },
      { enableVault: () => new Promise<VaultSyncStatus>((resolve) => (release = resolve)) },
    )
    const start = button("Включить синхронизацию")
    fireEvent.click(start)
    fireEvent.click(start)
    expect(start.getAttribute("aria-busy")).toBe("true")
    expect(start.textContent).toContain("Подождите")
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    await act(async () => release(vaultStatus()))
    await screen.findByTestId("sync-status")
  })

  it("offers to switch a linked vault on again without choosing a space", async () => {
    const port = await show(
      vaultStatus({ enabled: false, phase: "off", linked: true, resumable: true }),
    )
    expect(await screen.findByText(/Синхронизация выключена/)).toBeTruthy()
    expect(screen.queryByLabelText("Название")).toBeNull()
    // nothing is sent before the person presses the button
    expect(port.enableVault).not.toHaveBeenCalled()
    click("Включить снова")
    await waitFor(() => expect(port.enableVault).toHaveBeenCalled())
  })
})

describe("sync of the open vault: a binding that was switched off", () => {
  const off = (overrides: Partial<VaultSyncStatus> = {}) =>
    vaultStatus({ enabled: false, phase: "off", linked: true, resumable: true, ...overrides })

  beforeEach(async () => {
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("shows the first-time choice, not 'switch on again', when the binding is of another server or account", async () => {
    // the remembered link does not belong to this connection: it must never be resumed
    const port = await show(off({ resumable: false, testVault: false }))
    expect(screen.queryByRole("button", { name: "Включить снова" })).toBeNull()
    expect(await screen.findByRole("radio", { name: /Создать новое/ })).toBeTruthy()
    expect(screen.getByRole("radio", { name: /Подключить существующее/ })).toBeTruthy()
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)

    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Новое" } })
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "Новое" }, false),
    )
  })

  it("lets the person connect an existing space from a stale binding", async () => {
    const port = await show(off({ resumable: false, testVault: false }))
    fireEvent.click(await screen.findByRole("radio", { name: /Подключить существующее/ }))
    fireEvent.click(await screen.findByRole("radio", { name: /Рабочее/ }))
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith(
        { kind: "existing", spaceId: SPACES[0].spaceId },
        false,
      ),
    )
  })

  it("resumes despite legacy gate metadata and always sends false", async () => {
    const port = await show(off({ gateClosed: true, testVault: false }))
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить снова").hasAttribute("disabled")).toBe(false)
    expect(port.enableVault).not.toHaveBeenCalled()
    click("Включить снова")
    await waitFor(() => expect(port.enableVault).toHaveBeenCalledTimes(1))
    expect(vi.mocked(port.enableVault).mock.calls[0][1]).toBe(false)
  })

  it("ignores a legacy test-vault flag when resuming", async () => {
    await show(off({ gateClosed: true, testVault: true }))
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить снова").hasAttribute("disabled")).toBe(false)
    click("Включить снова")
    await waitFor(() => expect(screen.getByTestId("sync-vault")).toBeTruthy())
    cleanup()
    const port = await show(off({ gateClosed: false, testVault: false }))
    expect(screen.queryByTestId("sync-test-vault")).toBeNull()
    expect(button("Включить снова").hasAttribute("disabled")).toBe(false)
    click("Включить снова")
    await waitFor(() => expect(port.enableVault).toHaveBeenCalledTimes(1))
    expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, false)
  })

  it("falls back to the first-time choice when resuming finds the space gone", async () => {
    const port = await show(off({ gateClosed: true, testVault: true }), {
      enableVault: async () => {
        // the application forgot the stale link and tells the screen
        emitVaultStatus({ ...VAULT_OFF, gateClosed: true })
        throw new SyncPortError("space_not_found")
      },
    })
    click("Включить снова")
    expect((await screen.findByRole("alert")).textContent).toMatch(/нет такого/i)
    expect(await screen.findByRole("radio", { name: /Создать новое/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Включить снова" })).toBeNull()
    expect(port.enableVault).toHaveBeenCalledTimes(1)
  })
})

describe("sync of the open vault: the status", () => {
  beforeEach(async () => {
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("says that everything is synchronised and when it last was", async () => {
    await show(vaultStatus({ phase: "idle", lastSyncMs: Date.UTC(2026, 9, 23, 10, 30) }))
    const status = await screen.findByTestId("sync-status")
    expect(status.getAttribute("role")).toBe("status")
    expect(status.textContent).toMatch(/Всё синхронизировано/)
    expect(status.textContent).toMatch(/2026/)
    expect(screen.getByText(/Рабочее хранилище/)).toBeTruthy()
  })

  it("says that nothing has been synchronised yet", async () => {
    await show(vaultStatus({ phase: "idle", lastSyncMs: null }))
    expect((await screen.findByTestId("sync-status")).textContent).toMatch(
      /Ещё не синхронизировалось/,
    )
  })

  it("says that a pass is running", async () => {
    await show(vaultStatus({ phase: "running" }))
    expect((await screen.findByTestId("sync-status")).textContent).toMatch(/Идёт синхронизация/)
  })

  it("explains a lost connection, with the wait and the reason", async () => {
    await show(vaultStatus({ phase: "waiting", errorCode: "network", nextTrySecs: 40 }))
    const status = await screen.findByTestId("sync-status")
    expect(status.textContent).toMatch(/Нет связи с сервером/)
    expect(status.textContent).toMatch(/40 с/)
    expect(screen.getByTestId("sync-status-detail").textContent).toMatch(/Не удалось связаться/)
    expect(screen.queryByTestId("sync-stop")).toBeNull()
  })

  it("ignores legacy test-vault metadata in the status", async () => {
    await show(vaultStatus({ gateClosed: true, testVault: true }))
    expect(screen.queryByText(/тестовое хранилище/i)).toBeNull()
  })

  it("asks for a pass now and shows what it did", async () => {
    const port = await show(vaultStatus({ phase: "idle" }))
    click("Синхронизировать сейчас")
    await waitFor(() => expect(port.runNow).toHaveBeenCalledTimes(1))
  })

  it("explains that sending waits for an unfinished operation", async () => {
    await show(vaultStatus({ outgoingPaused: true }))
    expect((await screen.findByTestId("sync-vault")).textContent).toMatch(/Отправка приостановлена/)
  })

  it("reports files that could not be processed and will be tried again", async () => {
    await show(vaultStatus({ itemErrors: 3 }))
    expect((await screen.findByTestId("sync-vault")).textContent).toMatch(
      /Не удалось обработать файлов: 3/,
    )
  })

  it("asks to update Amby when a file is made by a newer version", async () => {
    await show(vaultStatus({ needsUpdate: true }))
    expect((await screen.findByTestId("sync-vault")).textContent).toMatch(
      /более новой версией Amby/,
    )
  })

  it("follows the status the application reports, without a reload", async () => {
    const port = await show(vaultStatus({ phase: "idle" }))
    await waitFor(() => expect(vaultListenerCount()).toBe(1))
    act(() => emitVaultStatus(vaultStatus({ phase: "running" })))
    await waitFor(() =>
      expect(screen.getByTestId("sync-status").textContent).toMatch(/Идёт синхронизация/),
    )
    act(() =>
      emitVaultStatus(
        vaultStatus({
          phase: "stopped",
          stop: { kind: "vaultMissing" },
        }),
      ),
    )
    await screen.findByTestId("sync-stop")
    expect(port.vaultStatus).toHaveBeenCalledTimes(1)
  })

  it("stops listening when the screen is closed", async () => {
    await show(vaultStatus())
    await waitFor(() => expect(vaultListenerCount()).toBe(1))
    cleanup()
    expect(vaultListenerCount()).toBe(0)
  })

  it("switches off and resumes the existing space through the top switch", async () => {
    const port = await show(vaultStatus(), {
      disableVault: async () => vaultStatus({ enabled: false, phase: "off", resumable: true }),
    })
    fireEvent.click(screen.getByRole("switch", { name: "Синхронизация" }))
    await waitFor(() => expect(port.disableVault).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
    )
    fireEvent.click(screen.getByRole("switch"))
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, false),
    )
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
    )
  })

  it("keeps the switch on and reports a failed disable", async () => {
    await show(vaultStatus(), {
      disableVault: async () => {
        throw new SyncPortError("ipc_failed")
      },
    })
    fireEvent.click(screen.getByRole("switch"))
    await screen.findByRole("alert")
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
  })
})

describe("sync of the open vault: the stops of Р8", () => {
  beforeEach(async () => {
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  const files = Array.from({ length: 5 }, (_, n) => ({
    path: `Заметки/${n}.md`,
    action: "trash",
  }))

  it("lists the files of an incoming mass change and goes on only when told to", async () => {
    // Р8, О6: nothing happens until the person says yes
    const port = await show(
      vaultStatus({
        phase: "stopped",
        stop: { kind: "massChange", direction: "incoming", total: 25, files },
      }),
    )
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.getAttribute("role")).toBe("alert")
    expect(stop.textContent).toMatch(/25 файлов/)
    expect(stop.textContent).toMatch(/корзин/i)
    expect(within(stop).getAllByRole("listitem")).toHaveLength(5)
    expect(stop.textContent).toMatch(/Заметки\/0\.md/)
    expect(stop.textContent).toMatch(/и ещё 20/)
    expect(port.approve).not.toHaveBeenCalled()
    click("Да, продолжить")
    await waitFor(() => expect(port.approve).toHaveBeenCalledWith("massChange"))
  })

  it("says that deletions would leave this computer when the change is outgoing", async () => {
    await show(
      vaultStatus({
        phase: "stopped",
        stop: {
          kind: "massChange",
          direction: "outgoing",
          total: 30,
          files: files.map((f) => ({ ...f, action: "sendDelete" })),
        },
      }),
    )
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.textContent).toMatch(/30 файлов/)
    expect(stop.textContent).toMatch(/другие компьютеры/)
  })

  it("says that nothing was deleted when the folder of the vault is gone, and offers no approval", async () => {
    const port = await show(vaultStatus({ phase: "stopped", stop: { kind: "vaultMissing" } }))
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.textContent).toMatch(/Папка хранилища не найдена/)
    expect(stop.textContent).toMatch(/Ничего не удалено/)
    expect(screen.queryByRole("button", { name: /Да, / })).toBeNull()
    click("Проверить снова")
    await waitFor(() => expect(port.runNow).toHaveBeenCalled())
  })

  it("lets the person confirm that an empty folder is really empty", async () => {
    const port = await show(vaultStatus({ phase: "stopped", stop: { kind: "vaultEmpty" } }))
    expect((await screen.findByTestId("sync-stop")).textContent).toMatch(/пуста/)
    click("Да, папка пуста")
    await waitFor(() => expect(port.approve).toHaveBeenCalledWith("emptyVault"))
  })

  it("reassures after a server reset and uploads the vault again only after a second click", async () => {
    // Р8, С7: an empty server is never a command to delete here
    const port = await show(vaultStatus({ phase: "stopped", stop: { kind: "serverReset" } }))
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.textContent).toMatch(/Сервер сброшен/)
    expect(stop.textContent).toMatch(/ничего не удалено на этом компьютере/i)
    click("Загрузить это хранилище на сервер заново")
    expect(port.approve).not.toHaveBeenCalled()
    click("Отмена")
    expect(port.approve).not.toHaveBeenCalled()
    click("Загрузить это хранилище на сервер заново")
    click("Да, загрузить заново")
    await waitFor(() => expect(port.approve).toHaveBeenCalledWith("resync"))
  })

  it("explains a server that shows fewer or older changes and offers the same way out", async () => {
    for (const kind of ["serverBehind", "rollback"] as const) {
      cleanup()
      const port = await show(vaultStatus({ phase: "stopped", stop: { kind } }))
      const stop = await screen.findByTestId("sync-stop")
      expect(stop.textContent).toMatch(/сервер/i)
      click("Загрузить это хранилище на сервер заново")
      click("Да, загрузить заново")
      await waitFor(() => expect(port.approve).toHaveBeenCalledWith("resync"))
    }
  })

  it("tells to sign in again when the server no longer knows this device", async () => {
    await show(
      vaultStatus({
        phase: "stopped",
        errorCode: "token_revoked",
        stop: { kind: "authRequired" },
      }),
    )
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.textContent).toMatch(/Войдите снова/)
  })

  it("tells about a server of another protocol", async () => {
    await show(vaultStatus({ phase: "stopped", stop: { kind: "incompatibleServer" } }))
    expect((await screen.findByTestId("sync-stop")).textContent).toMatch(/другой версии/)
  })

  it("shows the error when the answer cannot be sent", async () => {
    await show(vaultStatus({ phase: "stopped", stop: { kind: "vaultEmpty" } }), {
      approve: async () => {
        throw new SyncPortError("sync_not_running")
      },
    })
    await screen.findByRole("button", { name: "Да, папка пуста" })
    click("Да, папка пуста")
    await waitFor(() =>
      expect(
        screen.getAllByRole("alert").some((el) => /не запущена/i.test(el.textContent ?? "")),
      ).toBe(true),
    )
  })
})

describe("sync of the open vault: conflicts and files that stay behind", () => {
  beforeEach(async () => {
    useNoticeJournalStore.setState(useNoticeJournalStore.getInitialState())
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  const conflict = {
    id: "0123456789ab",
    kind: "bothEdited",
    originalPath: "Заметки/идея.md",
    copyPath: ".amby/conflicts/0123456789ab/other.md",
    createdMs: 1_760_000_000_000,
  }

  it("lists a conflict by the name of the note, with one button and the choice in the comparison", async () => {
    const port = await show(vaultStatus({ conflicts: [conflict] }), {
      readConflictVersions: async () => ({ original: "a", copy: "b", stamp: "s" }),
    })
    const list = await screen.findByTestId("sync-conflicts")
    expect(list.textContent).toMatch(/Конфликты \(1\)/)
    const row = within(list).getAllByRole("listitem")[0]
    expect(row.textContent).toMatch(/«идея» изменили на двух компьютерах/)
    expect(row.textContent).toMatch(/Обе версии целы/)
    expect(row.textContent).not.toMatch(/\.md|conflict|Заметки\//)
    expect(within(row).getAllByRole("button")).toHaveLength(1)
    fireEvent.click(within(row).getByRole("button", { name: "Сравнить" }))
    const dialog = await screen.findByRole("dialog")
    expect(port.resolveConflict).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Оставить версию в заметке" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
  })

  it.each([["Взять вторую версию", "keepCopy"]])(
    "takes “%s” in the comparison as %s",
    async (label, choice) => {
      const port = await show(vaultStatus({ conflicts: [conflict] }), {
        readConflictVersions: async () => ({ original: "a", copy: "b", stamp: "s" }),
      })
      const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
      fireEvent.click(within(row).getByRole("button", { name: "Сравнить" }))
      fireEvent.click(await screen.findByRole("button", { name: label }))
      await waitFor(() => expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", choice))
    },
  )

  it("tells a conflict of the properties of notes in words, with two choices and no paths", async () => {
    const properties = {
      ...conflict,
      originalPath: ".amby/properties.json",
      copyPath: ".amby/conflicts/09d76fd5687f/other.json",
    }
    const port = await show(vaultStatus({ conflicts: [properties] }))
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    expect(row.textContent).toMatch(/Свойства заметок изменили на двух компьютерах/)
    expect(row.textContent).not.toMatch(/\.amby/)
    expect(within(row).queryByRole("button", { name: "Сравнить" })).toBeNull()
    expect(within(row).getAllByRole("button")).toHaveLength(2)
    fireEvent.click(within(row).getByRole("button", { name: "Взять с другого компьютера" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepCopy"),
    )
    expect(screen.getByTestId("sync-conflicts").textContent).toMatch(
      /Правки, сделанные на компьютере/,
    )
  })

  // ----- З69: a conflict of a group of note properties is chosen by notes -----

  const groupConflict = {
    ...conflict,
    originalPath: ".amby/properties/prop_3.jsonl",
    copyPath: ".amby/conflicts/09d76fd5687f/other.jsonl",
    hasBase: true,
  }
  const groupRead = {
    group: {
      notes: [
        {
          noteId: "A",
          notePath: "Папка/Идея.md",
          noteTitle: "Идея",
          changes: [
            {
              name: "Статус",
              current: { icon: "lucide:star", propertyType: "select", settings: null },
              other: null,
            },
          ],
          orderDiffers: true,
          currentRemoved: false,
          otherRemoved: false,
        },
        {
          noteId: "B",
          notePath: null,
          noteTitle: null,
          changes: [],
          orderDiffers: false,
          currentRemoved: false,
          otherRemoved: true,
        },
      ],
      autoMerged: 3,
    },
    stamp: "stamp-g",
  }

  it("lists the conflicting notes of a group and resolves it only when every note is chosen", async () => {
    const resolveGroupConflict = vi.fn(async () => {})
    const port = await show(vaultStatus({ conflicts: [groupConflict] }), {
      readGroupConflict: vi.fn(async () => groupRead),
      resolveGroupConflict,
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    const notes = await within(row).findByTestId("sync-group-notes")
    expect(port.readGroupConflict).toHaveBeenCalledWith("0123456789ab")
    expect(notes.textContent).toMatch(/«Идея»/)
    expect(notes.textContent).toMatch(/Заметка без названия/)
    expect(row.textContent).toMatch(/Остальные изменения \(3\) соединены сами/)
    expect(row.textContent).not.toMatch(/\.amby/)
    expect(within(row).queryByRole("button", { name: "Взять с другого компьютера" })).toBeNull()
    const done = within(row).getByRole("button", { name: "Применить" })
    expect(done).toHaveProperty("disabled", true)
    const [first, second] = within(notes).getAllByRole("radiogroup")
    // each side shows what it keeps: the property, its type, the default look, the removal
    const mine = within(first).getByRole("radio", { name: "Этот компьютер" })
    const theirs = within(first).getByRole("radio", { name: "Другой компьютер" })
    expect(mine.textContent).toMatch(/Статус/)
    expect(mine.textContent).toMatch(/Выбор/)
    expect(mine.textContent).toMatch(/Свой порядок свойств/)
    expect(theirs.textContent).toMatch(/Статус/)
    expect(theirs.textContent).toMatch(/Как по умолчанию/)
    expect(within(second).getByRole("radio", { name: "Другой компьютер" }).textContent).toMatch(
      /Оформление заметки удалено/,
    )
    // the warning about the whole file does not apply to the choice by notes
    expect(screen.queryByText(/пропадут/)).toBeNull()
    fireEvent.click(within(first).getByRole("radio", { name: "Другой компьютер" }))
    expect(done).toHaveProperty("disabled", true)
    fireEvent.click(within(second).getByRole("radio", { name: "Этот компьютер" }))
    expect(
      within(second).getByRole("radio", { name: "Этот компьютер" }).getAttribute("aria-checked"),
    ).toBe("true")
    expect(done).toHaveProperty("disabled", false)
    fireEvent.click(done)
    await waitFor(() =>
      expect(resolveGroupConflict).toHaveBeenCalledWith(
        "0123456789ab",
        { A: "other", B: "current" },
        "stamp-g",
      ),
    )
    expect(port.resolveConflict).not.toHaveBeenCalled()
  })

  it("rereads the notes of a group when the files changed while the person chose", async () => {
    let reads = 0
    const readGroupConflict = vi.fn(async () => {
      reads += 1
      return { ...groupRead, stamp: `stamp-${reads}` }
    })
    const resolveGroupConflict = vi.fn(async () => {
      throw new SyncPortError("conflict_changed")
    })
    await show(vaultStatus({ conflicts: [groupConflict] }), {
      readGroupConflict,
      resolveGroupConflict,
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    const notes = await within(row).findByTestId("sync-group-notes")
    for (const note of within(notes).getAllByRole("radiogroup")) {
      fireEvent.click(within(note).getByRole("radio", { name: "Другой компьютер" }))
    }
    fireEvent.click(within(row).getByRole("button", { name: "Применить" }))
    await waitFor(() => expect(readGroupConflict).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole("alert")).textContent).toMatch(/выбор ещё раз/)
    // the choice starts again on the new versions
    expect(within(row).getByRole("button", { name: "Применить" })).toHaveProperty("disabled", true)
  })

  it("keeps the whole-file choice for a group the app cannot choose by notes", async () => {
    // З69: `conflict_not_group` (no base, an unreadable version): two buttons as before
    const port = await show(vaultStatus({ conflicts: [groupConflict] }), {
      readGroupConflict: vi.fn(async () => {
        throw new SyncPortError("conflict_not_group")
      }),
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    fireEvent.click(await within(row).findByRole("button", { name: "Взять с другого компьютера" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepCopy"),
    )
    expect(within(row).queryByTestId("sync-group-notes")).toBeNull()
  })

  it("does not ask for notes when the group set has no base", async () => {
    const readGroupConflict = vi.fn(async () => groupRead)
    await show(vaultStatus({ conflicts: [{ ...groupConflict, hasBase: false }] }), {
      readGroupConflict,
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    expect(within(row).getByRole("button", { name: "Взять с другого компьютера" })).toBeTruthy()
    expect(readGroupConflict).not.toHaveBeenCalled()
  })

  it("words a conflict of two creations differently", async () => {
    await show(vaultStatus({ conflicts: [{ ...conflict, kind: "bothCreated" }] }))
    const list = await screen.findByTestId("sync-conflicts")
    expect(list.textContent).toMatch(/создали на двух компьютерах/)
  })

  it("writes to the journal after the choice where the replaced version went, and only then", async () => {
    const port = await show(vaultStatus({ conflicts: [conflict] }), {
      readConflictVersions: async () => ({ original: "a", copy: "b", stamp: "s" }),
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    // nothing is promised before the choice
    expect(document.body.textContent).not.toMatch(/истории/)
    fireEvent.click(within(row).getByRole("button", { name: "Сравнить" }))
    fireEvent.click(await screen.findByRole("button", { name: "Взять вторую версию" }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalled())
    // What the choice did is said in the journal of the notification centre, not in this list.
    await waitFor(() =>
      expect(
        useNoticeJournalStore.getState().entries.map((entry) => [entry.kind, entry.params.choice]),
      ).toEqual([["conflictOutcome", "keepCopy"]]),
    )
    expect(screen.queryByTestId("sync-conflict-outcome")).toBeNull()
  })

  it("shows the list as it changes: a resolved conflict leaves it", async () => {
    await show(vaultStatus({ conflicts: [conflict] }))
    await screen.findByTestId("sync-conflicts")
    act(() => emitVaultStatus(vaultStatus({ conflicts: [] })))
    await waitFor(() => expect(screen.queryByTestId("sync-conflicts")).toBeNull())
  })

  it("shows the error when a conflict cannot be resolved", async () => {
    await show(vaultStatus({ conflicts: [conflict] }), {
      resolveConflict: async () => {
        throw new SyncPortError("conflict_not_found")
      },
    })
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    fireEvent.click(within(row).getByRole("button", { name: "Сравнить" }))
    fireEvent.click(await screen.findByRole("button", { name: "Оставить версию в заметке" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/уже нет в списке/)
  })

  it("lists the files that are not synchronised with the reason of each", async () => {
    await show(
      vaultStatus({
        unsynced: [
          { path: "ссылка.md", reason: "symlink", detail: null },
          { path: "a:b.md", reason: "invalidName", detail: "forbiddenChar" },
          { path: "Note.md", reason: "caseCollision", detail: "note.md" },
          { path: "огромный.bin", reason: "tooBigForMemory", detail: null },
          { path: "закрыт.md", reason: "noAccess", detail: null },
          { path: "x", reason: "somethingNew", detail: null },
        ],
      }),
    )
    const list = await screen.findByTestId("sync-unsynced")
    expect(list.textContent).toMatch(/Не синхронизируется \(6\)/)
    const text = list.textContent ?? ""
    expect(text).toMatch(/ссылка\.md/)
    expect(text).toMatch(/Символическая ссылка/)
    expect(text).toMatch(/нельзя создать на этой системе \(недопустимый символ\)/)
    expect(text).toMatch(/Совпадает с «note\.md» без учёта регистра/)
    expect(text).toMatch(/слишком большой для этого компьютера/)
    expect(text).toMatch(/Нет доступа к файлу/)
    expect(text).toMatch(/Причина не распознана/)
  })

  it("does not call an idle pass fully synchronized when files remain unsynced", async () => {
    await show(vaultStatus({ unsynced: [{ path: "large.bin", reason: "tooLarge", detail: null }] }))
    const status = await screen.findByTestId("sync-status")
    expect(status.textContent).toContain("Требуется внимание")
    expect(status.textContent).not.toContain("Всё синхронизировано")
    expect(await screen.findByTestId("sync-unsynced")).toBeTruthy()
  })

  it("shows no lists when there is nothing to show", async () => {
    await show(vaultStatus())
    await screen.findByTestId("sync-status")
    expect(screen.queryByTestId("sync-conflicts")).toBeNull()
    expect(screen.queryByTestId("sync-unsynced")).toBeNull()
  })
})

describe("sync of the open vault: texts", () => {
  it("knows the new codes of the sync of a vault, in Russian and in English", async () => {
    const codes = [
      "space_not_found",
      "invalid_space",
      "no_vault_open",
      "sync_not_running",
      "conflict_not_found",
      "vault_locked",
      "state_error",
      "state_newer",
      "quota_exceeded",
      "blob_too_large",
      "space_exists",
      "backup_failed",
      "backup_unsafe_entry",
      "backup_changed",
      "backup_invalid",
    ]
    for (const code of codes) {
      expect(KNOWN_SYNC_ERROR_CODES, code).toContain(code)
      for (const language of ["ru", "en"]) {
        await i18n.changeLanguage(language)
        const key = syncErrorKey(code)
        expect(key).toBe(`sync.errors.${code}`)
        expect(i18n.exists(key), `${language} ${code}`).toBe(true)
        expect(i18n.t(key)).not.toBe(key)
      }
    }
    expect(KNOWN_SYNC_ERROR_CODES).not.toContain("test_vault_required")
    for (const language of ["ru", "en"]) {
      expect(i18n.exists("sync.errors.test_vault_required", { lng: language })).toBe(false)
      expect(i18n.exists("sync.vault.testWarning", { lng: language })).toBe(false)
      expect(i18n.exists("sync.vault.testVault", { lng: language })).toBe(false)
      expect(i18n.exists("sync.vault.testBadge", { lng: language })).toBe(false)
    }
  })

  it("has the same words in English for the whole screen", async () => {
    await i18n.changeLanguage("en")
    cleanup()
    const port = createFakePort({
      vaultStatus: async () =>
        vaultStatus({
          phase: "stopped",
          stop: { kind: "serverReset" },
          conflicts: [
            {
              id: "0123456789ab",
              kind: "bothEdited",
              originalPath: "a.md",
              copyPath: "a.0123456789ab-conflict.md",
              createdMs: 1,
            },
          ],
          unsynced: [{ path: "x", reason: "noAccess", detail: null }],
        }),
    })
    render(<SyncVaultPanel port={port} />)
    const stop = await screen.findByTestId("sync-stop")
    expect(stop.textContent).toMatch(/reset/i)
    expect(screen.getByTestId("sync-conflicts").textContent).toMatch(/Conflicts \(1\)/)
    expect(screen.getByTestId("sync-unsynced").textContent).toMatch(/Not synchronised \(1\)/)
    expect(document.body.textContent).not.toMatch(/sync\.vault\./)
    await i18n.changeLanguage("ru")
    cleanup()
  })
})
