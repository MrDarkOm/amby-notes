import { expect } from "@playwright/test"
import { test } from "./support"

for (const expandOnly of [false, true]) {
  test(`folder activation with expand-only=${expandOnly}`, async ({ page }) => {
    await page.addInitScript((enabled) => {
      if (localStorage.getItem("amby:folder-test-seeded")) return
      localStorage.setItem("amby:folder-test-seeded", "1")
      localStorage.setItem("amby:file:web-vault/Folder/Child.md", "Child body.\n")
      const child = {
        id: "web-vault/Folder/Child.md",
        path: "web-vault/Folder/Child.md",
        name: "Child",
        type: "file",
      }
      localStorage.setItem(
        "amby:tree",
        JSON.stringify([
          {
            id: "web-vault/Folder",
            path: "web-vault/Folder",
            name: "Folder",
            type: "folder",
            children: [child],
          },
          {
            id: "web-vault/Empty",
            path: "web-vault/Empty",
            name: "Empty",
            type: "folder",
            children: [],
          },
        ]),
      )
      localStorage.setItem(
        "amby:g:settings.json",
        JSON.stringify({ schemaVersion: 1, prefs: { files: { folderClickToggles: enabled } } }),
      )
    }, expandOnly)
    await page.goto("/")
    const folder = page.locator('[data-tree-item-id="web-vault/Folder"]')
    await expect(folder).toBeVisible()
    await folder.click()
    if (!expandOnly) {
      await expect(page.getByRole("heading", { name: "Folder", exact: true })).toBeVisible()
      return
    }
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    await expect(page.getByRole("heading", { name: "Folder", exact: true })).toHaveCount(0)
    await folder.press("Space")
    await expect(folder).toHaveAttribute("aria-expanded", "true")
    await folder.press("Enter")
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    await page.locator('[data-tree-item-id="web-vault/Empty"]').click()
    await expect(page.getByRole("heading", { name: "Empty", exact: true })).toHaveCount(0)
    await folder.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Открыть в новой вкладке", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Folder", exact: true })).toBeVisible()
  })
}
