import { expect, type Locator, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"

// The browser build starts in Russian; labels are read from the same table the app uses.
export const labels = localeResources.ru.translation.docEditor

/** React StrictMode in the dev server runs every mount effect twice; the bundle does not. */
export const EDITORS_PER_MOUNT = process.env.AMBY_E2E_DEV === "1" ? 2 : 1

const VAULT = "web-vault"
const fileKey = (name: string) => `amby:file:${VAULT}/${name}.md`

/** Fills the localStorage vault before the app starts. Runs once per browser context. */
export async function seedVault(page: Page, notes: Record<string, string>) {
  // Nothing outside the dev server is ever fetched (fixture image addresses included).
  await page.route(
    (url) => url.hostname !== "localhost",
    (route) => route.abort(),
  )
  const tree = Object.keys(notes).map((name) => ({
    id: `${VAULT}/${name}.md`,
    path: `${VAULT}/${name}.md`,
    name,
    type: "file",
    icon: "file",
  }))
  const files = Object.fromEntries(Object.entries(notes).map(([name, md]) => [fileKey(name), md]))
  await page.addInitScript(
    ({ tree, files }) => {
      if (localStorage.getItem("amby:e2e-seeded")) return
      localStorage.setItem("amby:e2e-seeded", "1")
      localStorage.setItem("amby:tree", JSON.stringify(tree))
      for (const [key, value] of Object.entries(files)) localStorage.setItem(key, value)
    },
    { tree, files },
  )
  await page.goto("/")
}

export async function openNote(page: Page, name: string) {
  await page.getByRole("tree").getByRole("treeitem").getByText(name, { exact: true }).click()
}

export const liveEditor = (page: Page): Locator => page.locator(".ProseMirror").first()
export const sourceEditor = (page: Page): Locator => page.locator(".cm-editor").first()

export function storedMarkdown(page: Page, name: string): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), fileKey(name))
}

/**
 * The watchdog: a page whose main thread is stuck (an endless redraw, a runaway loop)
 * cannot answer even this. Playwright alone would wait for its own long timeout.
 */
export async function expectResponsive(page: Page, withinMs = 5_000) {
  const answer = await Promise.race([
    page.evaluate(() => 1 + 1),
    new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), withinMs)),
  ])
  expect(answer, `the page did not answer within ${withinMs} ms`).toBe(2)
}

/** The editor must stop touching its DOM once a note is shown: no redraw loop. */
export async function expectEditorSettles(page: Page) {
  const mutations = await Promise.race([
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const root = document.querySelector(".ProseMirror")
          if (!root) return resolve(-1)
          let count = 0
          const observer = new MutationObserver((records) => (count += records.length))
          observer.observe(root, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          })
          setTimeout(() => {
            observer.disconnect()
            resolve(count)
          }, 700)
        }),
    ),
    new Promise<number>((resolve) => setTimeout(() => resolve(Number.POSITIVE_INFINITY), 6_000)),
  ])
  expect(mutations, "the editor keeps redrawing an idle note").toBeLessThan(10)
  expect(mutations).toBeGreaterThanOrEqual(0)
}

/** Opens a note and checks it reached Live Preview with a live main thread. */
export async function openInLive(page: Page, name: string) {
  await openNote(page, name)
  await expectResponsive(page)
  await expect(liveEditor(page)).toBeVisible()
  await expect(sourceEditor(page)).toHaveCount(0)
  await expectEditorSettles(page)
  await expectResponsive(page)
}

export async function switchMode(page: Page, mode: "live" | "source") {
  await page.getByRole("button", { name: labels.moreActions, exact: true }).click()
  await page
    .getByRole("menuitem", { name: mode === "live" ? labels.viewLive : labels.viewSource })
    .click()
  await expect(mode === "live" ? liveEditor(page) : sourceEditor(page)).toBeVisible()
}

/** Long enough for a pending autosave to have reached storage. */
export async function waitForAutosaveWindow(page: Page) {
  await page.waitForTimeout(1_500)
}
