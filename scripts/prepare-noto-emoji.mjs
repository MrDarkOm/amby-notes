#!/usr/bin/env node
/** Pinned, build-time-only import. Normal builds and the app never use the network. */
import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import console from "node:console"
import { setTimeout as delay } from "node:timers/promises"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import process from "node:process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"
import { optimize } from "svgo"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const release = "v2026-09-24-unicode18_0"
const commit = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e"
const tree = "ae8299d0f09856fa45c82c6ccae3b9a01587ccc6"
const flagsTree = "0f84bf50ac350920859385b3b734c41bec68e704"
const unicodeVersion = "18.0"
const raw = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${commit}`
const output = path.join(root, "public/emoji/noto")
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex")
const prettierConfig = await resolveConfig(path.join(root, "package.json"))
const writeJson = async (file, value) =>
  writeFile(file, await format(JSON.stringify(value), { ...prettierConfig, parser: "json" }))

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await globalThis.fetch(url, {
        signal: globalThis.AbortSignal.timeout(60000),
      })
      if (!response.ok) throw new Error(`${response.status}: ${url}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (attempt === 3) throw error
      await delay(500 * (attempt + 1))
    }
  }
}

async function checked(url, sha256) {
  const bytes = await download(url)
  if (hash(bytes) !== sha256) throw new Error(`Source checksum mismatch: ${url}`)
  return bytes
}

await mkdir(output, { recursive: true })
const corpus = await checked(
  `https://www.unicode.org/Public/${unicodeVersion}.0/emoji/emoji-test.txt`,
  "8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a",
)
const aliasesText = await checked(
  `${raw}/emoji_aliases.txt`,
  "8486155d242f84e8c04108705383b11f9f351cc60147734c15d50b8eaa4df370",
)
const inventory = JSON.parse(
  (
    await download(
      `https://api.github.com/repos/googlefonts/noto-emoji/git/trees/${tree}?recursive=1`,
    )
  ).toString(),
)
if (inventory.truncated || inventory.sha !== tree) throw new Error("Invalid Noto source tree")
const artwork = new Map(
  inventory.tree
    .filter((entry) => /^svg\/emoji_u.*\.svg$/u.test(entry.path))
    .map((entry) => [path.basename(entry.path), { ...entry, path: `2D/${entry.path}` }]),
)
const flags = JSON.parse(
  (
    await download(
      `https://api.github.com/repos/googlefonts/noto-emoji/git/trees/${flagsTree}?recursive=1`,
    )
  ).toString(),
)
if (flags.truncated || flags.sha !== flagsTree) throw new Error("Invalid Noto flags tree")
const flagFiles = new Map(
  flags.tree
    .filter((entry) => /^region-flags\/svg\/.*\.svg$/u.test(entry.path))
    .map((entry) => [
      path.basename(entry.path, ".svg"),
      { ...entry, path: `third_party/${entry.path}` },
    ]),
)
const aliases = new Map(
  aliasesText
    .toString()
    .split("\n")
    .map((line) => line.split("#")[0].trim().split(";"))
    .filter((pair) => pair.length === 2),
)
const sequences = Object.create(null)
const required = new Set()
const pickerBase = JSON.parse(
  await readFile(path.join(root, "node_modules/@emoji-mart/data/sets/15/native.json"), "utf8"),
)
const key = (value) => value.replace(/\uFE0F/gu, "")
const known = new Set(
  Object.values(pickerBase.emojis).flatMap((emoji) => emoji.skins.map((skin) => key(skin.native))),
)
const additions = []
const groups = {
  "Smileys & Emotion": "people",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "foods",
  "Travel & Places": "places",
  Activities: "activity",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
}
let category = "people"
for (const line of corpus.toString().split("\n")) {
  if (line.startsWith("# group: ")) category = groups[line.slice(9)] ?? "people"
  const match = /^([A-F0-9 ]+)\s*;\s*(fully-qualified|minimally-qualified|unqualified)\s*#/u.exec(
    line,
  )
  if (!match) continue
  const points = match[1].trim().split(/\s+/u)
  const value = String.fromCodePoint(...points.map((point) => parseInt(point, 16)))
  let stem = points
    .filter((point) => point !== "FE0F")
    .map((point) => point.toLowerCase().padStart(4, "0"))
    .join("_")
  stem = aliases.get(stem) ?? stem
  const file = `emoji_u${stem}.svg`
  if (!artwork.has(file)) {
    const canonical = stem.split("_").map((point) => parseInt(point, 16))
    let region
    if (
      canonical.length === 2 &&
      canonical.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff)
    ) {
      region = String.fromCharCode(...canonical.map((point) => point - 0x1f1e6 + 65))
    } else if (canonical[0] === 0x1f3f4 && canonical.at(-1) === 0xe007f) {
      const tag = String.fromCharCode(
        ...canonical.slice(1, -1).map((point) => point - 0xe0000),
      ).toUpperCase()
      region = `${tag.slice(0, 2)}-${tag.slice(2)}`
    }
    if (region && flagFiles.has(region)) artwork.set(file, flagFiles.get(region))
  }
  sequences[value] = artwork.has(file) ? file : null
  if (artwork.has(file)) required.add(file)
  if (match[2] === "fully-qualified" && !known.has(key(value))) {
    const name = line.match(/# .*? E[\d.]+ (.+)$/u)?.[1]
    if (!name) throw new Error(`Missing Unicode name: ${line}`)
    additions.push({
      category,
      id: `noto-${points.join("-").toLowerCase()}`,
      name,
      keywords: name.split(/[\s:,-]+/u).filter(Boolean),
      skins: [{ unified: points.join("-").toLowerCase(), native: value }],
      version: Number(unicodeVersion),
    })
  }
}

const checksums = Object.create(null)
const sourceBlobs = Object.create(null)
const optimizer = {
  name: "svgo",
  version: "4.1.0",
  multipass: true,
  noticeVersion: 1,
  intrinsicSize: 128,
  removeEmptyAdobePlaceholder: true,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: { removeComments: { preservePatterns: ["^!", "[Cc]opyright", "[Ll]icense"] } },
      },
    },
    "removeDimensions",
  ],
}
const normalizeViewport = {
  name: "normalize-intrinsic-viewport",
  fn: () => ({
    element: {
      enter(node, parent) {
        if (node.name === "svg" && parent.type === "root") {
          node.attributes.width = String(optimizer.intrinsicSize)
          node.attributes.height = String(optimizer.intrinsicSize)
        }
      },
    },
  }),
}
const modificationNotice =
  "<!-- Optimized with SVGO 4.1.0 for Amby; source and licenses: provenance.json. -->\n"
const removeEmptyAdobePlaceholder = {
  name: "remove-empty-adobe-placeholder",
  fn: () => ({
    element: {
      enter(node, parent) {
        // The official American Samoa SVG contains this non-rendering Illustrator marker.
        // Its following <g> is the actual flag. Never remove other/painted content.
        if (
          node.name === "foreignObject" &&
          node.children.length === 0 &&
          node.attributes.requiredExtensions === "http://ns.adobe.com/AdobeIllustrator/10.0/"
        ) {
          parent.children.splice(parent.children.indexOf(node), 1)
        }
      },
    },
  }),
}
let previous = {}
try {
  previous = JSON.parse(await readFile(path.join(output, "provenance.json"), "utf8"))
} catch {
  // A first import has no trusted optimized cache; verify/download original SVGs.
}
let completed = 0
const queue = [...required].sort()
await Promise.all(
  Array.from({ length: 12 }, async () => {
    while (queue.length) {
      const file = queue.shift()
      const entry = artwork.get(file)
      const target = path.join(output, file)
      let bytes
      try {
        bytes = await readFile(target)
      } catch {
        /* A first import has no cached image. */
      }
      const matches = (value) =>
        value &&
        hash(Buffer.concat([Buffer.from(`blob ${value.length}\0`), value]), "sha1") === entry.sha
      const cached =
        bytes &&
        JSON.stringify(previous.optimizer) === JSON.stringify(optimizer) &&
        previous.sourceBlobs?.[file] === entry.sha &&
        previous.images?.[file] === hash(bytes)
      sourceBlobs[file] = entry.sha
      if (cached) {
        checksums[file] = hash(bytes)
        completed++
        continue
      }
      if (process.env.AMBY_NOTO_SOURCE_CACHE) {
        try {
          bytes = await readFile(path.join(process.env.AMBY_NOTO_SOURCE_CACHE, file))
        } catch {
          /* Missing source cache entries are downloaded and checked below. */
        }
      }
      if (!matches(bytes)) bytes = await download(`${raw}/${entry.path}`)
      if (!matches(bytes)) throw new Error(`Image checksum mismatch: ${file}`)
      bytes = Buffer.from(
        modificationNotice +
          optimize(bytes.toString(), {
            path: file,
            multipass: optimizer.multipass,
            plugins: [...optimizer.plugins, removeEmptyAdobePlaceholder, normalizeViewport],
          }).data,
      )
      await writeFile(target, bytes)
      checksums[file] = hash(bytes)
      if (++completed % 500 === 0) console.log(`Noto images: ${completed}/${required.size}`)
    }
  }),
)

const licenseSources = {
  "NOTO-NOTICE.txt": `${raw}/2D/svg/LICENSE`,
  "APACHE-2.0.txt": "https://www.apache.org/licenses/LICENSE-2.0.txt",
  "FLAGS-LICENSE.txt": `${raw}/third_party/region-flags/LICENSE`,
  "FLAGS-README.txt": `${raw}/third_party/region-flags/README.third_party`,
  "UNICODE-LICENSE.txt": "https://www.unicode.org/license.txt",
}
const licenseHashes = {
  "NOTO-NOTICE.txt": "611ceab36dae96644ca84e8ace6873821790192bf6f73b0d0624a21b24b4b332",
  "APACHE-2.0.txt": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "FLAGS-LICENSE.txt": "73af5be6e2ea006b75bebfd2f463f252c5ce8c94024c639dbdd97f0456272a5a",
  "FLAGS-README.txt": "afcde2aa95a727811568338c51f73506de136177965ae49d2a7f63d89e8edf16",
  "UNICODE-LICENSE.txt": "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96",
}
const licenseChecksums = Object.create(null)
const licenseTexts = []
for (const [file, url] of Object.entries(licenseSources)) {
  const bytes = await checked(url, licenseHashes[file])
  await writeFile(path.join(output, file), bytes)
  licenseChecksums[file] = { url, sha256: hash(bytes) }
  licenseTexts.push({ file, text: bytes.toString() })
}
const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
await mkdir(path.join(root, "src/lib/emoji"), { recursive: true })
await writeJson(path.join(root, "src/lib/emoji/manifest.json"), {
  schemaVersion: 1,
  release,
  unicodeVersion,
  assetVersion: hash(Buffer.from(JSON.stringify(optimizer))).slice(0, 12),
  sequences: sorted(sequences),
})
await writeJson(path.join(root, "src/lib/emoji/picker-additions.json"), additions)
await writeJson(path.join(root, "src/lib/emoji/licenses.json"), licenseTexts)
await writeJson(path.join(output, "provenance.json"), {
  schemaVersion: 1,
  release,
  commit,
  tree,
  flagsTree,
  unicodeVersion,
  unicodeData: {
    url: `https://www.unicode.org/Public/${unicodeVersion}.0/emoji/emoji-test.txt`,
    sha256: "8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a",
  },
  aliases: {
    url: `${raw}/emoji_aliases.txt`,
    sha256: "8486155d242f84e8c04108705383b11f9f351cc60147734c15d50b8eaa4df370",
  },
  source: "https://github.com/googlefonts/noto-emoji",
  format: "svg",
  optimizer,
  sourceBlobs: sorted(sourceBlobs),
  images: sorted(checksums),
  licenses: licenseChecksums,
})
const missing = Object.entries(sequences).filter(([, file]) => !file)
console.log(
  `Noto: ${required.size} images, ${Object.keys(sequences).length} sequences, ${missing.length} unavailable (native fallback).`,
)
if (missing.length) console.log(missing.map(([value]) => value).join(" "))
