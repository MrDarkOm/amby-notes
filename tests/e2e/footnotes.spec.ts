import { expect, test } from "@playwright/test"
import { FOOTNOTE } from "./fixtures"
import {
  expectEditorSettles,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const INLINE = "Start.\n\nA claim.^[Said in passing.] And on.\n"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Footnote: FOOTNOTE, Inline: INLINE, Empty: "" })
})

test("typing next to a footnote reference keeps it and changes only that paragraph", async ({
  page,
}) => {
  await openInLive(page, "Footnote")
  await liveEditor(page).getByText("A claim with a note.").click()
  await page.keyboard.press("Meta+ArrowLeft")
  await page.keyboard.type("Well: ")
  await expect
    .poll(() => storedMarkdown(page, "Footnote"))
    .toBe(FOOTNOTE.replace("A claim with a note.[^1]", "Well: A claim with a note.[^1]"))
  await expect(liveEditor(page).locator("sup.amby-footnote-ref")).toHaveCount(1)
})

test("the text of a footnote is edited in place", async ({ page }) => {
  await openInLive(page, "Footnote")
  await liveEditor(page).locator(".amby-footnote-def").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" Twice.")
  await expect
    .poll(() => storedMarkdown(page, "Footnote"))
    .toBe(FOOTNOTE.replace("[^1]: The note itself.", "[^1]: The note itself. Twice."))
})

test("an inline footnote is shown and the note is not changed", async ({ page }) => {
  await openInLive(page, "Inline")
  await expect(liveEditor(page).locator("sup.amby-footnote-inline")).toHaveText("Said in passing.")
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Inline")).toBe(INLINE)
})

test("typed footnotes become footnotes", async ({ page }) => {
  await openInLive(page, "Empty")
  await liveEditor(page).click()
  await page.keyboard.type("A claim.[^1] And ^[an aside].")
  await expect(liveEditor(page).locator("sup.amby-footnote-ref")).toHaveText("1")
  await expect(liveEditor(page).locator("sup.amby-footnote-inline")).toHaveText("an aside")
  await page.keyboard.press("Enter")
  await page.keyboard.type("[^1]: The source.")
  await expect(liveEditor(page).locator(".amby-footnote-def")).toHaveText("The source.")
  await expect
    .poll(() => storedMarkdown(page, "Empty"))
    .toBe("A claim.[^1] And ^[an aside].\n\n[^1]: The source.")
})

test("the slash menu inserts a numbered footnote and its definition", async ({ page }) => {
  await openInLive(page, "Footnote")
  await liveEditor(page).getByText("Ordinary paragraph.").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" /сноск")
  await page.keyboard.press("Enter")
  await page.keyboard.type("Second note.")
  await expect(liveEditor(page).locator("sup.amby-footnote-ref")).toHaveText(["2", "1"])
  await expect
    .poll(() => storedMarkdown(page, "Footnote"))
    .toBe(
      FOOTNOTE.replace("Ordinary paragraph.", "Ordinary paragraph. [^2]").trimEnd() +
        "\n\n[^2]: Second note.\n",
    )
})
