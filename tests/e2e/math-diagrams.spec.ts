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

const mathBlock = (page: import("@playwright/test").Page) =>
  liveEditor(page).locator(".amby-math-block")
const texArea = (page: import("@playwright/test").Page) =>
  liveEditor(page).locator(".amby-math-block textarea")

test("a click on a display formula opens its TeX; Mod-Enter writes it as one step", async ({
  page,
}) => {
  await openInLive(page, "Math")
  await mathBlock(page).locator(".amby-math-render").click()
  await expect(texArea(page)).toBeFocused()
  // The TeX without its dollar lines.
  await expect(texArea(page)).toHaveValue("\\int_0^1 x\\,dx = \\frac{1}{2}")
  // An open text area is not an edit and does not keep the editor redrawing.
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)

  await page.keyboard.press("Meta+a")
  await page.keyboard.type("\\sum_{i=1}^n a_i * b_i = \\sqrt{c_1}")
  // The formula follows what is typed; the note does not change yet.
  await expect(mathBlock(page).locator(".amby-math-render .katex")).toContainText("∑")
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)

  await page.keyboard.press("Meta+Enter")
  await expect(texArea(page)).toHaveCount(0)
  const edited = MATH.replace(
    "\\int_0^1 x\\,dx = \\frac{1}{2}",
    "\\sum_{i=1}^n a_i * b_i = \\sqrt{c_1}",
  )
  await expect.poll(() => storedMarkdown(page, "Math")).toBe(edited)
  await expect(mathBlock(page).locator(".amby-math-render .katex")).toContainText("∑")
  await expect(liveEditor(page).locator(".amby-math-inline .katex")).toHaveCount(2)

  // One undo gives the file back, byte for byte.
  await expect(liveEditor(page)).toBeFocused()
  await page.keyboard.press("Meta+z")
  await expect.poll(() => storedMarkdown(page, "Math")).toBe(MATH)
  await expect(mathBlock(page).locator(".amby-math-render .katex")).toContainText("∫")
  await expectResponsive(page)
})

test("Escape drops what was typed in a formula; a click outside applies it", async ({ page }) => {
  await openInLive(page, "Math")
  await mathBlock(page).locator(".amby-math-render").click()
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.press("Meta+a")
  await page.keyboard.type("dropped")
  await page.keyboard.press("Escape")
  await expect(texArea(page)).toHaveCount(0)
  await expect(mathBlock(page).locator(".amby-math-render .katex")).toContainText("∫")
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)

  // Enter on the selected block opens it again, from the keyboard.
  await expect(mathBlock(page)).toHaveClass(/is-selected/)
  await page.keyboard.press("Enter")
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.press("Meta+a")
  await page.keyboard.type("a^2 + b^2\n= c^2")
  await liveEditor(page).getByText("which is money").click()
  await expect(texArea(page)).toHaveCount(0)
  await expect
    .poll(() => storedMarkdown(page, "Math"))
    .toBe(MATH.replace("\\int_0^1 x\\,dx = \\frac{1}{2}", "a^2 + b^2\n= c^2"))
  await expectEditorSettles(page)
})

test("TeX the file cannot hold as a formula stays open and is not written", async ({ page }) => {
  await openInLive(page, "Math")
  await mathBlock(page).locator(".amby-math-render").click()
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.press("Meta+a")
  await page.keyboard.type("a\n\n- b")
  await page.keyboard.press("Meta+Enter")
  await expect(texArea(page)).toBeVisible()
  await expect(mathBlock(page).locator(".amby-math-error")).toBeVisible()
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Math")).toBe(MATH)
  await page.keyboard.press("Escape")
  await expect(mathBlock(page).locator(".amby-math-render .katex")).toContainText("∫")
  expect(await storedMarkdown(page, "Math")).toBe(MATH)
})

test("`$$` and Enter on an empty line make a formula to write in", async ({ page }) => {
  await openInLive(page, "Math")
  await liveEditor(page).getByText("which is money").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.press("Enter")
  await page.keyboard.type("$$")
  await page.keyboard.press("Enter")
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.type("e^{i\\pi} + 1 = 0")
  await page.keyboard.press("Meta+Enter")
  await expect(mathBlock(page)).toHaveCount(2)
  await expect
    .poll(() => storedMarkdown(page, "Math"))
    .toBe(`${MATH.trimEnd()}\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n`)

  // A formula that was made and left with Escape is taken away again.
  await liveEditor(page).getByText("in a line.").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.press("Enter")
  await page.keyboard.type("$$")
  await page.keyboard.press("Enter")
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(mathBlock(page)).toHaveCount(2)
  await page.keyboard.type("Typed after")
  await expect(liveEditor(page).getByText("Typed after")).toBeVisible()
  await expectResponsive(page)
})

test("the slash menu makes a formula", async ({ page }) => {
  await openInLive(page, "Math")
  await liveEditor(page).getByText("which is money").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.press("Enter")
  await page.keyboard.type("/формула")
  await expect(page.locator(".amby-block-panel--insert [role=option]")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(texArea(page)).toBeFocused()
  await page.keyboard.type("x_1")
  await page.keyboard.press("Meta+Enter")
  await expect.poll(() => storedMarkdown(page, "Math")).toBe(`${MATH.trimEnd()}\n\n$$\nx_1\n$$\n`)
  await expectEditorSettles(page)
})
