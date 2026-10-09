import { expect, test, type Page } from "@playwright/test"
import { localeResources } from "../../src/locales/resources"
import {
  expectEditorSettles,
  expectResponsive,
  liveEditor,
  openInLive,
  seedVault,
  storedMarkdown,
  waitForAutosaveWindow,
} from "./support"

const text = localeResources.ru.translation.attachment

const NOTE = [
  "Intro line.",
  "",
  "![beep.wav](assets/beep.wav)",
  "",
  "![missing.mp4](assets/missing.mp4)",
  "",
  "![report.pdf](assets/report.pdf)",
  "",
  "![[beep.wav]]",
  "",
  "![[report.pdf#page=3]]",
  "",
  "![outside.mp4](https://example.com/outside.mp4)",
  "",
  "[plain.pdf](assets/plain.pdf)",
  "",
  "Closing line.",
  "",
].join("\n")

/** A half-second of silence as a WAV file: small, and every browser can play it. */
function silentWav(): Buffer {
  const samples = 4000
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + samples, 4)
  header.write("WAVEfmt ", 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write("data", 36)
  header.writeUInt32LE(samples, 40)
  return Buffer.concat([header, Buffer.alloc(samples, 0x80)])
}

async function serveFiles(page: Page, requested: string[]) {
  await page.route("**/web-vault/**", (route) => {
    const path = new URL(route.request().url()).pathname
    requested.push(path)
    if (path.endsWith("/assets/beep.wav")) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() })
    }
    return route.fulfill({ status: 404, body: "" })
  })
}

test("audio is played in place, a PDF is a card, and the note keeps its bytes", async ({
  page,
}) => {
  const requested: string[] = []
  const outside: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (/^https?:$/u.test(url.protocol) && url.hostname !== "localhost") outside.push(request.url())
  })
  await serveFiles(page, requested)
  await seedVault(page, { Files: NOTE })
  await openInLive(page, "Files")
  const editor = liveEditor(page)

  // `![beep.wav](assets/beep.wav)` and `![[beep.wav]]` both become a player that loaded the file.
  const players = editor.locator("audio")
  await expect(players).toHaveCount(2)
  for (const index of [0, 1]) {
    await expect
      .poll(() => players.nth(index).evaluate((audio: HTMLAudioElement) => audio.duration))
      .toBeGreaterThan(0.3)
    await expect(players.nth(index)).toHaveAttribute("controls", "")
  }

  // A PDF is a card with its name; so is the Obsidian embed of one.
  await expect(editor.locator('[data-attachment="pdf"]')).toHaveCount(2)
  await expect(editor.locator('[data-attachment="pdf"]').first()).toContainText("report.pdf")
  await expect(editor.locator('[data-attachment="pdf"]').first()).toContainText(text.pdf)

  // A video that cannot be loaded falls back to a card instead of a dead player.
  const missing = editor.locator('[data-attachment="video"]', { hasText: "missing.mp4" })
  await expect(missing).toContainText(text.unplayable)
  await expect(editor.locator("video")).toHaveCount(0)

  // An address outside the vault is not loaded at all.
  const remote = editor.locator('[data-attachment="video"]', { hasText: "outside.mp4" })
  await expect(remote).toContainText(text.remote)
  expect(outside).toEqual([])

  // A plain link stays a link.
  await expect(editor.getByRole("link", { name: "plain.pdf" })).toBeVisible()
  await expect(editor.locator('[data-attachment="pdf"]', { hasText: "plain.pdf" })).toHaveCount(0)

  expect(requested.some((path) => path.endsWith("/assets/beep.wav"))).toBe(true)
  await expectEditorSettles(page)
  await waitForAutosaveWindow(page)
  expect(await storedMarkdown(page, "Files")).toBe(NOTE)
  await expectResponsive(page)
})

test("typing next to attachments rewrites only the edited paragraph", async ({ page }) => {
  await serveFiles(page, [])
  await seedVault(page, { Files: NOTE })
  await openInLive(page, "Files")
  await liveEditor(page).getByText("Closing line.").click()
  await page.keyboard.press("Meta+ArrowRight")
  await page.keyboard.type(" Typed.")
  await expect
    .poll(() => storedMarkdown(page, "Files"))
    .toBe(NOTE.replace("Closing line.", "Closing line. Typed."))
  await expect(liveEditor(page).locator("audio")).toHaveCount(2)
})
