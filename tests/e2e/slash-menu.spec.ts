import { expect, test } from "@playwright/test"
import { liveEditor, openInLive, seedVault, storedMarkdown } from "./support"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Empty: "" })
  await openInLive(page, "Empty")
  await liveEditor(page).click()
})

const panel = (page: import("@playwright/test").Page) => page.locator(".amby-block-panel--insert")
const rows = (page: import("@playwright/test").Page) => panel(page).locator("[role=option]")

test("the slash menu filters by what is typed in the note and keeps the focus there", async ({
  page,
}) => {
  await page.keyboard.type("/")
  await expect(panel(page)).toBeVisible()
  await expect(panel(page).locator(".amby-block-panel-group")).toHaveText([
    "Текст",
    "Списки",
    "Медиа",
    "Вставки",
  ])
  await expect(liveEditor(page)).toBeFocused()

  await page.keyboard.type("заг")
  // The query is in the note, not in a field of the menu.
  await expect(liveEditor(page).locator("p")).toHaveText("/заг")
  await expect(rows(page)).toHaveCount(6)
  await expect(panel(page).locator(".amby-block-panel-group")).toHaveText(["Текст"])

  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(panel(page)).toHaveCount(0)
  await expect(liveEditor(page).locator("h2")).toHaveCount(1)
  await page.keyboard.type("Title")
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("## Title")
})

test("Backspace widens the list again and Escape leaves the typed text", async ({ page }) => {
  await page.keyboard.type("/спис")
  await expect(rows(page)).toHaveCount(3)
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await expect(rows(page).first()).toBeVisible()
  expect(await rows(page).count()).toBeGreaterThan(10)
  await page.keyboard.press("Escape")
  await expect(panel(page)).toHaveCount(0)
  await expect(liveEditor(page).locator("p")).toHaveText("/")
})

test("text after a slash that names no block is ordinary text", async ({ page }) => {
  await page.keyboard.type("/qwz")
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press("Enter")
  await page.keyboard.type("next")
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("/qwz\n\nnext")
})

test("a block can be picked with the mouse", async ({ page }) => {
  await page.keyboard.type("/")
  await rows(page).filter({ hasText: "Список задач" }).click()
  await expect(liveEditor(page).locator('ul[data-type="taskList"]')).toHaveCount(1)
  await page.keyboard.type("todo")
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("- [ ] todo")
})

test("the image-from-address item asks for the address in the menu itself", async ({ page }) => {
  await page.keyboard.type("/url")
  await expect(rows(page)).toHaveCount(1)
  await page.keyboard.press("Enter")
  const field = panel(page).locator(".amby-block-panel-url input")
  await expect(field).toBeVisible()
  await field.fill("https://example.com/pic.png")
  await page.keyboard.press("Enter")
  await expect(liveEditor(page).locator(".amby-image-wrap img")).toHaveCount(1)
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("![](https://example.com/pic.png)")
})

test("Escape in the address field goes back to the list and leaves the typed text", async ({
  page,
}) => {
  await page.keyboard.type("/url")
  await page.keyboard.press("Enter")
  const field = panel(page).locator(".amby-block-panel-url input")
  await expect(field).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(field).toHaveCount(0)
  await expect(panel(page)).toBeVisible()
  await expect(liveEditor(page).locator("p")).toHaveText("/url")
})
