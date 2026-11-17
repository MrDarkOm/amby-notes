#!/usr/bin/env node
/** Maintenance only: pinned CLDR vocabulary. App/builds never download dictionaries. */
import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import console from "node:console"
import { format, resolveConfig } from "prettier"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const revision = "a4b67247b446fd51b475991017a2481911210c60"
const source = `https://github.com/unicode-org/cldr-json/tree/${revision}`
const files = [
  [
    "cldr-json/cldr-annotations-full/annotations/ru/annotations.json",
    "21120cb44093843460276e571d1671a322f2bd2399cceaab4531d362ad75f62a",
  ],
  [
    "cldr-json/cldr-annotations-derived-full/annotationsDerived/ru/annotations.json",
    "8635ba86d806f938a9948b4cf3bc4a6013eeb95d6b54f108519aed37bca97db5",
  ],
  ["LICENSE", "220ba0e1c43b99530d2d5bdb892a99dca0989414f51ab695ecd90163eaa1ec3b"],
]
const config = await resolveConfig(path.join(root, "package.json"))
const writeJson = async (file, value) =>
  writeFile(file, await format(JSON.stringify(value), { ...config, parser: "json" }))
const manifest = JSON.parse(await readFile(path.join(root, "src/lib/emoji/manifest.json"), "utf8"))
const key = (value) => value.replace(/\uFE0F/gu, "")
const supported = new Set(Object.keys(manifest.sequences).map(key))
const keywords = {}
const inputs = []
let licenseText
for (const [file, sha256] of files) {
  const url = `https://raw.githubusercontent.com/unicode-org/cldr-json/${revision}/${file}`
  const response = await globalThis.fetch(url)
  if (!response.ok) throw new Error(`CLDR download failed: ${response.status} ${file}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error(`CLDR checksum mismatch: ${file}`)
  inputs.push({ url, sha256 })
  if (file === "LICENSE") {
    licenseText = bytes.toString("utf8")
    continue
  }
  const json = JSON.parse(bytes.toString("utf8"))
  const annotations = (json.annotations ?? json.annotationsDerived).annotations
  for (const [sequence, entry] of Object.entries(annotations)) {
    if (!supported.has(key(sequence))) continue
    keywords[sequence] = [
      ...new Set([...(keywords[sequence] ?? []), ...(entry.tts ?? []), ...(entry.default ?? [])]),
    ]
  }
}
const output = path.join(root, "src/locales/emoji-search")
await mkdir(output, { recursive: true })
await writeJson(path.join(output, "ru.json"), {
  locale: "ru",
  source,
  revision,
  release: "CLDR 49.0.0",
  license: "Unicode-3.0",
  inputs,
  keywords: Object.fromEntries(
    Object.entries(keywords).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ),
})
await writeJson(path.join(output, "licenses.json"), [
  { file: "CLDR-LICENSE.txt", text: licenseText },
])
console.log(
  `CLDR 49: ${Object.keys(keywords).length} Russian emoji entries, source checksums verified.`,
)
