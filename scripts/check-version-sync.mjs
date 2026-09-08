import { readFileSync } from "node:fs"
import process from "node:process"

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version
const tauriVersion = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8")
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1]

const versions = new Set([packageVersion, tauriVersion, cargoVersion])
if (versions.size !== 1 || !cargoVersion) {
  throw new Error(
    `Version mismatch: package=${packageVersion}, tauri=${tauriVersion}, cargo=${cargoVersion ?? "missing"}`,
  )
}

const releaseTag = process.env.RELEASE_TAG
if (releaseTag && releaseTag !== `v${packageVersion}`) {
  throw new Error(`Release tag ${releaseTag} must match application version v${packageVersion}`)
}

process.stdout.write(`Application version ${packageVersion} is synchronized.\n`)
