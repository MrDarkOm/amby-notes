#!/usr/bin/env python3
"""Groups the red tests of appendix Е (docs/sync-plan.md) by the reason they fail.

The tests of the appendix were written before the code (docs/sync-plan.md, раздел 6). Until the
code exists they must fail, each for its intended reason; once the code exists they must pass, and
nothing else may break. This script checks both ends against the manifest `plans-red-manifest.json`,
the list of the tests that are red at the end of the tests-first step.

  cargo test ... --no-fail-fast 2>&1 | python3 sync/plans_red.py cargo [--area NAME]
  npx vitest run ... --reporter=json | python3 sync/plans_red.py vitest

Reasons (what makes a test red on the stubs):
  not_implemented   a stub panicked (`not_implemented`, `not yet implemented`) or answered 501
  assertion         the behaviour is not there yet: an `assert`, `expected HTTP …`, a missing element
  refused_by_limit  the old code meets a limit it does not know (HTTP 413/507 as an error)
  other             anything else, for example a build error or a refused connection: a test with
                    the wrong reason; fix the test or the stub

Exit code 1 when: a test of the manifest passes (`--expect-red`, the default), a test outside the
manifest fails (a regression of an existing test), or a failure is `other`. With `--expect-green`
(after the implementation) a test of the manifest that fails, or any other failure, exits 1.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "plans-red-manifest.json")


def reason_of(message: str) -> str:
    low = message.lower()
    if "not_implemented" in low or "not yet implemented" in low or "http 501" in low:
        return "not_implemented"
    if "http 413" in low or "http 507" in low or "server refused" in low:
        return "refused_by_limit"
    if (
        "assert" in low
        or "expected http" in low
        or "unable to find" in low
        or "to be truthy" in low
        or "expected [" in low
        or "to match" in low
        or "to equal" in low
        or "to have a length" in low
        or "the pass failed" in low
        or "the pass did not finish" in low
        or "must exist" in low
        or "fixture check" in low
        or "expected" in low
        or "must" in low
        or "cannot read properties of undefined" in low
        or "written" in low
        or "is an error" in low
    ):
        return "assertion"
    return "other"


def parse_cargo(text: str, area: str):
    """Returns (passed, failed) where failed maps a name to its message."""
    passed, failed, messages = set(), {}, {}
    current_binary = ""
    for line in text.splitlines():
        m = re.match(r"\s+Running .*?\((.*?)\)", line) or re.match(r"\s+Running (\S+)", line)
        if m:
            current_binary = os.path.basename(m.group(1)).split("-")[0]
        m = re.match(r"^test (\S+) \.\.\. (ok|FAILED)", line)
        if m:
            name = f"{area}:{current_binary}:{m.group(1)}"
            (passed.add(name) if m.group(2) == "ok" else failed.setdefault(name, ""))
    # messages: "---- name stdout ----" blocks follow each binary; match by the short name
    blocks = re.split(r"^---- ", text, flags=re.M)[1:]
    by_short = {}
    for block in blocks:
        head, _, rest = block.partition(" stdout ----")
        match = re.search(r"panicked at [^\n]*\n(.*?)(?:\n\nnote:|\n\n----|\n\nfailures:|\Z)", rest, re.S)
        by_short.setdefault(head.strip(), (match.group(1).strip() if match else rest.strip()))
    for name in list(failed):
        short = name.split(":", 2)[2]
        failed[name] = by_short.get(short, "")
    return passed, failed


def parse_vitest(text: str):
    start = text.index("{")
    data = json.loads(text[start:])
    passed, failed = set(), {}
    for file in data.get("testResults", []):
        base = os.path.relpath(file["name"], os.getcwd()) if os.path.isabs(file["name"]) else file["name"]
        for test in file.get("assertionResults", []):
            name = f"vitest:{base}:{test['fullName']}"
            if test["status"] == "passed":
                passed.add(name)
            elif test["status"] == "failed":
                failed[name] = "\n".join(test.get("failureMessages", []))[:600]
    return passed, failed


def main(argv):
    if len(argv) < 2 or argv[1] not in ("cargo", "vitest"):
        print(__doc__)
        return 2
    kind = argv[1]
    flags = argv[2:]
    expect_green = "--expect-green" in flags
    write = "--write-manifest" in flags
    area = "sync"
    if "--area" in flags:
        area = flags[flags.index("--area") + 1]
    text = sys.stdin.read()
    passed, failed = parse_cargo(text, area) if kind == "cargo" else parse_vitest(text)
    scope = f"{area}:" if kind == "cargo" else "vitest:"
    manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {"red": []}
    red = {name for name in manifest["red"] if name.startswith(scope)}

    if write:
        keep = [name for name in manifest["red"] if not name.startswith(scope)]
        manifest["red"] = sorted(keep + sorted(failed))
        json.dump(manifest, open(MANIFEST, "w"), indent=1, ensure_ascii=False)
        print(f"manifest written: {len(failed)} red tests for {scope}")
        return 0

    groups = {}
    for name, message in sorted(failed.items()):
        groups.setdefault(reason_of(message), []).append(name)
    print(f"{scope} passed: {len(passed)}; failed: {len(failed)}; in the manifest: {len(red)}")
    for reason in ("not_implemented", "assertion", "refused_by_limit", "other"):
        names = groups.get(reason, [])
        print(f"  {reason:17} {len(names)}")
        if reason == "other" or "--list" in flags:
            for name in names:
                first = (failed[name].splitlines() or ["(no message)"])[0][:140]
                print(f"      {name}\n        {first}")
    bad = 0
    if expect_green:
        for name in sorted(failed):
            print(f"  STILL RED / BROKEN: {name}")
            bad += 1
    else:
        for name in sorted(red & passed):
            print(f"  PASSED but must be red (the test proves nothing yet): {name}")
            bad += 1
        for name in sorted(set(failed) - red):
            print(f"  REGRESSION (not in the manifest, fails): {name}")
            bad += 1
        for name in sorted(red - passed - set(failed)):
            print(f"  MISSING (in the manifest, not run): {name}")
            bad += 1
        bad += len(groups.get("other", []))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
