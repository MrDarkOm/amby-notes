// @vitest-environment happy-dom
// The sync of the open vault (docs/sync-plan.md, stage Э4): behaviour only — what the person sees
// and what the screen asks of the application. How it looks is checked in a native window.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  it("warns that real notes are not allowed yet and asks to mark a test vault", async () => {
    // the gate of stage Э4: only a vault marked as a test vault, and the screen says why
    await show({ ...VAULT_OFF, gateClosed: true })
    const warning = await screen.findByTestId("sync-test-warning")
    expect(warning.getAttribute("role")).toBe("note")
    expect(warning.textContent).toMatch(/экспериментальн/i)
    expect(warning.textContent).toMatch(/тестов/i)
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(true)
  })

  it("switches on a new space once the vault is marked as a test vault", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true })
    fireEvent.click(await screen.findByTestId("sync-test-vault"))
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, true),
    )
  })

  it("sends the name the person typed", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true })
    fireEvent.change(await screen.findByLabelText("Название"), {
      target: { value: "  Мои заметки " },
    })
    fireEvent.click(screen.getByTestId("sync-test-vault"))
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "Мои заметки" }, true),
    )
  })

  it("does not demand the test mark when the gate is open", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: false })
    await screen.findByRole("button", { name: "Включить синхронизацию" })
    expect(screen.queryByTestId("sync-test-warning")).toBeNull()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith({ kind: "new", name: "" }, false),
    )
  })

  it("lists the spaces of the account to connect an existing one", async () => {
    const port = await show({ ...VAULT_OFF, gateClosed: true })
    fireEvent.click(await screen.findByRole("radio", { name: /Подключить существующее/ }))
    await waitFor(() => expect(port.listSpaces).toHaveBeenCalled())
    const first = await screen.findByRole("radio", { name: /Рабочее/ })
    expect(screen.getByRole("radio", { name: /Без названия/ })).toBeTruthy()
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(true)
    fireEvent.click(first)
    fireEvent.click(screen.getByTestId("sync-test-vault"))
    click("Включить синхронизацию")
    await waitFor(() =>
      expect(port.enableVault).toHaveBeenCalledWith(
        { kind: "existing", spaceId: SPACES[0].spaceId },
        true,
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
          throw new SyncPortError("test_vault_required")
        },
      },
    )
    fireEvent.click(await screen.findByTestId("sync-test-vault"))
    click("Включить синхронизацию")
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/тестов/i)
    expect(button("Включить синхронизацию").hasAttribute("disabled")).toBe(false)
    expect(port.enableVault).toHaveBeenCalledTimes(1)
  })

  it("does not switch on twice while the first request is running", async () => {
    let release: (status: VaultSyncStatus) => void = () => {}
    const port = await show(
      { ...VAULT_OFF },
      { enableVault: () => new Promise<VaultSyncStatus>((resolve) => (release = resolve)) },
    )
    fireEvent.click(await screen.findByTestId("sync-test-vault"))
    click("Включить синхронизацию")
    click("Включить синхронизацию")
    expect(port.enableVault).toHaveBeenCalledTimes(1)
    await act(async () => release(vaultStatus()))
    await screen.findByTestId("sync-status")
  })

  it("offers to switch a linked vault on again without choosing a space", async () => {
    const port = await show(vaultStatus({ enabled: false, phase: "off", linked: true }))
    expect(await screen.findByText(/Синхронизация выключена/)).toBeTruthy()
    expect(screen.queryByLabelText("Название")).toBeNull()
    click("Включить снова")
    await waitFor(() => expect(port.enableVault).toHaveBeenCalled())
  })
})

describe("sync of the open vault: the status", () => {
  beforeEach(async () => {
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

  it("marks a test vault", async () => {
    await show(vaultStatus({ testVault: true }))
    expect((await screen.findByTestId("sync-vault")).textContent).toMatch(/Тестовое хранилище/)
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

  it("switches off only after a confirmation", async () => {
    const port = await show(vaultStatus())
    click("Выключить синхронизацию")
    expect(port.disableVault).not.toHaveBeenCalled()
    click("Отмена")
    expect(port.disableVault).not.toHaveBeenCalled()
    click("Выключить синхронизацию")
    click("Да, выключить")
    await waitFor(() => expect(port.disableVault).toHaveBeenCalledTimes(1))
  })
})

describe("sync of the open vault: the stops of Р8", () => {
  beforeEach(async () => {
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
    await i18n.changeLanguage("ru")
  })
  afterEach(cleanup)

  const conflict = {
    id: "0123456789ab",
    kind: "bothEdited",
    originalPath: "Заметки/идея.md",
    copyPath: "Заметки/идея.0123456789ab-conflict.md",
    createdMs: 1_760_000_000_000,
  }

  it("lists a conflict with both files and three ways to resolve it", async () => {
    const port = await show(vaultStatus({ conflicts: [conflict] }))
    const list = await screen.findByTestId("sync-conflicts")
    expect(list.textContent).toMatch(/Конфликты \(1\)/)
    const row = within(list).getAllByRole("listitem")[0]
    expect(row.textContent).toMatch(/Заметки\/идея\.md/)
    expect(row.textContent).toMatch(/идея\.0123456789ab-conflict\.md/)
    expect(row.textContent).toMatch(/изменили на двух компьютерах/)
    fireEvent.click(within(row).getByRole("button", { name: "Оставить основной файл" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepOriginal"),
    )
    fireEvent.click(within(row).getByRole("button", { name: "Заменить копией" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepCopy"),
    )
    fireEvent.click(within(row).getByRole("button", { name: "Оставить оба" }))
    await waitFor(() =>
      expect(port.resolveConflict).toHaveBeenCalledWith("0123456789ab", "keepBoth"),
    )
  })

  it("words a conflict of two creations differently", async () => {
    await show(vaultStatus({ conflicts: [{ ...conflict, kind: "bothCreated" }] }))
    const list = await screen.findByTestId("sync-conflicts")
    expect(list.textContent).toMatch(/создали на двух компьютерах/)
  })

  it("replaces a replaced file only after a confirmation that names the file", async () => {
    // "Заменить копией" overwrites the file with the copy: the person has to mean it
    const port = await show(vaultStatus({ conflicts: [conflict] }))
    const row = within(await screen.findByTestId("sync-conflicts")).getAllByRole("listitem")[0]
    fireEvent.click(within(row).getByRole("button", { name: "Заменить копией" }))
    await waitFor(() => expect(port.resolveConflict).toHaveBeenCalled())
    // The replaced version stays in the history: the screen says where to find it.
    expect(document.body.textContent).toMatch(/истории/)
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
    fireEvent.click(within(row).getByRole("button", { name: "Оставить оба" }))
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
      "test_vault_required",
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
