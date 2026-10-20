import { expect, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { expectResponsive, test } from "./support"

const text = localeResources.ru.translation.filesPanel
const tabs = localeResources.ru.translation.tabs
const tree = localeResources.ru.translation.tree
const VAULT = "web-vault"

/** A note at the top and one inside the folder Box. */
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
