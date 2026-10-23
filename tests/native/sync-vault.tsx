// Native check of the sync of a vault (docs/sync-plan.md, Э4): two real windows of the application,
// two computers, one server. Each process plays one role (A or B): real React screen, real IPC, real
// Rust (engine, session, SQLite state, watcher), a real server. The roles talk only through the
// synchronisation itself: a file that B creates in its vault is what tells A that B got the vault.
// Not part of `npm run verify`: it needs a server (see scripts/run-native-sync-vault.mjs).
import React from "react"
import ReactDOM from "react-dom/client"
import { listen } from "@tauri-apps/api/event"
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
  role: string | null
  password: string | null
  spaceName: string | null
}
const root = (window as unknown as { __AMBY_NATIVE_TEST_ROOT__: string }).__AMBY_NATIVE_TEST_ROOT__
const config = (window as unknown as { __AMBY_NATIVE_SYNC__: Config }).__AMBY_NATIVE_SYNC__
if (!root || !("__TAURI_INTERNALS__" in window))
  throw new Error("A real native test runtime is required")

const results: Array<{ name: string; passed: boolean; error?: string }> = []
const port = createDesktopSyncPort()
const adapter = new DesktopAdapter()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const text = () => document.body.innerText

// What the notes say: Russian, a long enough text. (The commands that write and read a file in the
// application normalise line endings, so byte-exact CRLF and BOM are checked by the Rust tests of
// the ports, not here.)
const ONE = "# Первая заметка\nТекст первой заметки, которая идёт между компьютерами.\n"
const TWO = "Вторая заметка, которую потом удалят\n"
const EDITED = "# Первая заметка\nПравка на втором компьютере\n"

async function waitFor<T>(what: string, find: () => T | null | undefined | false, ms = 90000) {
  const started = Date.now()
  for (;;) {
    const found = find()
    if (found) return found as T
    if (Date.now() - started > ms)
      throw new Error(`Timed out waiting for ${what}. Page text: ${text().slice(0, 700)}`)
    await sleep(100)
  }
}

async function waitForAsync<T>(
  what: string,
  find: () => Promise<T | null | undefined | false>,
  ms = 90000,
): Promise<T> {
  const started = Date.now()
  for (;;) {
    const found = await find().catch(() => null)
    if (found) return found as T
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`)
    await sleep(150)
  }
}

function button(name: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").trim() === name,
    ) as HTMLButtonElement | undefined) ?? null
  )
}

async function press(name: string) {
  const target = await waitFor(`button "${name}"`, () => {
    const found = button(name)
    return found && !found.disabled ? found : null
  })
  target.click()
}

function radio(label: RegExp): HTMLInputElement | null {
  const found = [...document.querySelectorAll("label")].find((l) => label.test(l.textContent ?? ""))
  return (found?.querySelector('input[type="radio"]') as HTMLInputElement | null) ?? null
}

/** What the sync of this vault says now: shown with a failure, so that it can be understood. */
async function diagnose(): Promise<string> {
  try {
    return JSON.stringify(await port.vaultStatus())
  } catch (error) {
    return `no status: ${String(error)}`
  }
}

async function step(name: string, run: () => Promise<void>) {
  try {
    await run()
    results.push({ name, passed: true })
  } catch (error) {
    results.push({ name, passed: false, error: `${String(error)}\nstatus: ${await diagnose()}` })
    throw error
  }
}

/** Waits until the file holds `expected`; a different content is told in full. */
async function expectFile(path: string, expected: string, what: string) {
  const started = Date.now()
  for (;;) {
    const last = await readOrNull(path)
    if (last === expected) return
    if (Date.now() - started > 90000)
      throw new Error(
        `${what}: expected ${JSON.stringify(expected)}, found ${last === null ? "nothing" : JSON.stringify(last)}`,
      )
    await sleep(150)
  }
}

const readOrNull = async (path: string) => {
  try {
    return await adapter.readFile(path)
  } catch {
    return null
  }
}

async function connect(isFirst: boolean) {
  const base = { url: config.url!, allowHttp: true }
  await port.checkServer(base)
  if (isFirst) {
    const view = await port.prepareAccount({
      ...base,
      username: config.username!,
      enrollCode: config.enrollCode!,
      password: config.password!,
      deviceName: "Компьютер A",
    })
    const groups = view.recoveryCode.split("-")
    await port.confirmRecoveryCode(view.confirmGroups.map((position) => groups[position - 1]))
  } else {
    await port.signIn({
      ...base,
      username: config.username!,
      password: config.password!,
      deviceName: "Компьютер B",
    })
  }
}

const heard: string[] = []

async function openVault(name: string): Promise<string> {
  await adapter.loadVaultData(root)
  const vault = await adapter.createFolder(root, name)
  await adapter.loadVaultData(vault)
  // The watcher is what starts the sync of a vault that was switched on (as the workspace does).
  await adapter.startVaultWatcher(vault)
  return vault
}

function mountSettings() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
        <SyncSettings port={port} />
      </div>
    </React.StrictMode>,
  )
}

async function untilIdle(what: string) {
  await waitForAsync(what, async () => {
    const status = await port.vaultStatus()
    return status.enabled && status.phase === "idle" && status.lastSyncMs !== null
  })
}

/**
 * Waits for a pass that ended after `since` and sent something: the change made at `since` is on
 * the server. (An older "idle" state does not count, and a pass that found nothing does not.)
 */
async function untilSentSince(since: number, what: string) {
  await waitForAsync(what, async () => {
    const status = await port.vaultStatus()
    return (
      status.enabled &&
      status.phase === "idle" &&
      status.lastSyncMs !== null &&
      status.lastSyncMs > since &&
      (status.last?.uploaded ?? 0) >= 1
    )
  })
}

async function run() {
  const first = config.role === "a"
  const unlisten = await listen<{ kind: string; path: string }>("vault-file-changed", (event) => {
    heard.push(event.payload.path)
  })
  void unlisten
  await step("this computer signs in to the account", () => connect(first))

  let vault = ""
  await step("a vault is opened and, on A, filled with notes", async () => {
    vault = await openVault(first ? "vault-a" : "vault-b")
    if (first) {
      await adapter.createFolder(vault, "Notes")
      await adapter.writeFile(joinStoragePath(vault, "Notes/one.md"), ONE)
      await adapter.writeFile(joinStoragePath(vault, "Notes/two.md"), TWO)
    }
  })

  mountSettings()
  await waitFor("the section of the vault", () =>
    document.querySelector('[data-testid="sync-vault"]'),
  )

  await step("the screen warns about the test mode and demands the test mark", async () => {
    await waitFor("the warning", () => document.querySelector('[data-testid="sync-test-warning"]'))
    const enable = await waitFor("the enable button", () => button("Включить синхронизацию"))
    if (!enable.disabled) throw new Error("the button must wait for the test mark")
  })

  if (!first) {
    await step("B finds the space of A on the server by its name", async () => {
      await waitForAsync("the shared space", async () => {
        const spaces = await port.listSpaces()
        return spaces.some((space) => space.name === config.spaceName)
      })
      const choice = await waitFor("the option to connect", () => radio(/Подключить существующее/))
      choice.click()
      const space = await waitFor("the space in the list", () =>
        radio(new RegExp((config.spaceName ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
      )
      space.click()
    })
  } else {
    await step("A names the new space", async () => {
      const label = [...document.querySelectorAll("label")].find(
        (l) => l.textContent?.trim() === "Название",
      )
      const input = document.getElementById(label!.htmlFor) as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(input, config.spaceName!)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  await step("the vault is switched on with the test mark", async () => {
    ;(document.querySelector('[data-testid="sync-test-vault"]') as HTMLInputElement).click()
    await press("Включить синхронизацию")
    await waitFor("the status", () => document.querySelector('[data-testid="sync-status"]'))
    await untilIdle("the first pass")
    const status = await port.vaultStatus()
    if (!status.testVault) throw new Error("the test mark was lost")
    if (status.spaceName !== config.spaceName) throw new Error(`name: ${status.spaceName}`)
  })

  if (first) {
    await step("the first pass uploaded the notes of A", async () => {
      // The vault has two notes; the pass that follows switching on must have sent them.
      await waitForAsync("two uploads", async () => {
        const status = await port.vaultStatus()
        return (status.last?.uploaded ?? 0) >= 2 || status.itemErrors > 0 ? status : null
      })
      const status = await port.vaultStatus()
      if ((status.last?.uploaded ?? 0) < 2) throw new Error(`uploaded ${status.last?.uploaded}`)
    })
  }

  if (first) {
    await step("what B edits and creates arrives; the arrival is an external change", async () => {
      await waitForAsync(
        "the file of B",
        async () => (await readOrNull(joinStoragePath(vault, "from-b.md"))) !== null,
      )
      await expectFile(joinStoragePath(vault, "Notes/one.md"), EDITED, "the edit of B")
      if (!heard.some((path) => path.endsWith("from-b.md")))
        throw new Error(`the editor would not hear of the file of B: ${heard.join(", ")}`)
      if (!heard.some((path) => path.endsWith("Notes/one.md")))
        throw new Error("the editor would not hear of the edit of B")
    })

    await step("the version replaced by the edit of B is in the history", async () => {
      const snapshots = await adapter.listSnapshots(joinStoragePath(vault, "Notes/one.md"))
      const replaced = snapshots.find((entry) => entry.reason === "sync-overwrite")
      if (!replaced) throw new Error(`no sync-overwrite snapshot: ${JSON.stringify(snapshots)}`)
      const body = await adapter.readSnapshotText(replaced.id)
      if (body.content !== ONE) throw new Error("the snapshot is not the replaced version")
    })

    await step("a note deleted here goes to the trash of the other computer", async () => {
      await adapter.deleteItem(vault, joinStoragePath(vault, "Notes/two.md"), "permanent")
      await waitForAsync(
        "the answer of B",
        async () => (await readOrNull(joinStoragePath(vault, "b-saw-delete.md"))) !== null,
      )
    })
  } else {
    await step("the vault of A arrives with the same text", async () => {
      await expectFile(joinStoragePath(vault, "Notes/one.md"), ONE, "one.md")
      await expectFile(joinStoragePath(vault, "Notes/two.md"), TWO, "two.md")
      if (!heard.some((path) => path.endsWith("Notes/one.md")))
        throw new Error("the arrival of a file was hidden from the watcher")
    })

    await step("an edit and a new note go to A without a button", async () => {
      const since = Date.now()
      await adapter.writeFile(joinStoragePath(vault, "Notes/one.md"), EDITED)
      await adapter.writeFile(joinStoragePath(vault, "from-b.md"), "B has the vault\n")
      await untilSentSince(since, "the pass after the edit")
    })

    await step("a deletion from A goes to the trash of the vault of B", async () => {
      await waitForAsync(
        "the deletion",
        async () => (await readOrNull(joinStoragePath(vault, "Notes/two.md"))) === null,
      )
      const trash = await adapter.listTrash()
      if (!trash.some((entry) => entry.originalPath === "Notes/two.md"))
        throw new Error(`not in the trash: ${JSON.stringify(trash)}`)
      const since = Date.now()
      await adapter.writeFile(joinStoragePath(vault, "b-saw-delete.md"), "seen\n")
      await untilSentSince(since, "the last pass")
    })
  }

  await step("the screen ends calm: synchronised, nothing in the lists", async () => {
    await waitFor("synchronised", () => /Всё синхронизировано/.test(text()))
    const status = await port.vaultStatus()
    if (status.conflicts.length > 0)
      throw new Error(`conflicts: ${JSON.stringify(status.conflicts)}`)
    if (status.stop) throw new Error(`a stop: ${JSON.stringify(status.stop)}`)
  })

  await step("switching off stops the sync and keeps the link", async () => {
    await press("Выключить синхронизацию")
    await press("Да, выключить")
    await waitFor("the off state", () => /Синхронизация выключена/.test(text()))
    const status = await port.vaultStatus()
    if (status.enabled || !status.linked) throw new Error("the link must stay")
  })
}

try {
  if (!config?.url || !config.username || !config.role || !config.password)
    throw new Error("The server, the user, the role and the password come from the environment")
  await run()
} catch (error) {
  if (results.every((r) => r.passed))
    results.push({ name: "harness", passed: false, error: String(error) })
}

const report = JSON.stringify({
  role: config?.role,
  passed: results.every((r) => r.passed),
  results,
})
document.getElementById("result")!.textContent = report
await adapter.loadVaultData(root)
await adapter.writeFile(joinStoragePath(root, "result.json"), report)
