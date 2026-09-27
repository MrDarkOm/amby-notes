import { Buffer } from "node:buffer"
import { spawnSync } from "node:child_process"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execPath } from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const iconsDir = join(repoRoot, "src-tauri", "icons")
const mark = await readFile(join(iconsDir, "amby-mark.svg"), "utf8")
if (!mark.startsWith('<svg width="817" height="673" viewBox="0 0 817 673"')) {
  throw new Error("amby-mark.svg must retain the supplied 817×673 artwork canvas")
}

const background =
  '<defs><linearGradient id="amby-background" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse"><stop stop-color="#2c2b30"/><stop offset="1" stop-color="#17171b"/></linearGradient></defs>'

function iconSvg({ rounded, scale, tileSize = 1024 }) {
  const inset = (1024 - tileSize) / 2
  const x = (1024 - 817 * scale) / 2
  const y = (1024 - 673 * scale) / 2
  const radius = rounded ? ` rx="${(220 * tileSize) / 1024}"` : ""
  const rect =
    tileSize === 1024
      ? `<rect width="1024" height="1024"${radius} fill="url(#amby-background)"/>`
      : `<rect x="${inset}" y="${inset}" width="${tileSize}" height="${tileSize}"${radius} fill="url(#amby-background)"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
${background}
${rect}
<g transform="translate(${x} ${y}) scale(${scale})">
${mark.trim()}
</g>
</svg>
`
}

function generate(source, output) {
  const cli = join(repoRoot, "node_modules", "@tauri-apps", "cli", "tauri.js")
  const result = spawnSync(execPath, [cli, "icon", source, "--output", output], {
    cwd: repoRoot,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Tauri icon generation failed: ${source}`)
}

function icoLayers(data) {
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) {
    throw new Error("Invalid ICO header")
  }
  const count = data.readUInt16LE(4)
  const signature = Buffer.from("89504e470d0a1a0a", "hex")
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16
    if (offset + 16 > data.length) throw new Error("Truncated ICO directory")
    const entry = data.subarray(offset, offset + 16)
    const size = entry.readUInt32LE(8)
    const start = entry.readUInt32LE(12)
    const image = data.subarray(start, start + size)
    if (image.length !== size || !image.subarray(0, 8).equals(signature)) {
      throw new Error("Invalid ICO image layer")
    }
    return { entry, image, width: entry[0] || 256 }
  })
}

function combineIco(regular, small) {
  const smallByWidth = new Map(icoLayers(small).map((layer) => [layer.width, layer]))
  const layers = icoLayers(regular).map((layer) => {
    if (layer.width > 32) return layer
    const replacement = smallByWidth.get(layer.width)
    if (!replacement) throw new Error(`Missing ${layer.width}px ICO layer`)
    return replacement
  })
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(layers.length, 4)
  const directory = Buffer.alloc(layers.length * 16)
  const images = []
  let offset = header.length + directory.length
  layers.forEach(({ entry, image }, index) => {
    const at = index * 16
    entry.copy(directory, at, 0, 8)
    directory.writeUInt32LE(image.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += image.length
    images.push(image)
  })
  return Buffer.concat([header, directory, ...images])
}

function normalizeIcns(data) {
  if (
    data.length < 8 ||
    data.toString("ascii", 0, 4) !== "icns" ||
    data.readUInt32BE(4) !== data.length
  ) {
    throw new Error("Invalid ICNS header")
  }
  const chunks = new Map()
  for (let offset = 8; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error("Truncated ICNS chunk")
    const type = data.toString("ascii", offset, offset + 4)
    const size = data.readUInt32BE(offset + 4)
    if (size < 8 || offset + size > data.length || chunks.has(type)) {
      throw new Error(`Invalid ICNS chunk: ${type}`)
    }
    chunks.set(type, data.subarray(offset, offset + size))
    offset += size
  }
  const order = [
    "ic07",
    "ic08",
    "ic09",
    "ic10",
    "ic11",
    "ic12",
    "ic13",
    "ic14",
    "il32",
    "l8mk",
    "is32",
    "s8mk",
  ]
  if (chunks.size !== order.length || order.some((type) => !chunks.has(type))) {
    throw new Error("Unexpected ICNS layer set")
  }
  return Buffer.concat([data.subarray(0, 8), ...order.map((type) => chunks.get(type))])
}

const temp = await mkdtemp(join(tmpdir(), "amby-app-icons-"))
try {
  const macosTileSize = 840
  const variants = [
    { name: "rounded", rounded: true, scale: 0.99 },
    {
      name: "macos",
      rounded: true,
      tileSize: macosTileSize,
      scale: (0.99 * macosTileSize) / 1024,
    },
    { name: "small", rounded: true, scale: 1.12 },
  ]
  for (const variant of variants) {
    const source = join(temp, `${variant.name}.svg`)
    await writeFile(source, iconSvg(variant))
    generate(source, join(temp, variant.name))
  }

  const rounded = join(temp, "rounded")
  const macos = join(temp, "macos")
  const small = join(temp, "small")
  const regularAssets = [
    "64x64.png",
    "128x128.png",
    "128x128@2x.png",
    "Square71x71Logo.png",
    "Square89x89Logo.png",
    "Square107x107Logo.png",
    "Square142x142Logo.png",
    "Square150x150Logo.png",
    "Square284x284Logo.png",
    "Square310x310Logo.png",
    "icon.png",
  ]
  for (const name of regularAssets) await copyFile(join(rounded, name), join(iconsDir, name))
  for (const name of ["32x32.png", "Square30x30Logo.png", "Square44x44Logo.png", "StoreLogo.png"]) {
    await copyFile(join(small, name), join(iconsDir, name))
  }
  const ico = combineIco(
    await readFile(join(rounded, "icon.ico")),
    await readFile(join(small, "icon.ico")),
  )
  await writeFile(join(iconsDir, "icon.ico"), ico)
  await writeFile(
    join(iconsDir, "icon.icns"),
    normalizeIcns(await readFile(join(macos, "icon.icns"))),
  )
  await copyFile(join(macos, "icon.png"), join(iconsDir, "icon-macos.png"))
  await writeFile(join(iconsDir, "amby.svg"), iconSvg(variants[0]))
  await writeFile(join(iconsDir, "amby-macos.svg"), iconSvg(variants[1]))
} finally {
  await rm(temp, { recursive: true, force: true })
}
