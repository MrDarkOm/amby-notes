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

/** How far the chosen row of a list is outside its visible part (0 or less when whole). */
const hiddenPixels = (page: import("@playwright/test").Page, list: string, row: string) =>
  page.evaluate(
    ([listSelector, rowSelector]) => {
      const box = document.querySelector(listSelector)!.getBoundingClientRect()
      const chosen = document.querySelector(rowSelector)!.getBoundingClientRect()
      return Math.max(box.top - chosen.top, chosen.bottom - box.bottom)
    },
    [list, row],
  )

test("the arrows walk the menu one row at a time and keep the choice in view", async ({ page }) => {
  await page.keyboard.type("/")
  const count = await rows(page).count()
  expect(count).toBeGreaterThan(15)
  // The pointer rests over the list: rows that scroll under it must not take the choice.
  const box = (await panel(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const chosen = () =>
    page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.amby-block-panel [role="option"]'))
      return all.findIndex((row) => row.getAttribute("aria-selected") === "true")
    })
  let previous = await chosen()
  for (let step = 0; step < count + 2; step++) {
    await page.keyboard.press("ArrowDown")
    await expect.poll(chosen).toBe((previous + 1) % count)
    previous = (previous + 1) % count
    await expect
      .poll(() =>
        hiddenPixels(
          page,
          ".amby-block-panel-body",
          '.amby-block-panel [role="option"][aria-selected="true"]',
        ),
      )
      .toBeLessThanOrEqual(1)
  }
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press("ArrowUp")
    await expect.poll(chosen).toBe((previous - 1 + count) % count)
    previous = (previous - 1 + count) % count
    await expect
      .poll(() =>
        hiddenPixels(
          page,
          ".amby-block-panel-body",
          '.amby-block-panel [role="option"][aria-selected="true"]',
        ),
      )
      .toBeLessThanOrEqual(1)
  }
})

test("the block menu is driven by the keys: arrows, Enter, the Turn into list and Escape", async ({
  page,
}) => {
  await page.keyboard.type("Hello")
  await page.keyboard.press("Escape")
  await liveEditor(page).locator("p").first().hover()
  await page.locator(".amby-block-handle-grip").click()
  const actions = page.locator(".amby-block-panel--actions")
  await expect(actions).toBeVisible()
  const active = actions.locator('button.amby-block-row[data-kbd-active="true"]')
  await expect(active).toHaveCount(1)
  await expect(active).toContainText("Преобразовать в")

  // Down moves over the rows (the rows of the footer too), up wraps around.
  await page.keyboard.press("ArrowDown")
  await expect(active).not.toContainText("Преобразовать в")
  await page.keyboard.press("ArrowUp")
  await expect(active).toContainText("Преобразовать в")
  await page.keyboard.press("ArrowUp")
  await expect(active).toContainText("Удалить")
  await page.keyboard.press("ArrowDown")
  await expect(active).toContainText("Преобразовать в")

  // Enter opens the Turn into list; the arrows walk it and keep the choice in view.
  await page.keyboard.press("Enter")
  const submenu = page.locator(".amby-turn-into-menu")
  await expect(submenu).toBeVisible()
  const subActive = submenu.locator('button.amby-block-row[data-kbd-active="true"]')
  await expect(subActive).toHaveCount(1)
  const subCount = await submenu.locator("button.amby-block-row").count()
  for (let step = 0; step < subCount - 1; step++) {
    await page.keyboard.press("ArrowDown")
    await expect
      .poll(() =>
        hiddenPixels(
          page,
          ".amby-turn-into-menu",
          '.amby-turn-into-menu button.amby-block-row[data-kbd-active="true"]',
        ),
      )
      .toBeLessThanOrEqual(1)
  }
  await expect(subActive).toContainText("Цитата")
  // Left goes back to the menu; Escape closes it all and leaves the note alone.
  await page.keyboard.press("ArrowLeft")
  await expect(submenu).toHaveCount(0)
  await expect(actions).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(submenu).toBeVisible()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(actions).toHaveCount(0)
  await expect(liveEditor(page).locator("h1, h2")).toHaveCount(1)
  await expect.poll(() => storedMarkdown(page, "Empty")).toMatch(/^#{1,2} Hello$/u)
})

test("Escape closes the block menu without changing the note", async ({ page }) => {
  await page.keyboard.type("Hello")
  await page.keyboard.press("Escape")
  await liveEditor(page).locator("p").first().hover()
  await page.locator(".amby-block-handle-grip").click()
  await expect(page.locator(".amby-block-panel--actions")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".amby-block-panel--actions")).toHaveCount(0)
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("Hello")
})
