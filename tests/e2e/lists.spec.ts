import { expect, test } from "@playwright/test"
import { liveEditor, openInLive, seedVault, storedMarkdown, waitForAutosaveWindow } from "./support"

// A list as a web clipper leaves it: sparse, with escapes, nested with four spaces.
const LIST = [
  "Intro",
  "",
  "* first item",
  "",
  "* 1\\. second item",
  "    * nested deeper",
  "",
  "* third item",
  "",
  "Outro",
  "",
].join("\n")

const TWO_LISTS = "- a\n- b\n\nbetween\n\n- c\n- d\n"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { List: LIST, Two: TWO_LISTS })
})

test("editing one item of a list leaves the other items as they were written", async ({ page }) => {
  await openInLive(page, "List")
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "List")).toBe(LIST)

  await liveEditor(page).getByText("third item").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" edited")
  await expect
    .poll(() => storedMarkdown(page, "List"))
    .toBe(LIST.replace("\n* third item", "* third item edited"))
  // The escape, the blank line and the four-space indent above are all still there.
  expect(await storedMarkdown(page, "List")).toContain(
    "* first item\n\n* 1\\. second item\n    * nested deeper\n",
  )
})

test("two lists stay two lists when the paragraph between them is deleted", async ({ page }) => {
  await openInLive(page, "Two")
  await liveEditor(page).getByText("between").click()
  await page.keyboard.press("Meta+ArrowRight")
  for (let count = 0; count < "between".length + 1; count++) await page.keyboard.press("Backspace")
  await expect(liveEditor(page).locator("ul")).toHaveCount(2)
  await page.keyboard.type("!")
  await waitForAutosaveWindow(page)
  const stored = await storedMarkdown(page, "Two")
  // Reopen what was saved: still two lists.
  await page.reload()
  await openInLive(page, "Two")
  await expect(liveEditor(page).locator("ul")).toHaveCount(2)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Two")).toBe(stored)
})
