import { expect, test } from "@playwright/test"
import {
  expectEditorSettles,
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const TABLE = [
  "Before",
  "",
  "| Name | Age |",
  "| :--- | ---: |",
  "| Ann | 30 |",
  "| Bob | 41 |",
  "",
  "After",
  "",
].join("\n")

const CODE = [
  "Intro",
  "",
  "```js",
  "const answer = 42 // comment",
  'console.log("hi")',
  "```",
  "",
  "Outro",
  "",
].join("\n")

test.beforeEach(async ({ page }) => {
  // The clipboard of a headless browser is not available: record what would be copied.
  await page.addInitScript(() => {
    const copied: string[] = []
    ;(window as unknown as { e2eCopied: string[] }).e2eCopied = copied
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text)
        },
      },
    })
  })
  await seedVault(page, { Table: TABLE, Code: CODE })
})

const controls = (page: import("@playwright/test").Page, part: string) =>
  page.locator(`[data-table-controls="${part}"]`)

test("table controls appear in a table and add rows and columns at its edges", async ({ page }) => {
  await openInLive(page, "Table")
  await expect(controls(page, "bar")).toHaveCount(0)
  await liveEditor(page).getByText("Ann").click()
  await expect(controls(page, "bar")).toBeVisible()
  // Showing the controls is not an edit, and nothing keeps redrawing.
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Table")).toBe(TABLE)

  await controls(page, "add-row").click()
  await expect(liveEditor(page).locator("tr")).toHaveCount(4)
  await page.keyboard.type("Cid")
  await controls(page, "add-column").click()
  await page.keyboard.type("City")
  await expect
    .poll(() => storedMarkdown(page, "Table"))
    .toBe(
      [
        "Before",
        "",
        "| Name | Age | City |",
        "| :--- | ---: | --- |",
        "| Ann | 30 |   |",
        "| Bob | 41 |   |",
        "| Cid |   |   |",
        "",
        "After",
        "",
      ].join("\n"),
    )
  await expectResponsive(page)
})

test("rows and columns are inserted and deleted around the current cell", async ({ page }) => {
  await openInLive(page, "Table")
  await liveEditor(page).getByText("Ann").click()
  const bar = controls(page, "bar")
  await bar.getByRole("button", { name: "Вставить строку выше" }).click()
  await page.keyboard.type("New")
  await bar.getByRole("button", { name: "Вставить столбец справа" }).click()
  await page.keyboard.type("x")
  await expect
    .poll(() => storedMarkdown(page, "Table"))
    .toBe(
      [
        "Before",
        "",
        "| Name |   | Age |",
        "| :--- | --- | ---: |",
        "| New | x |   |",
        "| Ann |   | 30 |",
        "| Bob |   | 41 |",
        "",
        "After",
        "",
      ].join("\n"),
    )

  await bar.getByRole("button", { name: "Удалить столбец" }).click()
  await liveEditor(page).getByText("Name").click()
  await bar.getByRole("button", { name: "Удалить строку" }).click()
  // The row under a deleted header row becomes the header.
  await expect(liveEditor(page).locator("th")).toHaveText(["New", ""])
  await expect
    .poll(() => storedMarkdown(page, "Table"))
    .toBe(
      [
        "Before",
        "",
        "| New |   |",
        "| :--- | ---: |",
        "| Ann | 30 |",
        "| Bob | 41 |",
        "",
        "After",
        "",
      ].join("\n"),
    )

  await bar.getByRole("button", { name: "Удалить таблицу" }).click()
  await expect(liveEditor(page).locator("table")).toHaveCount(0)
  await expect(bar).toHaveCount(0)
  await expect.poll(() => storedMarkdown(page, "Table")).toBe("Before\n\nAfter\n")
})

test("a code block is coloured, shows its language and copies its text", async ({ page }) => {
  await openInLive(page, "Code")
  const block = liveEditor(page).locator(".amby-code-block")
  await expect(block.locator(".amby-code-block-language")).toHaveText("js")
  await expect(block.locator(".hljs-keyword").first()).toHaveText("const")
  await expect(block.locator(".hljs-comment")).toHaveText("// comment")
  await expect(block.locator("code")).toHaveText('const answer = 42 // comment console.log("hi")')

  await block.hover()
  await block.getByRole("button", { name: "Копировать" }).click()
  await expect(block.locator(".amby-code-block-copy")).toHaveText("Скопировано")
  expect(
    await page.evaluate(() => (window as unknown as { e2eCopied: string[] }).e2eCopied),
  ).toEqual(['const answer = 42 // comment\nconsole.log("hi")'])
  await expect(block.locator(".amby-code-block-copy")).toHaveText("Копировать")

  // Colours, the label and the button are not part of the note.
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Code")).toBe(CODE)
})

test("typing in a code block changes only its text", async ({ page }) => {
  await openInLive(page, "Code")
  // The string is on the last line of the block.
  await liveEditor(page).locator(".amby-code-block .hljs-string").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type("\nlet next = 1")
  await expect
    .poll(() => storedMarkdown(page, "Code"))
    .toBe(CODE.replace('console.log("hi")', 'console.log("hi")\nlet next = 1'))
  await expect(liveEditor(page).locator(".amby-code-block .hljs-keyword")).toHaveText([
    "const",
    "let",
  ])
})

test("typing a fence with a language makes a coloured block", async ({ page }) => {
  await openInLive(page, "Code")
  await liveEditor(page).getByText("Outro").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.press("Enter")
  await page.keyboard.type("```python ")
  await page.keyboard.type("def run(): pass")
  const blocks = liveEditor(page).locator(".amby-code-block")
  await expect(blocks).toHaveCount(2)
  await expect(blocks.last().locator(".amby-code-block-language")).toHaveText("python")
  await expect(blocks.last().locator(".hljs-keyword").first()).toHaveText("def")
  await expect
    .poll(() => storedMarkdown(page, "Code"))
    .toBe(`${CODE.trimEnd()}\n\n\`\`\`python\ndef run(): pass\n\`\`\`\n`)
})
