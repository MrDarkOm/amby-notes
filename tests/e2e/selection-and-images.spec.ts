import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import {
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  test,
  waitForAutosaveWindow,
} from "./support"

const ru = localeResources.ru.translation

// A plain 200x80 picture, small enough to live in the note.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAABQCAIAAADTD63nAAAA6UlEQVR4nO3SQQkAIADAQPsnM4RdtIRDkIMLsMfGXBuuG88L+JKxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi4SxSBiLhLFIGIuEsUgYi8QBL8zVHbpv2WkAAAAASUVORK5CYII="

const NOTE = [
  "First paragraph of the note",
  "",
  "Second paragraph of the note",
  "",
  `![](${PNG})`,
  "",
  "<!-- amby:columns -->",
  "",
  "<!-- amby:column -->",
  "",
  "Left text",
  "",
  "<!-- amby:column -->",
  "",
  "Right text",
  "",
  "<!-- /amby:columns -->",
  "",
  "Tail",
  "",
].join("\n")

const highlighted = (page: Page) =>
  page.evaluate(() => {
    const highlight = CSS.highlights.get("amby-selection")
    if (!highlight) return null
    return [...highlight].map((range) => range.toString()).join("")
  })

async function dragAcrossParagraphs(page: Page) {
  const editor = liveEditor(page)
  const first = (await editor.getByText("First paragraph").boundingBox())!
  const second = (await editor.getByText("Second paragraph").boundingBox())!
  await page.mouse.move(first.x + 60, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + 90, second.y + second.height / 2, { steps: 8 })
  await page.mouse.up()
}

test("a selection across paragraphs is drawn from its text and goes when the editor loses focus", async ({
  page,
}) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  await dragAcrossParagraphs(page)

  // Exactly the selected text is drawn: no band fills the space between the paragraphs.
  await expect.poll(() => highlighted(page)).toContain("of the note")
  expect(await highlighted(page)).toContain("Second")
  await expect(liveEditor(page)).toHaveClass(/amby-custom-selection/)

  // Clicking out of the editor does not leave the selection hanging.
  await page.getByRole("button", { name: ru.actions.settings }).first().focus()
  await expect.poll(() => highlighted(page)).toBeNull()
  await expect(liveEditor(page)).not.toHaveClass(/amby-custom-selection/)
})

test("a selected picture gets picture actions, not text formatting", async ({ page }) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)
  await editor.locator("img").first().click()

  const toolbar = page.locator("[data-image-toolbar]")
  await expect(toolbar).toBeVisible()
  await expect(toolbar.getByRole("button", { name: ru.editorToolbar.imageCopy })).toBeVisible()
  await expect(toolbar.getByRole("button", { name: ru.editorToolbar.imageSave })).toBeVisible()
  await expect(toolbar.getByRole("button", { name: ru.editorToolbar.imageCaption })).toBeVisible()
  await expect(toolbar.getByRole("button", { name: ru.editorToolbar.imageAlign })).toBeVisible()
  // Replace and crop write files through the desktop backend; the web build has neither.
  await expect(toolbar.getByRole("button", { name: ru.editorToolbar.imageCrop })).toHaveCount(0)
  // A picture is not selectable text, so the system's text recognition leaves it alone.
  expect(
    await editor
      .locator("img")
      .first()
      .evaluate((img) => getComputedStyle(img).userSelect),
  ).toBe("none")
  // The toolbar is under the picture, as for text, and starts at its left edge.
  const picture = (await editor.locator("img").first().boundingBox())!
  const bar = (await toolbar.boundingBox())!
  expect(bar.y).toBeGreaterThanOrEqual(picture.y + picture.height)
  expect(Math.abs(bar.x - picture.x)).toBeLessThan(2)
  // The text toolbar is not offered for a picture.
  await expect(page.getByTitle(ru.editorToolbar.bold)).toHaveCount(0)

  const download = page.waitForEvent("download")
  await toolbar.getByRole("button", { name: ru.editorToolbar.imageSave }).click()
  expect((await download).suggestedFilename()).toBe("image.png")

  await toolbar.getByRole("button", { name: ru.editorToolbar.imageDelete }).click()
  await expect(editor.locator("img")).toHaveCount(0)
  await expect(toolbar).toHaveCount(0)
})

test("a picture stands close to its neighbours and columns have no vertical padding", async ({
  page,
}) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)

  const image = (await editor.locator("img").first().boundingBox())!
  const above = (await editor.getByText("Second paragraph").boundingBox())!
  const aboveGap = image.y - (above.y + above.height)
  expect(aboveGap).toBeLessThan(16)

  const geometry = await page.evaluate(() => {
    const set = document.querySelector(".amby-column-set")!
    const contents = [...set.querySelectorAll(".amby-column-content")]
    const paragraphs = contents.map((content) => content.querySelector("p")!)
    return {
      tops: contents.map(
        (content, i) =>
          paragraphs[i].getBoundingClientRect().top - content.getBoundingClientRect().top,
      ),
      setHeight: set.getBoundingClientRect().height,
      tallest: Math.max(...paragraphs.map((p) => p.getBoundingClientRect().height)),
    }
  })
  // The text starts at the top of the row and the row ends with its tallest column.
  for (const top of geometry.tops) expect(top).toBeLessThan(1)
  expect(geometry.setHeight).toBeLessThan(geometry.tallest + 1)
})

test("a picture's caption and alignment are written into the note", async ({ page }) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)
  await editor.locator("img").first().click()
  const toolbar = page.locator("[data-image-toolbar]")

  await toolbar.getByRole("button", { name: ru.editorToolbar.imageCaption }).click()
  await page.getByPlaceholder(ru.editorToolbar.imageCaptionPlaceholder).fill("A tidy caption")
  await page.keyboard.press("Enter")
  await expect(editor.locator(".amby-image-caption")).toHaveText("A tidy caption")

  // The picture stays selected and its toolbar stays at hand.
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole("button", { name: ru.editorToolbar.imageAlign }).click()
  await page.getByRole("button", { name: ru.editorToolbar.imageAlignCenter }).click()
  await expect(editor.locator(".amby-image-wrap--center")).toHaveCount(1)
  // The line of an aligned picture is as high as the picture (plus its caption), as it is
  // without alignment: no empty line under it.
  const heights = await page.evaluate(() => {
    const wrap = document.querySelector(".amby-image-wrap--center")!
    return {
      line: wrap.closest("p")!.getBoundingClientRect().height,
      wrap: wrap.getBoundingClientRect().height,
    }
  })
  expect(heights.line - heights.wrap).toBeLessThan(0.5)

  await waitForAutosaveWindow(page)
  const stored = (await storedMarkdown(page, "Note")) ?? ""
  expect(stored).toContain("![|center](data:image/png;base64,")
  expect(stored).toContain('"A tidy caption")')
})

test("a picture inside selected text is not left selected when the cursor moves to another line", async ({
  page,
}) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)
  await editor.getByText("Second paragraph").click()
  await page.keyboard.press("Shift+ArrowDown")
  await page.keyboard.press("Shift+ArrowDown")
  await expect(page.locator("[data-in-selection]")).toHaveCount(1)

  await editor.getByText("Tail").click()
  await expect(page.locator("[data-in-selection]")).toHaveCount(0)
  await expect(page.locator(".amby-image-wrap.is-selected")).toHaveCount(0)
  await expect.poll(() => highlighted(page)).toBeNull()

  // Selecting the picture itself and then clicking a line leaves nothing behind either.
  await editor.locator("img").first().click()
  await expect(page.locator(".amby-image-wrap.is-selected")).toHaveCount(1)
  await editor.getByText("Tail").click()
  await expect(page.locator(".amby-image-wrap.is-selected")).toHaveCount(0)
  await expect(page.locator("[data-image-toolbar]")).toHaveCount(0)
})

test("a picture opens in a viewer with zoom, and Escape closes it", async ({ page }) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  await liveEditor(page).locator("img").first().click()
  await page
    .locator("[data-image-toolbar]")
    .getByRole("button", { name: ru.editorToolbar.imageOpen })
    .click()

  const viewer = page.locator("[data-image-lightbox]")
  await expect(viewer).toBeVisible()
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 200)
  // A small picture is shown at its own size.
  await expect(viewer.getByRole("button", { name: ru.lightbox.fit })).toHaveText("100%")
  await viewer.getByRole("button", { name: ru.lightbox.zoomIn }).click()
  await expect(viewer.getByRole("button", { name: ru.lightbox.fit })).toHaveText("125%")
  await viewer.getByRole("button", { name: ru.lightbox.zoomOut }).click()
  await viewer.getByRole("button", { name: ru.lightbox.zoomOut }).click()
  await expect(viewer.getByRole("button", { name: ru.lightbox.fit })).toHaveText("80%")
  await viewer.getByRole("button", { name: ru.lightbox.fit }).click()
  await expect(viewer.getByRole("button", { name: ru.lightbox.fit })).toHaveText("100%")

  await page.keyboard.press("Escape")
  await expect(viewer).toHaveCount(0)
})

test("the block menu of a picture's line has the picture's actions", async ({ page }) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)
  const box = (await editor.locator("img").first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 })
  const grip = page.locator(".amby-block-handles")
  await expect(grip).toBeVisible()
  await grip.locator("button").first().click()

  const panel = page.locator(".amby-block-panel--actions")
  await expect(panel).toBeVisible()
  for (const name of [
    ru.editorToolbar.imageOpen,
    ru.editorToolbar.imageCopy,
    ru.editorToolbar.imageSave,
  ]) {
    await expect(panel.getByRole("button", { name })).toBeVisible()
  }
  // Replace and crop write files through the desktop backend.
  await expect(panel.getByRole("button", { name: ru.editorToolbar.imageCrop })).toHaveCount(0)

  // The size presets are not part of this menu any more.
  await expect(panel.getByText("25%")).toHaveCount(0)

  // Caption and alt text are in a submenu.
  await panel.getByRole("button", { name: ru.blockPanel.imageDetails }).click()
  await page.getByPlaceholder(ru.editorToolbar.imageCaptionPlaceholder).fill("From the menu")
  await page.keyboard.press("Enter")
  await expect(editor.locator(".amby-image-caption")).toHaveText("From the menu")
  // The alt text is typed into the field it was clicked in (the menu must not refuse the focus).
  await page.getByPlaceholder(ru.blockPanel.imagePlaceholder).click()
  await page.keyboard.type("A description")
  await page.keyboard.press("Enter")
  await expect(editor.locator('img[alt="A description"]')).toHaveCount(1)
  // The menu stays open for the next change, and the picture is not selected by it.
  await expect(panel).toBeVisible()

  // Alignment is a submenu with a choice.
  await panel.getByRole("button", { name: ru.blockPanel.align }).click()
  await page.getByRole("button", { name: ru.editorToolbar.imageAlignCenter }).click()
  await expect(editor.locator(".amby-image-wrap--center")).toHaveCount(1)
  await expect(page.locator("[data-image-toolbar]")).toHaveCount(0)

  await panel.getByRole("button", { name: ru.editorToolbar.imageOpen }).click()
  await expect(page.locator("[data-image-lightbox]")).toBeVisible()
})

test("the text toolbar starts at the selection, and ends at its right edge when it would not fit", async ({
  page,
}) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)

  const selectionEdges = () =>
    page.evaluate(() => {
      const rect = getSelection()!.getRangeAt(0).getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
  const toolbarEdges = async () => {
    const toolbar = page.locator(".amby-floating-menu").first()
    await expect(toolbar).toBeVisible()
    return toolbar.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
  }

  // A word near the left edge of the note: the toolbar starts where the selection starts.
  await editor.getByText("First paragraph").dblclick({ position: { x: 4, y: 8 } })
  const selected = await selectionEdges()
  const bar = await toolbarEdges()
  expect(Math.abs(bar.left - selected.left)).toBeLessThan(2)

  // The last word of a line in a narrow window: the toolbar would run out of the window, so it
  // ends at the right edge of the selection (or at the window's left edge, if that stops it).
  await page.setViewportSize({ width: 700, height: 800 })
  await page.waitForTimeout(300)
  await editor.getByText("Second paragraph").evaluate((paragraph) => {
    const text = paragraph.firstChild as Text
    const range = document.createRange()
    range.setStart(text, text.length - 4)
    range.setEnd(text, text.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await expect(page.locator(".amby-floating-menu").first()).toBeVisible()
  await page.waitForTimeout(300)
  const narrowSelection = await selectionEdges()
  const narrowBar = await toolbarEdges()
  const barWidth = narrowBar.right - narrowBar.left
  expect(narrowSelection.left + barWidth).toBeGreaterThan(700 - 8)
  expect(narrowBar.right).toBeLessThanOrEqual(700 - 8 + 0.5)
  expect(Math.abs(narrowBar.right - Math.max(narrowSelection.right, barWidth + 8))).toBeLessThan(2)
})

test("the text toolbar goes above the selection when there is no room under it", async ({
  page,
}) => {
  await seedVault(page, { Note: NOTE })
  await openInLive(page, "Note")
  const editor = liveEditor(page)
  // A window that ends just under the line that is going to be selected.
  const box = (await editor.getByText("Second paragraph").boundingBox())!
  await page.setViewportSize({ width: 1000, height: Math.round(box.y + box.height + 20) })
  await page.waitForTimeout(300)
  await editor.getByText("Second paragraph").evaluate((paragraph) => {
    const text = paragraph.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const toolbar = page.locator(".amby-floating-menu").first()
  await expect(toolbar).toBeVisible()
  await page.waitForTimeout(300)
  const edges = await page.evaluate(() => ({
    selectionTop: getSelection()!.getRangeAt(0).getBoundingClientRect().top,
    toolbarBottom: document.querySelector(".amby-floating-menu")!.getBoundingClientRect().bottom,
  }))
  expect(edges.toolbarBottom).toBeLessThanOrEqual(edges.selectionTop)
})

test("the text toolbar follows the selection when the note scrolls, and hides while it is out of sight", async ({
  page,
}) => {
  const lines = Array.from({ length: 70 }, (_, i) => `Line number ${i}`)
  await seedVault(page, { Long: ["Alpha word here", ...lines].join("\n\n") + "\n" })
  await openInLive(page, "Long")
  const editor = liveEditor(page)
  await editor.getByText("Alpha word here").evaluate((paragraph) => {
    const text = paragraph.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  const toolbar = page.locator(".amby-floating-menu").first()
  await expect(toolbar).toBeVisible()
  await page.waitForTimeout(300)
  const toolbarTop = async () => (await toolbar.boundingBox())!.y
  const selectionTop = () =>
    page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().top)
  const gap = (await toolbarTop()) - (await selectionTop())

  const box = (await editor.getByText("Line number 3", { exact: true }).boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 5)
  await page.mouse.wheel(0, 90)
  // It moves with the text, keeping its place under the selection.
  await expect
    .poll(async () => Math.abs((await toolbarTop()) - (await selectionTop()) - gap))
    .toBeLessThan(3)

  // Far down the selection is out of sight, and the toolbar with it.
  await page.mouse.wheel(0, 2500)
  await expect(toolbar).toBeHidden()
  // Back at the top it is there again.
  await page.mouse.wheel(0, -5000)
  await expect(toolbar).toBeVisible()
})
