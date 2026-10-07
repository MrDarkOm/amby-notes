import { expect, test } from "@playwright/test"
import {
  FOOTNOTE,
  HEAVY_TABLE,
  HEAVY_TABLE_CELLS,
  ODD_SPELLINGS,
  TITLED_IMAGE_LINKS,
} from "./fixtures"
import {
  expectResponsive,
  liveEditor,
  openInLive,
  openNote,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const NOTES = {
  Links: TITLED_IMAGE_LINKS,
  Table: HEAVY_TABLE,
  Odd: ODD_SPELLINGS,
  Footnote: FOOTNOTE,
}

test.beforeEach(async ({ page }) => {
  await seedVault(page, NOTES)
})

test("two titled links around images open in Live without freezing the window", async ({
  page,
}) => {
  await openInLive(page, "Links")
  const links = liveEditor(page).locator("a[href]")
  await expect(links).toHaveCount(2)
  // The title stays on the link the editor drew; taking it off started the endless redraw.
  await expect(links.first()).toHaveAttribute("title", "A")
  await expect(links.last()).toHaveAttribute("title", "B")
  await expect(liveEditor(page).locator("img[src]")).toHaveCount(2)
})

test("a table of about 2000 cells opens in Live", async ({ page }) => {
  await openInLive(page, "Table")
  await expect(liveEditor(page).locator("th, td")).toHaveCount(HEAVY_TABLE_CELLS)
})

test("web-clipper escapes, sparse lists, rules, setext headings, callouts and nested emphasis open in Live", async ({
  page,
}) => {
  await openInLive(page, "Odd")
  const editor = liveEditor(page)
  await expect(editor.locator("h1")).toHaveText("Setext title")
  await expect(editor.locator("h2")).toHaveText("Second level")
  await expect(editor.locator("hr")).toHaveCount(1)
  await expect(editor.getByText("1. A web clipper escaped this number.")).toBeVisible()
  await expect(editor.getByText("Italic around bold: word. and a b c here.")).toBeVisible()
  await expect(editor.locator("pre.amby-opaque-markdown")).toHaveCount(0)
})

test("a footnote opens in Live with its blocks kept as source text", async ({ page }) => {
  await openInLive(page, "Footnote")
  const opaque = liveEditor(page).locator("pre.amby-opaque-markdown")
  await expect(opaque.filter({ hasText: "[^1]: The note itself." })).toHaveCount(1)
  await expect(liveEditor(page).getByText("Closing paragraph.")).toBeVisible()
})

test("opening notes and saving nothing leaves every stored note byte-identical", async ({
  page,
}) => {
  for (const name of Object.keys(NOTES)) {
    await openNote(page, name)
    await expectResponsive(page)
    await expect(liveEditor(page)).toBeVisible()
    // Focusing the text without typing must not count as an edit either.
    await liveEditor(page).locator("p, h1").first().click()
  }
  await waitForAutosaveWindow(page)
  for (const [name, source] of Object.entries(NOTES)) {
    expect(await storedMarkdown(page, name), name).toBe(source)
  }
})
