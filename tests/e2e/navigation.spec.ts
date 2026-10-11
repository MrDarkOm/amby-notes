import { expect } from "@playwright/test"
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

const WORK = "Intro line\n\nSecond paragraph mentions talo and Talo.\n\n- talossa\n"
const NOTES = {
  Work: WORK,
  "Finnish grammar": "Grammar note with #language and #inbox/to-read tags.\n",
  Grammar: "Short note. #inbox\n",
  Tokens: "Above\n\nSee [[Grammar]] and #inbox here.\n",
}

test.beforeEach(async ({ page }) => {
  await seedVault(page, NOTES)
})

const suggestions = (page: import("@playwright/test").Page) =>
  page.locator("[data-inline-suggest] [role=option]")

test("typing `[[` offers notes and Enter writes the wikilink", async ({ page }) => {
  await openInLive(page, "Work")
  await liveEditor(page).getByText("Intro line").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" [[gram")
  await expect(suggestions(page)).toHaveText(["Grammar", "Finnish grammar"])
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(suggestions(page)).toHaveCount(0)
  await expect(liveEditor(page).locator(".amby-live-wikilink-button")).toHaveText("Finnish grammar")
  await expect
    .poll(() => storedMarkdown(page, "Work"))
    .toBe(WORK.replace("Intro line", "Intro line [[Finnish grammar]]"))
  await expectResponsive(page)
})

test("a suggestion can be picked with the mouse and Escape dismisses the list", async ({
  page,
}) => {
  await openInLive(page, "Work")
  await liveEditor(page).getByText("Intro line").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" [[gr")
  await expect(suggestions(page)).toHaveCount(2)
  await page.keyboard.press("Escape")
  await expect(suggestions(page)).toHaveCount(0)
  await page.keyboard.type("am")
  await expect(suggestions(page)).toHaveCount(0)

  await page.keyboard.type(" [[work")
  await suggestions(page).filter({ hasText: "Work" }).click()
  await expect
    .poll(() => storedMarkdown(page, "Work"))
    .toBe(WORK.replace("Intro line", "Intro line [[gram [[Work]]"))
})

test("typing `#` offers the tags that exist in the vault", async ({ page }) => {
  await openInLive(page, "Work")
  await liveEditor(page).getByText("Intro line").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" #in")
  await expect(suggestions(page)).toHaveText(["#inbox", "#inbox/to-read"])
  await page.keyboard.press("Enter")
  await page.keyboard.type("done")
  await expect(liveEditor(page).locator(".amby-live-tag")).toHaveText("#inbox")
  await expect
    .poll(() => storedMarkdown(page, "Work"))
    .toBe(WORK.replace("Intro line", "Intro line #inbox done"))
})

test("Cmd+F finds in Live, steps through matches and does not change the note", async ({
  page,
}) => {
  await openInLive(page, "Work")
  await liveEditor(page).getByText("Intro line").click()
  await page.keyboard.press("Meta+f")
  const field = page.locator(".amby-find-bar input")
  await expect(field).toBeFocused()
  await field.fill("talo")
  await expect(liveEditor(page).locator(".amby-find-match")).toHaveText(["talo", "Talo", "talo"])
  await expect(page.locator(".amby-find-bar")).toContainText("1 из 3")
  await field.press("Enter")
  await expect(page.locator(".amby-find-bar")).toContainText("2 из 3")
  await expect(liveEditor(page).locator(".amby-find-current")).toHaveText("Talo")
  await field.press("Shift+Enter")
  await field.press("Shift+Enter")
  await expect(page.locator(".amby-find-bar")).toContainText("3 из 3")

  await field.press("Escape")
  await expect(page.locator(".amby-find-bar")).toHaveCount(0)
  await expect(liveEditor(page).locator(".amby-find-match")).toHaveCount(0)
  await expect(liveEditor(page)).toBeFocused()
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Work")).toBe(WORK)

  // The cursor is where the last match was: typing goes there.
  await page.keyboard.type("X")
  await expect
    .poll(() => storedMarkdown(page, "Work"))
    .toBe(WORK.replace("- talossa", "- Xtalossa"))
})

test("Cmd+F finds in Source with the CodeMirror panel", async ({ page }) => {
  await openInLive(page, "Work")
  await switchMode(page, "source")
  await sourceEditor(page).locator(".cm-line").first().click()
  await page.keyboard.press("Meta+f")
  const field = sourceEditor(page).locator(".cm-search input[name=search]")
  await expect(field).toBeFocused()
  await field.pressSequentially("talo")
  await expect(sourceEditor(page).locator(".cm-searchMatch")).toHaveCount(3)
  await field.press("Enter")
  await expect(sourceEditor(page).locator(".cm-searchMatch-selected")).toHaveCount(1)
  await field.press("Escape")
  await expect(sourceEditor(page).locator(".cm-search")).toHaveCount(0)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Work")).toBe(WORK)
})

test("unlinking a tag replaces that tag after text was typed above it", async ({ page }) => {
  await openInLive(page, "Tokens")
  // Text typed in the paragraph above moves the tag; its decoration is kept, not rebuilt.
  await liveEditor(page).getByText("Above").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" and some more text")
  await liveEditor(page).locator(".amby-live-tag").hover()
  await page.getByRole("button", { name: "Отвязать" }).click()
  await expect
    .poll(() => storedMarkdown(page, "Tokens"))
    .toBe("Above and some more text\n\nSee [[Grammar]] and inbox here.\n")

  await liveEditor(page).locator(".amby-live-wikilink-button").hover()
  await page.getByRole("button", { name: "Отвязать" }).click()
  await expect
    .poll(() => storedMarkdown(page, "Tokens"))
    .toBe("Above and some more text\n\nSee Grammar and inbox here.\n")
})
