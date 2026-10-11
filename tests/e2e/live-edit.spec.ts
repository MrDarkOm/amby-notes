import { expect } from "@playwright/test"
import { ODD_SPELLINGS } from "./fixtures"
import {
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  sourceEditor,
  storedMarkdown,
  switchMode,
  waitForAutosaveWindow,
  test,
} from "./support"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Odd: ODD_SPELLINGS })
})

test("typing in one paragraph changes only that block in the stored Markdown", async ({ page }) => {
  await openInLive(page, "Odd")
  const paragraph = liveEditor(page).getByText("Plain paragraph to edit.")
  await paragraph.click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" Typed")

  const expected = ODD_SPELLINGS.replace(
    "Plain paragraph to edit.",
    "Plain paragraph to edit. Typed",
  )
  await expect.poll(() => storedMarkdown(page, "Odd")).toBe(expected)
  await waitForAutosaveWindow(page)
  // Every other block keeps its own spelling: `1\.`, the sparse list, `* * *`, `1)`.
  expect(await storedMarkdown(page, "Odd")).toBe(expected)
  await expectResponsive(page)
})

test("switching Live to Source and back keeps the text and does not change the file", async ({
  page,
}) => {
  await openInLive(page, "Odd")
  await switchMode(page, "source")
  await expect(liveEditor(page)).toHaveCount(0)
  const lines = await sourceEditor(page).locator(".cm-line").allInnerTexts()
  // An empty line is drawn as a line break, which reads as "\n". The file ends with a
  // line break, so the last line shown is an empty one.
  const shown = lines.map((line) => (line === "\n" ? "" : line)).join("\n")
  expect(shown).toBe(ODD_SPELLINGS)

  await switchMode(page, "live")
  await expect(sourceEditor(page)).toHaveCount(0)
  await expect(liveEditor(page).locator("h1")).toHaveText("Setext title")
  await expect(liveEditor(page).getByText("Plain paragraph to edit.")).toBeVisible()

  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Odd")).toBe(ODD_SPELLINGS)
})
