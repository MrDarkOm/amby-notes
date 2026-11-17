import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import manifest from "./manifest.json"
import provenance from "../../../public/emoji/noto/provenance.json"
import licenses from "./licenses.json"
import { leadingEmoji, pickerEmojiUrl, resolveEmoji } from "./emoji-resolver"
import { notoPickerData } from "./picker-data"

const examples = [
  "👍🏽",
  "👩🏽‍💻",
  "🇫🇮",
  "🇺🇦",
  "1️⃣",
  "🏳️‍🌈",
  "👨‍👩‍👧‍👦",
  "🫱🏿‍🫲🏻",
  "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
]

describe("local Noto emoji", () => {
  it.each(examples)("resolves and extracts the whole %s sequence without changing it", (value) => {
    expect(resolveEmoji(value)).toMatch(/^\/emoji\/noto\/emoji_u.*\.svg\?v=/u)
    expect(leadingEmoji(`${value} Title`)).toBe(value)
    expect(JSON.parse(JSON.stringify({ icon: value })).icon).toBe(value)
  })

  it("distinguishes presentation selectors and never mistakes ordinary text for an icon", () => {
    expect(resolveEmoji("☀️")).not.toBeNull()
    expect(resolveEmoji("☀︎")).toBeNull()
    expect(leadingEmoji("☀︎ Title")).toBe("☀︎")
    for (const text of ["Title", "1 title", "#tag", "→", "✓", "", "amby-icon:star:"]) {
      expect(leadingEmoji(text)).toBeUndefined()
      expect(resolveEmoji(text)).toBeNull()
    }
  })

  it("keeps unknown ZWJ tails together for native fallback", () => {
    const value = "👩🏽‍🚀‍🦄"
    expect(leadingEmoji(`${value} Title`)).toBe(value)
    expect(resolveEmoji(value)).toBeNull()
    expect(leadingEmoji("👩\u200D")).toBe("👩\u200D")
  })

  it("ships a checksum-verified local image for every pinned sequence", () => {
    expect(manifest.unicodeVersion).toBe(provenance.unicodeVersion)
    const files = new Set<string | null>(Object.values(manifest.sequences))
    expect(files.has(null)).toBe(false)
    for (const file of files) {
      const bytes = readFileSync(new URL(`../../../public/emoji/noto/${file}`, import.meta.url))
      const svg = bytes.toString()
      expect(svg).toContain("<svg")
      const viewport = svg.match(/<svg\b[^>]*>/u)?.[0]
      expect(viewport).toMatch(/\bwidth="128"/u)
      expect(viewport).toMatch(/\bheight="128"/u)
      expect(svg).toContain("Optimized with SVGO")
      expect(svg).not.toMatch(/<(?:script|foreignObject|text)\b|<!DOCTYPE|<!ENTITY/u)
      expect(svg).not.toMatch(/(?:href|xlink:href)=["'](?:https?:|\/\/)/u)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        provenance.images[file as keyof typeof provenance.images],
      )
    }
    for (const value of Object.keys(manifest.sequences)) {
      expect(leadingEmoji(`${value} Title`)).toBe(value)
      expect(resolveEmoji(value)).not.toBeNull()
    }
  })

  it("ships matching complete offline license texts", () => {
    for (const { file, text } of licenses) {
      const bytes = readFileSync(new URL(`../../../public/emoji/noto/${file}`, import.meta.url))
      expect(bytes.toString()).toBe(text)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        provenance.licenses[file as keyof typeof provenance.licenses].sha256,
      )
    }
  })

  it("resolves all picker skins locally and preserves old IDs alongside Unicode additions", () => {
    expect(notoPickerData.emojis.grinning.skins[0].native).toBe("😀")
    expect(Object.keys(notoPickerData.emojis).some((id) => id.startsWith("noto-"))).toBe(true)
    for (const emoji of Object.values(notoPickerData.emojis)) {
      for (const skin of emoji.skins) {
        expect(pickerEmojiUrl("google", skin.unified)).toMatch(/^\/emoji\/noto\//u)
      }
    }
    expect(pickerEmojiUrl("google", "not-a-sequence")).toMatch(/^data:image\/svg\+xml,/u)
    expect(pickerEmojiUrl("google", "10ffff")).toMatch(/^data:image\/svg\+xml,/u)
    expect(pickerEmojiUrl("google", "d800")).toMatch(/^data:image\/svg\+xml,/u)
  })
})
