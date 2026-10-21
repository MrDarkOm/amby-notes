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
import { SyncSettings } from "@/components/workspace/sync/sync-settings"
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

const PASSWORD = "correct horse battery staple 42"
const NEW_PASSWORD = "an entirely different password about owls 77"
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

async function step(name: string, run: () => Promise<void>) {
  try {
    await run()
    results.push({ name, passed: true })
  } catch (error) {
    results.push({ name, passed: false, error: String(error) })
    throw error
  }
}

async function checkServer() {
  await waitFor("the server field", () => field("Адрес сервера"))
  type("Адрес сервера", config.url!)
  await press("Проверить сервер")
  await waitFor("the server to be found", () => text().includes("Сервер найден"))
}

async function readCode(): Promise<string> {
  const node = await waitFor("the recovery code", () =>
    document.querySelector('[data-testid="recovery-code"]'),
  )
  return node.textContent!.trim()
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <SyncSettings port={port} />
    </div>
  </React.StrictMode>,
)

let recoveryCode = ""
try {
  if (!config?.url || !config.username || !config.enrollCode)
    throw new Error("The server, the user and the invitation code come from the environment")

  await step("the screen starts with the server step and the honest banner", async () => {
    await waitFor("the server field", () => field("Адрес сервера"))
    if (!text().includes("Заметки пока не синхронизируются")) throw new Error("no banner")
  })

  await step("a server that is not there is reported, a good one is found", async () => {
    type("Адрес сервера", "http://127.0.0.1:1")
    await press("Проверить сервер")
    await waitFor("a network error", () => text().includes("Не удалось связаться с сервером"))
    type("Адрес сервера", "http://example.com")
    await press("Проверить сервер")
    await waitFor("the https rule", () => text().includes("https://"))
    await checkServer()
  })

  await step("a weak password is not accepted, a strong one is", async () => {
    await press("Создать учётную запись")
    type("Имя пользователя", config.username!)
    type("Код приглашения", config.enrollCode!)
    type("Пароль", "password12345678")
    type("Повторите пароль", "password12345678")
    await waitFor("a weak verdict", () => text().includes("Слабый пароль"))
    if (!button("Продолжить")!.disabled) throw new Error("Continue must be disabled")
    type("Пароль", PASSWORD)
    type("Повторите пароль", PASSWORD)
    await waitFor("a good verdict", () => /Отличный пароль|Хороший пароль/.test(text()))
  })

  await step("the recovery code is shown and cannot be skipped", async () => {
    await press("Продолжить")
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
    await waitFor("the wizard", () => field("Адрес сервера"))
    const status = await port.status()
    if (status.connected || status.keysMissing) throw new Error("still connected")
  })

  await step("a wrong password is told apart and the right one signs in", async () => {
    await checkServer()
    await press("Войти")
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
    await waitFor("the wizard", () => field("Адрес сервера"))
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
    await waitFor("the wizard", () => field("Адрес сервера"))
    await checkServer()
    await press("Войти")
    type("Имя пользователя", config.username!)
    type("Пароль", PASSWORD)
    await press("Войти")
    await waitFor("invalid credentials", () => text().includes("Неверное имя пользователя, пароль"))
    type("Пароль", NEW_PASSWORD)
    await press("Войти")
    await waitFor("the connection", () => /Подключено к/.test(text()))
    await waitFor("one device", () => text().includes("Это устройство"))
  })

  await step("the final sign-out leaves nothing behind", async () => {
    await press("Выйти на этом устройстве")
    await waitFor("the wizard", () => field("Адрес сервера"))
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
