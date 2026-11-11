// Native check of the sync connect screen (docs/sync-plan.md, Э4): the real React screen with the
// real desktop port, the real IPC and the real Rust side, against a real server (a container).
// It is driven through the DOM like a person would: typing into fields and clicking buttons.
// Not part of `npm run verify`: it needs a server (see scripts/run-native-sync.mjs).
import React from "react"
import ReactDOM from "react-dom/client"
import "@/lib/i18n"
import "@/themes/app.css"
import { DesktopAdapter } from "../../src/lib/storage/desktop-adapter"
import { joinStoragePath } from "../../src/lib/storage/storage-path"
import { SettingsDialog } from "@/components/workspace/settings-dialog"
import { createDesktopSyncPort } from "@/lib/sync/sync-port"

interface Config {
  url: string | null
  username: string | null
  enrollCode: string | null
}
const root = (window as unknown as { __AMBY_NATIVE_TEST_ROOT__: string }).__AMBY_NATIVE_TEST_ROOT__
const config = (window as unknown as { __AMBY_NATIVE_SYNC__: Config }).__AMBY_NATIVE_SYNC__
if (!root || !("__TAURI_INTERNALS__" in window))
  throw new Error("A real native test runtime is required")

const PASSWORD = "Correct horse battery staple 42!"
const NEW_PASSWORD = "An entirely different password about owls 77!"
const results: Array<{ name: string; passed: boolean; error?: string }> = []
const port = createDesktopSyncPort()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(what: string, find: () => T | null | undefined | false, ms = 20000) {
  const started = Date.now()
  for (;;) {
    const found = find()
    if (found) return found as T
    if (Date.now() - started > ms)
      throw new Error(
        `Timed out waiting for ${what}. Page text: ${document.body.innerText.slice(0, 600)}`,
      )
    await sleep(50)
  }
}

const text = () => document.body.innerText

function field(label: string): HTMLInputElement | null {
  const found = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)
  return found?.htmlFor ? (document.getElementById(found.htmlFor) as HTMLInputElement | null) : null
}

/** The shared server selector: Amby is the default and has no address field. */
function serverChoice(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[role="combobox"]')
}

async function chooseOwnServer() {
  const select = await waitFor("the server selector", () => serverChoice())
  select.click()
  const own = await waitFor("the own server option", () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === "Свой сервер",
    ),
  )
  own.click()
  await waitFor("the server field", () => field("Адрес сервера"))
}

function button(name: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name,
    ) as HTMLButtonElement | undefined) ?? null
  )
}

function type(label: string, value: string) {
  const input = field(label)
  if (!input) throw new Error(`No field "${label}"`)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

async function press(name: string) {
  const target = await waitFor(`button "${name}"`, () => {
    const found = button(name)
    return found && !found.disabled ? found : null
  })
  target.click()
}

const progressAdapter = new DesktopAdapter()
let progressReady = false
async function step(name: string, run: () => Promise<void>) {
  try {
    if (!progressReady) {
      await progressAdapter.loadVaultData(root)
      progressReady = true
    }
    await progressAdapter.writeFile(
      joinStoragePath(root, "progress.json"),
      JSON.stringify({ running: name, completed: results }),
    )
    await run()
    results.push({ name, passed: true })
  } catch (error) {
    results.push({ name, passed: false, error: String(error) })
    throw error
  }
}

async function checkServer() {
  await chooseOwnServer()
  type("Адрес сервера", config.url!)
  await waitFor("the server to be found", () => text().includes("Сервер доступен"))
}

async function readCode(): Promise<string> {
  const node = await waitFor("the recovery code", () =>
    document.querySelector('[data-testid="recovery-code"]'),
  )
  return node.textContent!.trim()
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsDialog
      open
      standalone
      vault={null}
      activeModules={[]}
      navigationTarget={{ section: "sync" }}
      onOpenChange={() => {}}
      onModuleEnabledChange={() => {}}
    />
  </React.StrictMode>,
)

let recoveryCode = ""
try {
  if (!config?.url || !config.username || config.enrollCode === null)
    throw new Error("The server, user and invitation mode come from the environment")

  await step("the full settings window shows authentication and server selection", async () => {
    await chooseOwnServer()
    if (text().includes("в тестовом режиме")) throw new Error("obsolete banner is shown")
  })

  await step("a server that is not there is reported, a good one is found", async () => {
    type("Адрес сервера", "http://127.0.0.1:1")
    await waitFor("a network error", () => text().includes("Не удалось связаться с сервером"))
    type("Адрес сервера", "http://example.com")
    await waitFor("the https rule", () => text().includes("https://"))
    await checkServer()
  })

  await step("a weak password is not accepted, a strong one is", async () => {
    await press("Регистрация")
    type("Имя пользователя", config.username!)
    if (config.enrollCode) {
      const invitation = [...document.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === "У меня есть код приглашения")
        ?.querySelector<HTMLInputElement>("input")
      invitation?.click()
      type("Код приглашения", config.enrollCode)
    } else if (field("Код приглашения")) {
      throw new Error("An open server must not ask for an invitation")
    }
    type("Пароль", "password12345678")
    type("Повторите пароль", "password12345678")
    await waitFor("a weak verdict", () => text().includes("Нужно: заглавная буква, спецсимвол"))
    if (!button("Зарегистрироваться")!.disabled) throw new Error("Continue must be disabled")
    type("Пароль", PASSWORD)
    type("Повторите пароль", PASSWORD)
    await waitFor("a good verdict", () => /Отличный пароль|Хороший пароль/.test(text()))
  })

  await step("the recovery code is shown and cannot be skipped", async () => {
    await press("Зарегистрироваться")
    recoveryCode = await readCode()
    if (recoveryCode.split("-").length !== 14) throw new Error(`Not 14 groups: ${recoveryCode}`)
    if (!/не вернёт никто/.test(text())) throw new Error("no honest warning")
    if (!button("Подтвердить и подключиться")!.disabled)
      throw new Error("Confirm must wait for groups")
    const status = await port.status()
    if (status.connected || !status.pending) throw new Error("nothing is created before the code")
  })

  await step("wrong groups are refused, the right ones connect", async () => {
    const labels = [...document.querySelectorAll("label")]
      .map((l) => l.textContent?.trim() ?? "")
      .filter((t) => /^Группа \d+$/.test(t))
    const positions = labels.map((t) => Number(t.split(" ")[1]))
    if (positions.length !== 2) throw new Error(`Two groups expected, got ${labels.join()}`)
    const groups = recoveryCode.split("-")
    type(labels[0], "ZZZZ")
    type(labels[1], "ZZZZ")
    await press("Подтвердить и подключиться")
    await waitFor("a mismatch", () => text().includes("не совпадают с кодом"))
    type(labels[0], groups[positions[0] - 1].toLowerCase())
    type(labels[1], groups[positions[1] - 1])
    await press("Подтвердить и подключиться")
    await waitFor("the connection", () => /Подключено к/.test(text()))
    await waitFor("this device in the list", () => text().includes("Это устройство"))
    if (text().includes(recoveryCode.slice(0, 9)))
      throw new Error("the code is still on the screen")
  })

  await step("the status comes from the application and holds no secret", async () => {
    const status = await port.status()
    if (!status.connected || status.username !== config.username) throw new Error("bad status")
    if (JSON.stringify(status).includes(PASSWORD)) throw new Error("password in the status")
  })

  await step("signing out empties the device and returns the wizard", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => serverChoice())
    const status = await port.status()
    if (status.connected || status.keysMissing) throw new Error("still connected")
  })

  await step("a wrong password is told apart and the right one signs in", async () => {
    await checkServer()
    type("Имя пользователя", config.username!)
    type("Пароль", "not the password at all")
    await press("Войти")
    await waitFor("invalid credentials", () => text().includes("Неверное имя пользователя, пароль"))
    type("Пароль", PASSWORD)
    await press("Войти")
    await waitFor("the connection", () => /Подключено к/.test(text()))
  })

  await step("the forgotten password is replaced by the recovery code", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => serverChoice())
    await checkServer()
    await press("Забыли пароль?")
    type("Имя пользователя", config.username!)
    type("Код восстановления", recoveryCode.toLowerCase().split("-").join(" "))
    type("Новый пароль", NEW_PASSWORD)
    type("Повторите новый пароль", NEW_PASSWORD)
    await waitFor("a good verdict", () => /Отличный пароль|Хороший пароль/.test(text()))
    await press("Восстановить доступ")
    await waitFor("the connection", () => /Подключено к/.test(text()))
  })

  await step("after recovery the old password is refused and the new one works", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => serverChoice())
    await checkServer()
    type("Имя пользователя", config.username!)
    type("Пароль", PASSWORD)
    await press("Войти")
    await waitFor("invalid credentials", () => text().includes("Неверное имя пользователя, пароль"))
    type("Пароль", NEW_PASSWORD)
    await press("Войти")
    await waitFor("the connection", () => /Подключено к/.test(text()))
    await waitFor("one device", () => text().includes("Это устройство"))
  })

  await step("the current device can be renamed without replacing its session", async () => {
    const current = (await port.listDevices()).find((device) => device.current)!
    const before = await port.status()
    await press(`Переименовать устройство «${current.name}»`)
    type("Имя устройства", "Mac native renamed")
    await press("Сохранить")
    await waitFor(
      "the updated device name",
      () => text().includes("Mac native renamed") && !field("Имя устройства"),
    )
    const after = await port.status()
    if (after.deviceId !== before.deviceId || !after.connected)
      throw new Error("device identity was replaced")
  })

  const renamedUsername = `${config.username}-renamed`
  await step("the account login can be renamed with the current password", async () => {
    await press("Изменить имя аккаунта")
    type("Новое имя пользователя", renamedUsername)
    type("Текущий пароль", NEW_PASSWORD)
    await press("Сохранить")
    await waitFor(
      "the updated account name",
      () => text().includes(renamedUsername) && !field("Текущий пароль"),
    )
    const status = await port.status()
    if (!status.connected || status.username !== renamedUsername)
      throw new Error("account rename did not persist")
  })

  await step("the new account name signs in with the existing password", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => serverChoice())
    await checkServer()
    type("Имя пользователя", renamedUsername)
    type("Пароль", NEW_PASSWORD)
    await press("Войти")
    await waitFor(
      "the renamed connection",
      () => /Подключено к/.test(text()) && text().includes(renamedUsername),
    )
  })

  await step("the final sign-out leaves nothing behind", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => serverChoice())
    const status = await port.status()
    if (status.connected || status.username) throw new Error("a record is left")
  })
} catch (error) {
  if (results.every((r) => r.passed))
    results.push({ name: "harness", passed: false, error: String(error) })
}

const report = JSON.stringify({ passed: results.every((r) => r.passed), results })
document.getElementById("result")!.textContent = report
const adapter = new DesktopAdapter()
await adapter.loadVaultData(root)
await adapter.writeFile(joinStoragePath(root, "result.json"), report)
