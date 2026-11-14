import * as semver from "semver"

const RELEASES_URL = "https://github.com/MrDarkOm/amby-notes/releases"

/**
 * Where a version can be downloaded by hand: its GitHub release, whose tag the release workflow
 * writes as `v` + the version. Anything that is not a version leads to the list of releases.
 */
export function releasePageUrl(version: string): string {
  const plain = version.startsWith("v") ? version.slice(1) : version
  if (!semver.valid(plain) || semver.clean(plain) !== plain) return RELEASES_URL
  return `${RELEASES_URL}/tag/v${plain}`
}
