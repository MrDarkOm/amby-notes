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

// A stable release is tagged `v<version>` (from main); a pre-release for testing is tagged
// `v<version>-beta.<n>` (from beta) and carries the same application version, since installers
// such as MSI accept only numeric versions.
const releaseTag = process.env.RELEASE_TAG
if (
  releaseTag &&
  !new RegExp(`^v${packageVersion.replaceAll(".", "\\.")}(-beta\\.\\d+)?$`).test(releaseTag)
) {
  throw new Error(
    `Release tag ${releaseTag} must be v${packageVersion} or v${packageVersion}-beta.<n>`,
  )
}

process.stdout.write(`Application version ${packageVersion} is synchronized.\n`)
