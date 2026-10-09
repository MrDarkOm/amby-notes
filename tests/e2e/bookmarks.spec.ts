import { expect, test, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import {
  expectEditorSettles,
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const NOTE = [
  "Intro line.",
  "",
  '[Example page](https://example.com/page "A short description")',
  "",
  "[One](https://one.example)",
  "",
  "[Two](https://two.example)",
  "",
  '- [Listed](https://list.example "not a card")',
  "",
  "Text and [inline](https://inline.example) link.",
  "",
].join("\n")

/** What the card shows around the link, which is drawn from the paragraph's attributes. */
const shown = (page: Page, selector: string, pseudo: "::before" | "::after") =>
  liveEditor(page)
    .locator(selector)
    .first()
    .evaluate((element, which) => getComputedStyle(element, which).content, pseudo)

test("a titled link alone in a paragraph is a card, and the note is not changed", async ({
  page,
}) => {
  await seedVault(page, { Links: NOTE })
  await openInLive(page, "Links")
  const editor = liveEditor(page)

  const cards = editor.locator("p.amby-bookmark")
  await expect(cards).toHaveCount(1)
  await expect(cards.getByRole("link", { name: "Example page" })).toBeVisible()
  expect(await shown(page, "p.amby-bookmark", "::before")).toBe('"example.com"')
  expect(await shown(page, "p.amby-bookmark", "::after")).toBe('"A short description"')

  // Links without a hint, in a list or in a line of text stay links.
  await expect(editor.getByRole("link", { name: "One" })).toBeVisible()
  await expect(editor.locator("li p.amby-bookmark")).toHaveCount(0)
  await expect(editor.locator("p", { hasText: "Text and" })).not.toHaveClass(/amby-bookmark/)

  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Links")).toBe(NOTE)
  await expectResponsive(page)
})

test("typing in a card keeps it a card and changes only that line", async ({ page }) => {
  await seedVault(page, { Links: NOTE })
  await openInLive(page, "Links")
  await liveEditor(page).getByRole("link", { name: "Example page" }).click()
  await expect(liveEditor(page)).toBeFocused()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type("!")
  await expect
    .poll(() => storedMarkdown(page, "Links"))
    .toBe(NOTE.replace("[Example page]", "[Example page!]"))
  await expect(liveEditor(page).locator("p.amby-bookmark")).toHaveCount(1)
})

test("the slash menu inserts a bookmark from an address, without any request to the web", async ({
  page,
}) => {
  const outside: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (/^https?:$/u.test(url.protocol) && url.hostname !== "localhost") outside.push(request.url())
  })
  await seedVault(page, { Empty: "" })
  await openInLive(page, "Empty")
  await liveEditor(page).click()
  await page.keyboard.type("/закл")
  await page.keyboard.press("Enter")
  const field = page.locator(".amby-block-panel-url input")
  await expect(field).toBeVisible()
  await field.fill("www.example.org/a/b")
  await page.keyboard.press("Enter")

  await expect(liveEditor(page).locator("p.amby-bookmark")).toHaveCount(1)
  await expect
    .poll(() => storedMarkdown(page, "Empty"))
    .toBe('[example.org](https://www.example.org/a/b "example.org")')
  expect(outside).toEqual([])
})

test("an address that is not a web address inserts nothing", async ({ page }) => {
  await seedVault(page, { Empty: "" })
  await openInLive(page, "Empty")
  await liveEditor(page).click()
  await page.keyboard.type("/закл")
  await page.keyboard.press("Enter")
  const field = page.locator(".amby-block-panel-url input")
  await field.fill("javascript:alert(1)")
  await page.keyboard.press("Enter")
  await expect(liveEditor(page).locator("p.amby-bookmark")).toHaveCount(0)
  expect(await storedMarkdown(page, "Empty")).toBe("")
})

test("the card's Open button hands the address of its own link to the browser", async ({
  page,
}) => {
  await seedVault(page, { Links: NOTE })
  await openInLive(page, "Links")
  const card = liveEditor(page).locator("p.amby-bookmark")
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    card.getByRole("button", { name: localeResources.ru.translation.externalOpen.open }).click(),
  ])
  expect(popup.url()).toBe("https://example.com/page")
  await popup.close()
  // Pressing the button is not an edit.
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Links")).toBe(NOTE)
})
