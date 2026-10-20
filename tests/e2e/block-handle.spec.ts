import { expect, type Page } from "@playwright/test"
import { liveEditor, openInLive, seedVault, test } from "./support"

const NOTE = "## Upper line\n\n## Lower line\n\nTail\n"

/** The heading the block handle stands at: the one whose top it is level with. */
async function handleHeading(page: Page): Promise<string | null> {
  const handle = page.locator(".amby-block-handles")
  await expect(handle).toBeVisible()
  await expect(handle).toHaveCSS("opacity", "1")
  return page.evaluate(() => {
    const top = document.querySelector(".amby-block-handles")!.getBoundingClientRect().top
    const headings = Array.from(document.querySelectorAll(".ProseMirror h2"))
    const level = headings.find((h) => Math.abs(h.getBoundingClientRect().top - top) < 6)
    return level?.textContent ?? null
  })
}

/** The heading the text cursor is in. */
function caretHeading(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const node = getSelection()?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    return element?.closest("h2")?.textContent ?? null
  })
}

test("between two lines the handle stands at the line a click puts the cursor in", async ({
  page,
}) => {
  await seedVault(page, { Gap: NOTE })
  await openInLive(page, "Gap")
  const upper = (await liveEditor(page).getByText("Upper line").boundingBox())!
  const lower = (await liveEditor(page).getByText("Lower line").boundingBox())!
  const gapTop = upper.y + upper.height
  const gap = lower.y - gapTop
  // The check needs room between the lines to point into.
  expect(gap).toBeGreaterThan(6)
  const x = upper.x + 40

  for (const [share, expected] of [
    [0.2, "Upper line"],
    [0.8, "Lower line"],
  ] as const) {
    const y = gapTop + gap * share
    // Away first, so that the handle is placed anew for this point.
    await page.mouse.move(x, lower.y + lower.height + 200)
    await expect(page.locator(".amby-block-handles")).toHaveCount(0)
    await page.mouse.move(x, y, { steps: 3 })
    expect(await handleHeading(page), `handle at ${share} of the gap`).toBe(expected)
    await page.mouse.click(x, y)
    await expect.poll(() => caretHeading(page), `cursor at ${share} of the gap`).toBe(expected)
  }
})

const COLUMNS = [
  "Outside",
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
].join("\n")

test("column text lines up with the note and its first letters take a click", async ({ page }) => {
  await seedVault(page, { Columns: COLUMNS })
  await openInLive(page, "Columns")
  const editor = liveEditor(page)
  const outside = (await editor.getByText("Outside").boundingBox())!
  const inside = (await editor.getByText("Left text").boundingBox())!
  expect(Math.abs(inside.x - outside.x)).toBeLessThan(1)

  // The handle shows beside the line; its hover bridge must not cover the text.
  await editor.getByText("Outside").click()
  await page.mouse.move(inside.x + 20, inside.y + inside.height / 2)
  await expect(page.locator(".amby-block-handles")).toBeVisible()
  await page.mouse.click(inside.x + 3, inside.y + inside.height / 2)
  const caret = await page.evaluate(() => {
    const selection = getSelection()!
    return { text: selection.anchorNode?.textContent, offset: selection.anchorOffset }
  })
  expect(caret).toEqual({ text: "Left text", offset: 0 })
})
