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
