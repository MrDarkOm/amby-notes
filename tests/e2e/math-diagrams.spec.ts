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

const MATH = [
  "Arrow $\\rightarrow$ and a set $\\{a, b\\}$ in a line.",
  "",
  "$$",
  "\\int_0^1 x\\,dx = \\frac{1}{2}",
  "$$",
  "",
  "It costs $5 and $10, which is money.",
  "",
].join("\n")

const DIAGRAM = [
  "Flow:",
  "",
  "```mermaid",
  "graph TD",
  "  A[Start] --> B[End]",
  "```",
  "",
  "After",
  "",
].join("\n")

test.beforeEach(async ({ page }) => {
  await seedVault(page, { Math: MATH, Diagram: DIAGRAM })
})

/** Puts the cursor at the end of the diagram's code, whatever is being drawn around it. */
async function endOfCode(page: import("@playwright/test").Page) {
  await liveEditor(page).evaluate((element) => {
    const editor = (element as HTMLElement & { editor: import("@tiptap/core").Editor }).editor
    let end = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") end = pos + node.nodeSize - 1
    })
    editor.chain().focus().setTextSelection(end).run()
  })
}

test("formulas are drawn in Live and the note is not changed", async ({ page }) => {
  await openInLive(page, "Math")
  const editor = liveEditor(page)
  // Two inline formulas and one display formula; the prices are left as text.
  await expect(editor.locator(".amby-math-inline .katex")).toHaveCount(2)
  await expect(editor.locator(".amby-math-block.is-drawn .amby-math-render .katex")).toHaveCount(1)
  await expect(editor.locator(".amby-math-block > pre")).toBeHidden()
  await expect(editor.getByText("It costs $5 and $10, which is money.")).toBeVisible()
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)
  await expectResponsive(page)
})

test("editing next to a formula keeps its backslashes in the file", async ({ page }) => {
  await openInLive(page, "Math")
  await liveEditor(page).getByText("in a line.").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" Typed $\\frac{a}{b}$ too.")
  await expect
    .poll(() => storedMarkdown(page, "Math"))
    .toBe(MATH.replace("in a line.", "in a line. Typed $\\frac{a}{b}$ too."))
  await expect(liveEditor(page).locator(".amby-math-inline .katex")).toHaveCount(3)
})

test("a click on an inline formula shows its text for editing", async ({ page }) => {
  await openInLive(page, "Math")
  const editor = liveEditor(page)
  await editor.locator(".amby-math-inline").first().click()
  await expect(editor.locator(".amby-math-inline")).toHaveCount(1)
  await expect(editor.getByText("$\\rightarrow$")).toBeVisible()
  // Moving away draws it again.
  await editor.getByText("which is money").click()
  await expect(editor.locator(".amby-math-inline .katex")).toHaveCount(2)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)
})

test("a Mermaid block shows its diagram above the code and follows edits", async ({ page }) => {
  await openInLive(page, "Diagram")
  const block = liveEditor(page).locator(".amby-code-block.has-diagram")
  await expect(block.locator(".amby-mermaid-render svg")).toBeVisible()
  await expect(block.locator(".amby-mermaid-render")).toContainText("Start")
  await expect(block.locator("code")).toContainText("graph TD")
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Diagram")).toBe(DIAGRAM)

  await endOfCode(page)
  await page.keyboard.type("\n  B --> C[Done]")
  await expect(block.locator(".amby-mermaid-render")).toContainText("Done")
  await expect
    .poll(() => storedMarkdown(page, "Diagram"))
    .toBe(DIAGRAM.replace("B[End]", "B[End]\n  B --> C[Done]"))
  await expectResponsive(page)
})

test("a diagram with a mistake keeps the last drawing and the code stays editable", async ({
  page,
}) => {
  await openInLive(page, "Diagram")
  const block = liveEditor(page).locator(".amby-code-block.has-diagram")
  await expect(block.locator(".amby-mermaid-render svg")).toBeVisible()
  await endOfCode(page)
  await page.keyboard.type("\n  B --> [[[")
  await expect(block.locator(".amby-mermaid-render.is-error")).toHaveCount(1)
  await expect(block.locator(".amby-mermaid-render svg")).toBeVisible()
  await expectResponsive(page)
  await expect
    .poll(() => storedMarkdown(page, "Diagram"))
    .toBe(DIAGRAM.replace("B[End]", "B[End]\n  B --> [[["))
})
