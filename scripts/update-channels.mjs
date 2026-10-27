import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, URL } from "node:url"
import process from "node:process"

import semver from "semver"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const RELEASE_TARGETS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
]

function fail(message) {
  throw new Error(message)
}

function parseBaseVersion(version) {
  if (typeof version !== "string" || !semver.valid(version)) {
    fail(`Invalid version: ${String(version)}`)
  }
  const parsed = semver.parse(version)
  if (parsed.prerelease.length || parsed.build.length || parsed.version !== version) {
    fail(`Version must be a canonical numeric release: ${version}`)
  }
  return parsed
}

export function parseReleaseTag(tag, rootVersion) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    fail(`Invalid release tag: ${String(tag)}`)
  }
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/.exec(tag)
  if (!match) fail(`Invalid release tag: ${tag}`)

  const baseVersion = `${match[1]}.${match[2]}.${match[3]}`
  parseBaseVersion(baseVersion)
  if (rootVersion !== undefined && baseVersion !== rootVersion) {
    fail(`Release tag version ${baseVersion} does not match package version ${rootVersion}`)
  }

  const betaNumber = match[4] === undefined ? null : Number(match[4])
  return {
    tag,
    version: betaNumber === null ? baseVersion : `${baseVersion}-beta.${betaNumber}`,
    baseVersion,
    channel: betaNumber === null ? "stable" : "beta",
    betaNumber,
  }
}

export function windowsInstallerVersion(rootVersion, tag) {
  const root = parseBaseVersion(rootVersion)
  const release = parseReleaseTag(tag, rootVersion)
  if (root.major > 255 || root.minor > 255) {
    fail(`Windows MSI version out of range: major and minor must be <= 255 (${rootVersion})`)
  }
  if (root.patch > 654) {
    fail(`Windows MSI version out of range: patch must be <= 654 (${rootVersion})`)
  }
  if (release.betaNumber !== null && release.betaNumber > 98) {
    fail(`Windows MSI beta number out of range: beta must be 1..98 (${tag})`)
  }

  const build = root.patch * 100 + (release.betaNumber ?? 99)
  if (build > 65535) fail(`Windows MSI version out of range: ${rootVersion} (${tag})`)
  return `${root.major}.${root.minor}.${build}`
}

function validateReleaseAsset(asset, target, owner, repo) {
  if (!asset || typeof asset !== "object") fail(`Missing platform target: ${target}`)
  if (typeof asset.signature !== "string" || !asset.signature.trim()) {
    fail(`Missing signature for platform target: ${target}`)
  }
  if (typeof asset.url !== "string") fail(`Missing URL for platform target: ${target}`)

  let url
  try {
    url = new URL(asset.url)
  } catch {
    fail(`Invalid URL for platform target: ${target}`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    fail(`Platform URL must use HTTPS on the GitHub repository: ${target}`)
  }

  const path = url.pathname.split("/").filter(Boolean)
  const releaseDownload =
    url.hostname === "github.com" &&
    path.length >= 6 &&
    path[0] === owner &&
    path[1] === repo &&
    path[2] === "releases" &&
    path[3] === "download"
  const releaseAssetApi =
    url.hostname === "api.github.com" &&
    path.length === 6 &&
    path[0] === "repos" &&
    path[1] === owner &&
    path[2] === repo &&
    path[3] === "releases" &&
    path[4] === "assets" &&
    /^\d+$/.test(path[5])
  if (!releaseDownload && !releaseAssetApi) {
    fail(`Platform URL is outside ${owner}/${repo}: ${target}`)
  }
}

function validateCandidate(manifest, release, owner, repo) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Invalid latest.json manifest")
  }
  if (manifest.version !== release.baseVersion) {
    fail(
      `Manifest version ${String(manifest.version)} does not match tag base version ${release.baseVersion}`,
    )
  }
  if (
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Array.isArray(manifest.platforms)
  ) {
    fail("Invalid platforms object in latest.json")
  }
  for (const target of RELEASE_TARGETS) {
    validateReleaseAsset(manifest.platforms[target], target, owner, repo)
  }
  for (const [target, asset] of Object.entries(manifest.platforms)) {
    validateReleaseAsset(asset, target, owner, repo)
  }
}

function validateExistingFeed(feed, channel) {
  if (feed === null || feed === undefined) return null
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
    fail(`Invalid existing ${channel} feed`)
  }
  if (typeof feed.version !== "string" || !semver.valid(feed.version)) {
    fail(`Invalid version in existing ${channel} feed`)
  }
  if (typeof feed.release_tag !== "string" || feed.release_tag !== `v${feed.version}`) {
    fail(`Invalid release tag in existing ${channel} feed`)
  }
  return feed
}

export function applyReleaseToFeeds(feeds, candidateLatestJson, tag, options) {
  const { rootVersion, owner, repo } = options ?? {}
  if (!owner || !repo) fail("GitHub owner and repository are required")
  const release = parseReleaseTag(tag, rootVersion)
  windowsInstallerVersion(rootVersion, tag)
  validateCandidate(candidateLatestJson, release, owner, repo)

  const stable = validateExistingFeed(feeds?.stable, "stable")
  const beta = validateExistingFeed(feeds?.beta, "beta")
  const incoming = {
    ...candidateLatestJson,
    version: release.version,
    release_tag: release.tag,
  }
  const isNewer = (current) => !current || semver.gt(incoming.version, current.version)

  return {
    stable: release.channel === "stable" && isNewer(stable) ? incoming : stable,
    beta: isNewer(beta) ? incoming : beta,
  }
}

function parseArgs(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (!key.startsWith("--") || !args[index + 1]) fail(`Expected a value after ${key}`)
    const option = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    result[option] = args[index + 1]
    index += 1
  }
  return result
}

function packageVersion() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version
}

function writeJson(path, value) {
  const absolutePath = resolve(path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function runCli(args) {
  const [command, ...rest] = args
  const options = parseArgs(rest)
  const rootVersion = packageVersion()

  if (command === "config") {
    const tag = options.tag ?? process.env.AMBY_RELEASE_TAG
    if (!tag || !options.output) fail("Usage: update-channels.mjs config --tag TAG --output PATH")
    const wixVersion = windowsInstallerVersion(rootVersion, tag)
    const outputPath = resolve(options.output)
    writeJson(outputPath, {
      bundle: {
        createUpdaterArtifacts: true,
        windows: { wix: { version: wixVersion } },
      },
    })
    process.stdout.write(`${outputPath.replaceAll("\\", "/")}\n`)
    return
  }

  if (command === "feeds") {
    const tag = options.tag ?? process.env.AMBY_RELEASE_TAG
    if (!tag || !options.manifest || !options.feedDir) {
      fail("Usage: update-channels.mjs feeds --tag TAG --manifest PATH --feed-dir PATH")
    }
    const manifest = JSON.parse(readFileSync(options.manifest, "utf8"))
    const feedDir = resolve(options.feedDir)
    const feeds = {
      stable: readJsonIfPresent(resolve(feedDir, "stable.json")),
      beta: readJsonIfPresent(resolve(feedDir, "beta.json")),
    }
    const updated = applyReleaseToFeeds(feeds, manifest, tag, {
      rootVersion,
      owner: process.env.GITHUB_REPOSITORY?.split("/")[0] ?? "",
      repo: process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "",
    })
    mkdirSync(feedDir, { recursive: true })
    for (const channel of ["stable", "beta"]) {
      if (updated[channel]) writeJson(resolve(feedDir, `${channel}.json`), updated[channel])
    }
    return
  }

  fail("Usage: update-channels.mjs <config|feeds> [options]")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
