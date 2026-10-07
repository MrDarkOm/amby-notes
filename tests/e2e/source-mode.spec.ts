import { expect, test, type Page } from "@playwright/test"
import { SOURCE_LINES, SOURCE_ONLY } from "./fixtures"
import {
  labels,
  openInLive,
  openNote,
  seedVault,
  sourceEditor,
  storedMarkdown,
  switchMode,
} from "./support"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Lines: SOURCE_LINES, Definition: SOURCE_ONLY })
  await openInLive(page, "Lines")
  await switchMode(page, "source")
})

/** Puts the cursor on the empty second line. */
async function goToEmptyLine(page: Page) {
  await sourceEditor(page).locator(".cm-line").first().click()
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowDown")
}

/** The pixels of the empty second line. */
async function emptyLinePixels(page: Page) {
  const box = await sourceEditor(page).locator(".cm-line").nth(1).boundingBox()
  if (!box) throw new Error("the empty line is not on screen")
  return page.screenshot({ clip: box, animations: "disabled" })
}

// The stale caret itself was a paint artifact of the desktop webview and does not show in
// a headless screenshot, so this guards the cure: the editor draws exactly one cursor of
// its own and the native caret, the one that got stuck, is switched off.
test("an empty line shows one cursor after a character is typed and deleted", async ({ page }) => {
  await sourceEditor(page).locator(".cm-line").first().click()
  await page.keyboard.press("Home")
  const before = await emptyLinePixels(page)

  await page.keyboard.press("ArrowDown")
  await page.keyboard.type("x")
  await page.keyboard.press("Backspace")

  await expect(sourceEditor(page).locator(".cm-cursor")).toHaveCount(1)
  const nativeCaret = await sourceEditor(page)
    .locator(".cm-line")
    .nth(1)
    .evaluate((line) => getComputedStyle(line).caretColor)
  expect(nativeCaret).toBe("rgba(0, 0, 0, 0)")

  // With the cursor back on the first line the empty one is drawn as before.
  await page.keyboard.press("ArrowUp")
  await page.keyboard.press("Home")
  await expect(sourceEditor(page).locator(".cm-cursor")).toHaveCount(1)
  expect((await emptyLinePixels(page)).equals(before)).toBe(true)
})

test("typing in Source is saved", async ({ page }) => {
  await goToEmptyLine(page)
  await page.keyboard.type("typed here")
  await expect
    .poll(() => storedMarkdown(page, "Lines"))
    .toBe(SOURCE_LINES.replace("\n\n", "\ntyped here\n"))
})

test("locking and unlocking a Source-only note keeps the same editor", async ({ page }) => {
  // The lock button turns an ordinary note to the reading view; a note that must stay in
  // Source keeps its Source editor and is only made read-only.
  await openNote(page, "Definition")
  await expect(sourceEditor(page).locator(".cm-line").first()).toHaveText("See [the site][site].")
  const content = sourceEditor(page).locator(".cm-content")
  await expect(content).toHaveAttribute("contenteditable", "true")
  await sourceEditor(page).evaluate((element) => {
    ;(element as HTMLElement & { e2eMark?: string }).e2eMark = "kept"
  })
  const mark = () =>
    sourceEditor(page).evaluate(
      (element) => (element as HTMLElement & { e2eMark?: string }).e2eMark,
    )

  await page.getByRole("button", { name: labels.viewMode, exact: true }).click()
  await expect(content).toHaveAttribute("contenteditable", "false")
  expect(await mark()).toBe("kept")

  await page.getByRole("button", { name: labels.editMode, exact: true }).click()
  await expect(content).toHaveAttribute("contenteditable", "true")
  expect(await mark()).toBe("kept")

  await content.click()
  await page.keyboard.press("Meta+ArrowDown")
  await page.keyboard.type("after unlock")
  await expect.poll(() => storedMarkdown(page, "Definition")).toBe(`${SOURCE_ONLY}after unlock`)
})
