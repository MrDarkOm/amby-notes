import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

import {
  applyReleaseToFeeds,
  parseReleaseTag,
  windowsInstallerVersion,
} from "./update-channels.mjs"

const owner = "MrDarkOm"
const repo = "amby-notes"
const rootVersion = "0.1.9"

function manifest(version = rootVersion) {
  const platforms = Object.fromEntries(
    [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ].map((target, index) => [
      target,
      {
        signature: `signature-${target}`,
        url: `https://github.com/${owner}/${repo}/releases/download/v0.1.9/asset-${index}`,
      },
    ]),
  )
  return { version, notes: "release notes", pub_date: "2026-01-01T00:00:00Z", platforms }
}

function currentFeeds(stableVersion, betaVersion) {
  return {
    stable: stableVersion ? { ...manifest(stableVersion), release_tag: `v${stableVersion}` } : null,
    beta: betaVersion ? { ...manifest(betaVersion), release_tag: `v${betaVersion}` } : null,
  }
}

test("parses stable and beta tags and rejects invalid tags or root-version mismatch", () => {
  assert.deepEqual(parseReleaseTag("v0.1.9", rootVersion), {
    tag: "v0.1.9",
    version: "0.1.9",
    baseVersion: "0.1.9",
    channel: "stable",
    betaNumber: null,
  })
  assert.deepEqual(parseReleaseTag("v0.1.9-beta.2", rootVersion), {
    tag: "v0.1.9-beta.2",
    version: "0.1.9-beta.2",
    baseVersion: "0.1.9",
    channel: "beta",
    betaNumber: 2,
  })
  assert.throws(() => parseReleaseTag("v0.1.10", rootVersion), /version/i)
  assert.throws(() => parseReleaseTag("0.1.9-beta.2", rootVersion), /tag/i)
  assert.throws(() => parseReleaseTag("v0.1.9-beta.0", rootVersion), /beta/i)
})

test("maps MSI versions monotonically within one public version", () => {
  assert.equal(windowsInstallerVersion(rootVersion, "v0.1.9-beta.1"), "0.1.901")
  assert.equal(windowsInstallerVersion(rootVersion, "v0.1.9-beta.2"), "0.1.902")
  assert.equal(windowsInstallerVersion(rootVersion, "v0.1.9-beta.10"), "0.1.910")
  assert.equal(windowsInstallerVersion(rootVersion, "v0.1.9"), "0.1.999")
  assert.throws(() => windowsInstallerVersion("256.0.1", "v256.0.1-beta.2"), /range/i)
  assert.throws(() => windowsInstallerVersion("0.256.1", "v0.256.1-beta.2"), /range/i)
  assert.throws(() => windowsInstallerVersion("0.1.655", "v0.1.655-beta.2"), /range/i)
  assert.throws(() => windowsInstallerVersion(rootVersion, "v0.1.10-beta.2"), /version/i)
})

test("beta feed uses SemVer ordering, including beta.2 before beta.10", () => {
  const feeds = currentFeeds("0.1.8", "0.1.9-beta.2")
  const result = applyReleaseToFeeds(feeds, manifest(), "v0.1.9-beta.10", {
    rootVersion,
    owner,
    repo,
  })

  assert.equal(result.stable.version, "0.1.8")
  assert.equal(result.beta.version, "0.1.9-beta.10")
  assert.equal(result.beta.release_tag, "v0.1.9-beta.10")
})

test("stable publish advances both feeds and a later older beta cannot roll them back", () => {
  const betaFeeds = applyReleaseToFeeds(currentFeeds(null, "0.1.9-beta.2"), manifest(), "v0.1.9", {
    rootVersion,
    owner,
    repo,
  })
  assert.equal(betaFeeds.stable.version, "0.1.9")
  assert.equal(betaFeeds.beta.version, "0.1.9")

  const lateBeta = applyReleaseToFeeds(betaFeeds, manifest(), "v0.1.9-beta.10", {
    rootVersion,
    owner,
    repo,
  })
  assert.equal(lateBeta.stable.version, "0.1.9")
  assert.equal(lateBeta.beta.version, "0.1.9")
})

test("beta publish changes only beta and keeps stable manifest intact", () => {
  const feeds = currentFeeds("0.1.8", "0.1.9-beta.1")
  const result = applyReleaseToFeeds(feeds, manifest(), "v0.1.9-beta.2", {
    rootVersion,
    owner,
    repo,
  })

  assert.deepEqual(result.stable, feeds.stable)
  assert.equal(result.beta.version, "0.1.9-beta.2")
})

test("manifest validation preserves signatures and rejects missing, unsigned, or foreign URLs", () => {
  const valid = manifest()
  const updated = applyReleaseToFeeds(currentFeeds(null, null), valid, "v0.1.9-beta.2", {
    rootVersion,
    owner,
    repo,
  })
  for (const target of Object.keys(valid.platforms)) {
    assert.deepEqual(updated.beta.platforms[target], valid.platforms[target])
  }

  const missingTarget = manifest()
  delete missingTarget.platforms["linux-aarch64"]
  assert.throws(
    () =>
      applyReleaseToFeeds(currentFeeds(null, null), missingTarget, "v0.1.9-beta.2", {
        rootVersion,
        owner,
        repo,
      }),
    /platform|target/i,
  )

  const unsigned = manifest()
  unsigned.platforms["windows-x86_64"].signature = ""
  assert.throws(
    () =>
      applyReleaseToFeeds(currentFeeds(null, null), unsigned, "v0.1.9-beta.2", {
        rootVersion,
        owner,
        repo,
      }),
    /signature/i,
  )

  const foreign = manifest()
  foreign.platforms["darwin-aarch64"].url = "https://example.org/asset"
  assert.throws(
    () =>
      applyReleaseToFeeds(currentFeeds(null, null), foreign, "v0.1.9-beta.2", {
        rootVersion,
        owner,
        repo,
      }),
    /url|repository/i,
  )
})

test("manifest numeric version must equal the tag base version", () => {
  assert.throws(
    () =>
      applyReleaseToFeeds(currentFeeds(null, null), manifest("0.1.8"), "v0.1.9-beta.2", {
        rootVersion,
        owner,
        repo,
      }),
    /version/i,
  )
})

test("feeds CLI accepts --feed-dir and writes the beta feed", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amby update feeds "))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const manifestPath = join(directory, "latest manifest.json")
  const feedDirectory = join(directory, "feed files")
  writeFileSync(manifestPath, JSON.stringify(manifest()), "utf8")

  execFileSync(
    process.execPath,
    [
      resolve("scripts/update-channels.mjs"),
      "feeds",
      "--tag",
      "v0.1.9-beta.2",
      "--manifest",
      manifestPath,
      "--feed-dir",
      feedDirectory,
    ],
    { env: { ...process.env, GITHUB_REPOSITORY: `${owner}/${repo}` } },
  )

  const feed = JSON.parse(readFileSync(join(feedDirectory, "beta.json"), "utf8"))
  assert.equal(feed.version, "0.1.9-beta.2")
})

test("validates every installer-qualified asset in latest.json", () => {
  const candidate = manifest()
  candidate.platforms["windows-x86_64-msi"] = {
    signature: "signature-windows-x86_64-msi",
    url: "https://example.org/foreign-installer.msi",
  }

  assert.throws(
    () =>
      applyReleaseToFeeds(currentFeeds(null, null), candidate, "v0.1.9-beta.2", {
        rootVersion,
        owner,
        repo,
      }),
    /url|repository/i,
  )
})

test("config CLI handles spaced output paths and prints a normalized path", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "amby release config "))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const outputPath = join(directory, "tauri release config.json")

  const stdout = execFileSync(
    process.execPath,
    [resolve("scripts/update-channels.mjs"), "config", "--tag", "v0.1.9-beta.2", "--output", outputPath],
    { encoding: "utf8" },
  )

  assert.equal(stdout.trim(), resolve(outputPath).replaceAll("\\", "/"))
  const config = JSON.parse(readFileSync(outputPath, "utf8"))
  assert.equal(config.bundle.createUpdaterArtifacts, true)
  assert.equal(config.bundle.windows.wix.version, "0.1.902")
})
