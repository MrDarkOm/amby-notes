// Promotes one branch into the next: `npm run promote -- beta` merges dev into beta,
// `npm run promote -- main` merges beta into main. Development files listed in
// scripts/dev-only-paths.txt (on dev) never leave dev: they are removed in the merge commit.
// Nothing is pushed unless `--push` is given. The working tree must be clean, and the local
// branches must match their copies on origin.
import { execFileSync } from "node:child_process"
import console from "node:console"
import process from "node:process"

const FLOW = { beta: "dev", main: "beta" }
const args = process.argv.slice(2)
const target = args.find((arg) => !arg.startsWith("--"))
const push = args.includes("--push")

function fail(message) {
  console.error(`promote: ${message}`)
  process.exit(1)
}

function git(...gitArgs) {
  return execFileSync("git", gitArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function gitMayFail(...gitArgs) {
  try {
    return { ok: true, output: git(...gitArgs) }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() }
  }
}

if (!FLOW[target]) fail("usage: npm run promote -- beta|main [--push]")
const source = FLOW[target]

if (git("status", "--porcelain")) fail("the working tree has changes; commit them first.")
const start = git("rev-parse", "--abbrev-ref", "HEAD")

git("fetch", "origin")
for (const branch of [source, target]) {
  const local = gitMayFail("rev-parse", "--verify", branch)
  const remote = gitMayFail("rev-parse", "--verify", `origin/${branch}`)
  if (!local.ok || !remote.ok) fail(`branch ${branch} or origin/${branch} is missing.`)
  if (local.output !== remote.output) {
    fail(`${branch} differs from origin/${branch}; pull or push it first.`)
  }
}

// The list is read from dev, whatever branch is promoted: beta and main do not carry it.
const pathspecs = git("show", "dev:scripts/dev-only-paths.txt")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
if (pathspecs.length === 0) fail("scripts/dev-only-paths.txt on dev lists nothing.")

function restore() {
  if (gitMayFail("rev-parse", "--verify", "MERGE_HEAD").ok) gitMayFail("merge", "--abort")
  gitMayFail("checkout", start)
}

git("checkout", target)
const merge = gitMayFail("merge", "--no-ff", "--no-commit", source)
if (!gitMayFail("rev-parse", "--verify", "MERGE_HEAD").ok) {
  // "Already up to date": nothing to promote.
  gitMayFail("checkout", start)
  console.log(`promote: ${target} already holds everything from ${source}.`)
  process.exit(0)
}

// Development files go, in the index and on disk (dev keeps them; checking dev out restores them).
// `-f`: the merge has just staged them, and git keeps staged files unless forced.
const removed = gitMayFail("rm", "-r", "-q", "-f", "--ignore-unmatch", "--", ...pathspecs)
if (!removed.ok) {
  restore()
  fail(`could not remove the development files:\n${removed.output}`)
}

const unmerged = git("diff", "--name-only", "--diff-filter=U")
if (unmerged) {
  restore()
  fail(`conflicts outside the development files; resolve them by hand:\n${unmerged}`)
}
const leaked = git("ls-files", "--", ...pathspecs)
if (leaked) {
  restore()
  fail(`development files would reach ${target}:\n${leaked}`)
}

git("commit", "-q", "-m", `chore(promote): ${source} → ${target}`)
console.log(`promote: ${source} merged into ${target} without the development files.`)
if (!merge.ok) console.log("promote: the conflicts were all in development files and were dropped.")

if (push) {
  git("push", "origin", target)
  console.log(`promote: pushed ${target}.`)
}
git("checkout", start)
