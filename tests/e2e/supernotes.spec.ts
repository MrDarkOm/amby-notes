import { expect } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import { liveEditor, storedMarkdown, test } from "./support"

const ru = localeResources.ru.translation

test("turning off Supernotes lets users delete a file without deleting its folder", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("amby:tree")) return
    const root = "web-vault"
    const main = root + "/Project/Project.md"
    const child = root + "/Project/Child.md"
    localStorage.setItem(
      "amby:tree",
      JSON.stringify([
        { id: root + "/Folder", path: root + "/Folder", name: "Folder", type: "folder" },
        {
          id: main,
          path: main,
          name: "Project",
          type: "file",
          children: [{ id: child, path: child, name: "Child", type: "file" }],
        },
      ]),
    )
    localStorage.setItem("amby:file:" + main, "# Project\n\nProject body.\n")
    localStorage.setItem("amby:file:" + child, "# Child\n\nChild body.\n")
    localStorage.setItem(
      "amby:file:" + root + "/Project/Project.canvas",
      '{"nodes":[],"edges":[]}\n',
    )
    localStorage.setItem(
      "amby:vmeta:workspace.json",
      JSON.stringify({
        profile: { id: "custom", catalogRevision: "2026-11-21" },
        enabledModules: ["amby.supernotes", "amby.canvas"],
        layout: { activePresetId: "custom-supernotes" },
        confirmations: { confirmFileDelete: false },
        customPresets: [
          {
            id: "custom-supernotes",
            label: "Supernotes test",
            activeModules: ["supernotes", "canvas"],
            layout: [],
            activeBySide: { left: "files", right: null },
          },
        ],
      }),
    )
  })

  await page.goto("/")
  const folder = page.locator('[data-tree-item-id="web-vault/Folder"]')
  const project = page.locator('[data-tree-item-id="web-vault/Project/Project.md"]')
  const convert = page.getByRole("menuitem", { name: ru.tree.convertToNote })
  await folder.click({ button: "right" })
  await expect(convert).toBeVisible()
  await page.keyboard.press("Escape")

  await project.click()
  await page
    .locator('[data-help-target="layers"]')
    .getByRole("button", { name: ru.docEditor.canvasLayer, exact: true })
    .click()
  await expect(page.locator(".react-flow")).toBeVisible()

  const openModules = async () => {
    await page.locator('[data-activity-button="settings"]').first().click()
    await page.getByText(ru.settings.tabs.modules, { exact: true }).click()
  }
  await openModules()
  const toggle = page.getByRole("switch", { name: ru.settings.modules.supernotes })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem("amby:vmeta:workspace.json") ?? "{}")
        return workspace.enabledModules.includes("amby.supernotes")
      }),
    )
    .toBe(false)
  await page.keyboard.press("Escape")
  await expect(liveEditor(page)).toBeVisible()
  await expect(liveEditor(page)).toContainText("Project body.")
  await expect(page.locator(".react-flow")).toBeHidden()
  await page.reload()

  await folder.click({ button: "right" })
  await expect(convert).toHaveCount(0)
  await page.keyboard.press("Escape")
  const bundleFolder = page.locator('[data-tree-item-id="folder:web-vault/Project"]')
  await bundleFolder.click()
  await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible()
  if ((await bundleFolder.getAttribute("aria-expanded")) === "false") {
    await bundleFolder.press("ArrowRight")
  }
  await page.getByRole("button", { name: ru.folderView.newFolder, exact: true }).click()
  await expect(
    page.locator(`[data-tree-item-id="web-vault/Project/${ru.defaults.untitled}"]`),
  ).toBeVisible()
  const canvas = page.locator('[data-tree-item-id="web-vault/Project/Project.canvas"]')
  await expect(canvas).toBeVisible()
  await canvas.click()
  await expect(page.locator(".react-flow")).toBeVisible()
  await project.click({ button: "right" })
  await expect(page.getByRole("menuitem", { name: ru.tree.nest })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: ru.tree.rename, exact: true })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: ru.tree.delete, exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await project.click()
  await expect(liveEditor(page)).toContainText("Project body.")
  expect(await storedMarkdown(page, "Project/Project")).toBe("# Project\n\nProject body.\n")
  expect(await storedMarkdown(page, "Project/Child")).toBe("# Child\n\nChild body.\n")

  await bundleFolder.press("F2")
  const rename = bundleFolder.getByRole("textbox")
  await rename.fill("Renamed")
  await rename.press("Enter")
  await expect(page.locator('[data-tree-item-id="folder:web-vault/Renamed"]')).toBeVisible()
  expect(await storedMarkdown(page, "Renamed/Renamed")).toBe("# Project\n\nProject body.\n")
  expect(await storedMarkdown(page, "Renamed/Child")).toBe("# Child\n\nChild body.\n")
  expect(
    await page.evaluate(() => localStorage.getItem("amby:file:web-vault/Renamed/Renamed.canvas")),
  ).toBe('{"nodes":[],"edges":[]}\n')

  const renamedFile = page.locator('[data-tree-item-id="web-vault/Renamed/Renamed.md"]')
  await renamedFile.click({ button: "right" })
  await page.getByRole("menuitem", { name: ru.tree.delete, exact: true }).click()
  await expect(renamedFile).toHaveCount(0)
  await expect(page.locator('[data-tree-item-id="folder:web-vault/Renamed"]')).toBeVisible()
  await expect(page.locator('[data-tree-item-id="web-vault/Renamed/Renamed.canvas"]')).toBeVisible()
  expect(await storedMarkdown(page, "Renamed/Renamed")).toBeNull()
  expect(await storedMarkdown(page, "Renamed/Child")).toBe("# Child\n\nChild body.\n")
  expect(
    await page.evaluate(() => localStorage.getItem("amby:file:web-vault/Renamed/Renamed.canvas")),
  ).toBe('{"nodes":[],"edges":[]}\n')

  await openModules()
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
})
