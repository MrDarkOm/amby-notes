import { expect, test, type Page } from "@playwright/test"
import { HEAVY_TABLE, HEAVY_TABLE_CELLS, SOURCE_LINES } from "./fixtures"
import {
  EDITORS_PER_MOUNT,
  expectResponsive,
  liveEditor,
  openInLive,
  openNote,
  seedVault,
  sourceEditor,
  switchMode,
} from "./support"

// Generous on purpose: the budget is there to catch a regression of the kind "the editor
// is built twice" or "the admission check runs several times", not to benchmark.
const OPEN_BUDGET_MS = 6_000

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Small: SOURCE_LINES, Table: HEAVY_TABLE })
})

/**
 * Counts how many different editor roots of a kind are created from now on. The same
 * root being moved in the page (React placing it) is one editor, not several.
 */
async function countEditorMounts(page: Page, selector: string) {
  await page.evaluate((selector) => {
    const seen = new Set<Element>()
    ;(window as unknown as { e2eMounts: Set<Element> }).e2eMounts = seen
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches(selector)) seen.add(node)
          for (const root of node.querySelectorAll(selector)) seen.add(root)
        }
      }
    }).observe(document.body, { subtree: true, childList: true })
  }, selector)
  return () =>
    page.evaluate(() => (window as unknown as { e2eMounts: Set<Element> }).e2eMounts.size)
}

test("the heavy note opens in Live within the budget and builds one editor", async ({ page }) => {
  await openInLive(page, "Small")
  const mounts = await countEditorMounts(page, ".ProseMirror")

  const started = Date.now()
  await openNote(page, "Table")
  await expect(liveEditor(page).locator("th, td")).toHaveCount(HEAVY_TABLE_CELLS, {
    timeout: OPEN_BUDGET_MS,
  })
  await expectResponsive(page)
  const elapsed = Date.now() - started

  expect(elapsed, `opened in ${elapsed} ms`).toBeLessThan(OPEN_BUDGET_MS)
  expect(await mounts()).toBe(1)
})

test("the heavy note switches to Source within the budget and builds one editor", async ({
  page,
}) => {
  await openInLive(page, "Table")
  const mounts = await countEditorMounts(page, ".cm-editor")

  const started = Date.now()
  await switchMode(page, "source")
  await expect(sourceEditor(page).locator(".cm-line").first()).toHaveText("# Heavy table", {
    timeout: OPEN_BUDGET_MS,
  })
  await expectResponsive(page)
  const elapsed = Date.now() - started

  expect(elapsed, `switched in ${elapsed} ms`).toBeLessThan(OPEN_BUDGET_MS)
  // The surface is locked for an instant while it changes; that once built a second editor.
  expect(await mounts()).toBe(EDITORS_PER_MOUNT)
})
