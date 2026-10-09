import { expect, test, type Page } from "@playwright/test"
import {
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const START = "First line\n\n## Title\n\nLast line\n"

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Input: START, Empty: "" })
})

/** Opens the empty note with the cursor in it. */
async function openEmpty(page: Page) {
  await openInLive(page, "Empty")
  await liveEditor(page).click()
}

/** Pastes plain text the way a browser delivers it: a paste event with clipboard data. */
async function pastePlainText(page: Page, text: string) {
  await liveEditor(page).evaluate((element, text) => {
    const data = new DataTransfer()
    data.setData("text/plain", text)
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

async function pasteHtml(page: Page, html: string, text: string) {
  await liveEditor(page).evaluate(
    (element, { html, text }) => {
      const data = new DataTransfer()
      data.setData("text/html", html)
      data.setData("text/plain", text)
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { html, text },
  )
}

test("typing `- [ ] ` makes a task, not a bullet with `[ ] ` as text", async ({ page }) => {
  await openEmpty(page)
  await page.keyboard.type("- [ ] buy milk")
  await expect(liveEditor(page).locator('ul[data-type="taskList"] li')).toHaveCount(1)
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("- [ ] buy milk")
})

test("typing `1) ` starts a numbered list and `*** ` draws a rule", async ({ page }) => {
  await openEmpty(page)
  await page.keyboard.type("1) first")
  await expect(liveEditor(page).locator("ol li")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await page.keyboard.press("Enter")
  await page.keyboard.type("*** ")
  await expect(liveEditor(page).locator("hr")).toHaveCount(1)
  await expect.poll(() => storedMarkdown(page, "Empty")).toContain("1. first\n\n---")
})

test("Backspace at the start of a heading makes it a paragraph first", async ({ page }) => {
  await openInLive(page, "Input")
  await liveEditor(page).locator("h2").click()
  await page.keyboard.press("Meta+ArrowLeft")
  await page.keyboard.press("Backspace")
  await expect(liveEditor(page).locator("h2")).toHaveCount(0)
  await expect(liveEditor(page).locator("p")).toHaveText(["First line", "Title", "Last line"])
  await expect.poll(() => storedMarkdown(page, "Input")).toBe("First line\n\nTitle\n\nLast line\n")
})

test("Cmd+D duplicates the block and Cmd+Shift+arrows move it", async ({ page }) => {
  await openInLive(page, "Input")
  await liveEditor(page).getByText("Last line").click()
  await page.keyboard.press("Meta+d")
  await expect(liveEditor(page).locator("p")).toHaveText(["First line", "Last line", "Last line"])

  await liveEditor(page).locator("h2").click()
  await page.keyboard.press("Meta+Shift+ArrowUp")
  await expect
    .poll(() => storedMarkdown(page, "Input"))
    .toBe("## Title\n\nFirst line\n\nLast line\n\nLast line\n")
  await page.keyboard.press("Meta+Shift+ArrowDown")
  await expect
    .poll(() => storedMarkdown(page, "Input"))
    .toBe("First line\n\n## Title\n\nLast line\n\nLast line\n")
  await expectResponsive(page)
})

test("Cmd+K opens the link panel and links the selected text", async ({ page }) => {
  await openInLive(page, "Input")
  await liveEditor(page).getByText("First line").click()
  await page.keyboard.press("Meta+ArrowLeft")
  await page.keyboard.press("Shift+Meta+ArrowRight")
  await page.keyboard.press("Meta+k")
  const address = page.locator('.amby-floating-menu input[type="url"]')
  await expect(address).toBeFocused()
  await address.fill("https://example.invalid/page")
  await address.press("Enter")
  await expect(liveEditor(page).locator('a[href="https://example.invalid/page"]')).toHaveCount(1)
  await expect
    .poll(() => storedMarkdown(page, "Input"))
    .toBe("[First line](https://example.invalid/page)\n\n## Title\n\nLast line\n")
})

test("Cmd+K with nothing selected inserts a link with its text", async ({ page }) => {
  await openEmpty(page)
  await page.keyboard.press("Meta+k")
  const address = page.locator('.amby-floating-menu input[type="url"]')
  await expect(address).toBeFocused()
  await address.fill("https://example.invalid/")
  await page.locator('.amby-floating-menu input[type="text"]').fill("site")
  await address.press("Enter")
  await expect(liveEditor(page).locator("a")).toHaveText("site")
  await expect.poll(() => storedMarkdown(page, "Empty")).toBe("[site](https://example.invalid/)")
})

test("pasted Markdown text becomes blocks", async ({ page }) => {
  await openEmpty(page)
  await pastePlainText(
    page,
    [
      "# Heading",
      "",
      "- a",
      "- b",
      "",
      "| x | y |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```js",
      "let a",
      "```",
    ].join("\n"),
  )
  const editor = liveEditor(page)
  await expect(editor.locator("h1")).toHaveText("Heading")
  await expect(editor.locator("ul li")).toHaveCount(2)
  await expect(editor.locator("table td, table th")).toHaveCount(4)
  await expect(editor.locator("pre code")).toHaveText("let a")
  await expect
    .poll(() => storedMarkdown(page, "Empty"))
    .toBe("# Heading\n\n- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet a\n```")
})

test("pasted plain text and pasted HTML keep working", async ({ page }) => {
  await openEmpty(page)
  await pastePlainText(page, "Just a sentence.")
  await expect(liveEditor(page).locator("p")).toHaveText("Just a sentence.")
  await page.keyboard.press("Enter")
  await pasteHtml(page, "<p>Rich <strong>bold</strong> text</p>", "Rich bold text")
  await expect(liveEditor(page).locator("strong")).toHaveText("bold")
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Empty")).toBe("Just a sentence.\n\nRich **bold** text")
})

test("a paste that carries Markdown and its rendered copy keeps wikilinks and callouts", async ({
  page,
}) => {
  await openEmpty(page)
  // What Obsidian puts on the clipboard for a copied part of a note.
  const markdown = "### Plans\n\n[[Finance]]\n[[Schedule]]\n\n> [!ask]\n> Why?"
  const rendered =
    '<h3>Plans</h3><p><a class="internal-link" href="Finance">Finance</a><br>' +
    '<a class="internal-link" href="Schedule">Schedule</a></p><div class="callout">Ask</div>'
  await pasteHtml(page, rendered, markdown)
  const editor = liveEditor(page)
  await expect(editor.locator("h3")).toHaveText("Plans")
  await expect(editor.locator(".amby-live-wikilink-button")).toHaveText(["Finance", "Schedule"])
  // The callout is checked by what is saved: a callout again, not the word "Ask".
  await expect
    .poll(() => storedMarkdown(page, "Empty"))
    .toBe("### Plans\n\n[[Finance]]\n[[Schedule]]\n\n> [!ASK]\n> Why?")
})
