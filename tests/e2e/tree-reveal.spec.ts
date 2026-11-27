import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { expectResponsive, test } from "./support"

const text = localeResources.ru.translation.filesPanel
const tabs = localeResources.ru.translation.tabs
const tree = localeResources.ru.translation.tree
const VAULT = "web-vault"

/** Two root notes for sorting and one inside the folder Box. */
async function seed(page: Page) {
  const file = (path: string, name: string) => ({
    id: `${VAULT}/${path}`,
    path: `${VAULT}/${path}`,
    name,
    type: "file",
    icon: "file",
  })
  const tree = [
    file("Top.md", "Top"),
    file("Alpha.md", "Alpha"),
    {
      id: `${VAULT}/Box`,
      path: `${VAULT}/Box`,
      name: "Box",
      type: "folder",
      icon: "folder",
      children: [file("Box/Inner.md", "Inner")],
    },
  ]
  await page.addInitScript((tree) => {
    if (localStorage.getItem("amby:e2e-seeded")) return
    localStorage.setItem("amby:e2e-seeded", "1")
    localStorage.setItem("amby:tree", JSON.stringify(tree))
    localStorage.setItem("amby:file:web-vault/Top.md", "Top note\n")
    localStorage.setItem("amby:file:web-vault/Box/Inner.md", "Inner note\n")
  }, tree)
  await page.goto("/")
}

const tab = (page: Page, name: string) =>
  page.getByRole("banner").first().getByText(name, { exact: true })

/** Closes the folder Box with its arrow (a click on the row only selects it). */
const closeBox = (page: Page) =>
  page.getByRole("tree").getByRole("button", { name: tree.collapse, exact: true }).click()

const row = (page: Page, name: string) =>
  page.getByRole("tree").getByRole("treeitem").filter({ hasText: name }).first()

test("the tree opens the folder of the file that becomes active", async ({ page }) => {
  await seed(page)
  await row(page, "Inner").click()
  await expect(page.locator(".ProseMirror:visible")).toContainText("Inner note")
  // A second tab with the other note.
  await page.getByRole("button", { name: tabs.newTab, exact: true }).click()
  await page.keyboard.type("Top")
  await page.keyboard.press("Enter")
  await expect(page.locator(".ProseMirror:visible")).toContainText("Top note")
  await closeBox(page)
  await expect(row(page, "Inner")).toHaveCount(0)

  // Off by default: back on the tab with the inner note, the tree is left as it is.
  const toggle = page.getByRole("button", { name: text.autoReveal })
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
  await tab(page, "Inner").click()
  await expect(page.locator(".ProseMirror:visible")).toContainText("Inner note")
  await expect(row(page, "Inner")).toHaveCount(0)

  // Switched on, it shows the current file at once.
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(row(page, "Inner")).toBeVisible()

  // And from then on the folder of the file that becomes active opens by itself.
  await tab(page, "Top").click()
  await closeBox(page)
  await expect(row(page, "Inner")).toHaveCount(0)
  await tab(page, "Inner").click()
  await expect(row(page, "Inner")).toBeVisible()
  await expectResponsive(page)
})

test("empty tree area menu shares sorting, filters and expansion with the panel", async ({
  page,
}) => {
  await seed(page)
  const files = page.locator('[data-help-scope="files"]')
  const openRootMenu = async () => {
    const bounds = await page.getByRole("tree").boundingBox()
    if (!bounds) throw new Error("Tree is missing")
    await page.mouse.click(bounds.x + 20, bounds.y + bounds.height - 20, { button: "right" })
    await expect(page.getByRole("menuitem", { name: text.newNote, exact: true })).toBeVisible()
  }

  await openRootMenu()
  await page.getByRole("menuitem", { name: text.collapseAll, exact: true }).click()
  await expect(row(page, "Inner")).toHaveCount(0)
  await openRootMenu()
  await page.getByRole("menuitem", { name: text.expandAll, exact: true }).click()
  await expect(row(page, "Inner")).toBeVisible()

  await openRootMenu()
  await page.getByRole("menuitemcheckbox", { name: text.autoReveal, exact: true }).click()
  await expect(files.getByRole("button", { name: text.autoReveal })).toHaveAttribute(
    "aria-pressed",
    "true",
  )

  await openRootMenu()
  await page.getByRole("menuitem", { name: text.sortOrder, exact: true }).hover()
  await page.getByRole("menuitemradio", { name: text.sortNameDesc, exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("amby:tree-sort") ?? "{}")))
    .toEqual({ key: "name", direction: "desc" })
  const roots = page.getByRole("tree").locator('[role="treeitem"][aria-level="1"]')
  await expect(roots.nth(1)).toContainText("Top")
  await expect(roots.nth(2)).toContainText("Alpha")

  await openRootMenu()
  await page.getByRole("menuitem", { name: text.filter, exact: true }).hover()
  const notes = page.getByRole("menuitemcheckbox", { name: text.filterNotes, exact: true })
  await notes.click()
  await expect(notes).toHaveAttribute("aria-checked", "true")
  await page.getByRole("menuitem", { name: text.filterReset, exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem("amby:tree-type-filter") ?? "[]")),
    )
    .toEqual([])

  // A row keeps its own menu; a root command never leaks into it.
  await row(page, "Top").click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: tree.rename, exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: text.expandAll, exact: true })).toHaveCount(0)
})
