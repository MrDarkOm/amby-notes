import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import {
  expectEditorSettles,
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
  test,
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
  // The site name is not repeated above the link: only the hint under it.
  expect(await shown(page, "p.amby-bookmark", "::before")).toBe("none")
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
  // A click on a link opens it, so the cursor goes into the card from the line above.
  await liveEditor(page).getByText("Intro line.").click()
  await expect(liveEditor(page)).toBeFocused()
  await page.keyboard.press("ArrowDown")
  // The cursor is in the link before the keys go to it (a busy machine may be late).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = getSelection()?.anchorNode
        return Boolean((node instanceof Element ? node : node?.parentElement)?.closest("a"))
      }),
    )
    .toBe(true)
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

test("a click on a link, and Cmd or Ctrl and a click anywhere on a card, opens the address", async ({
  page,
}) => {
  await seedVault(page, { Links: NOTE })
  await openInLive(page, "Links")
  const card = liveEditor(page).locator("p.amby-bookmark")
  for (const target of [card.getByRole("link", { name: "Example page" }), card]) {
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      target.click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 10 } }),
    ])
    expect(popup.url()).toBe("https://example.com/page")
    await popup.close()
  }
  // A plain click on the link opens it too; a plain click on the card beside it does not.
  const [plain] = await Promise.all([
    page.waitForEvent("popup"),
    card.getByRole("link", { name: "Example page" }).click(),
  ])
  expect(plain.url()).toBe("https://example.com/page")
  await plain.close()
  let opened = false
  page.on("popup", () => (opened = true))
  await card.click({ position: { x: 4, y: 4 } })
  await page.waitForTimeout(300)
  expect(opened).toBe(false)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Links")).toBe(NOTE)
})

test("links show a pointer under the mouse", async ({ page }) => {
  await seedVault(page, { Links: NOTE })
  await openInLive(page, "Links")
  const cursors = await liveEditor(page)
    .locator("a")
    .evaluateAll((links) => links.map((link) => getComputedStyle(link).cursor))
  expect(cursors.length).toBeGreaterThan(2)
  expect(new Set(cursors)).toEqual(new Set(["pointer"]))
})
