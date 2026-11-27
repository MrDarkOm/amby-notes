#!/usr/bin/env python3
"""Sorts the failures of a `cargo test` run into the reasons the red check accepts.

Usage: cargo test -p amby-sync-conformance --no-fail-fast 2>&1 | python3 classify_red.py

Accepted reasons on the stub server (docs/sync-plan.md, раздел 6, шаг 3):
  not_implemented  the stub answered `501 not_implemented`, or a stub function returned NotImplemented
  assertion        a check of the test failed (`assertion` / `expected HTTP …`)
Anything else (a build error, a refused connection, a timeout, a panic of the test code itself)
is listed under `other` and makes the exit code 1. A test that passes also makes it 1.
"""
import re
import sys

text = sys.stdin.read()
passed = re.findall(r"^test (\S+) \.\.\. ok$", text, re.M)
failed = re.findall(r"^test (\S+) \.\.\. FAILED$", text, re.M)
ignored = re.findall(r"^test (\S+) \.\.\. ignored", text, re.M)

messages = {}
for block in re.split(r"^---- ", text, flags=re.M)[1:]:
    head, _, rest = block.partition(" stdout ----")
    match = re.search(r"panicked at [^\n]*\n(.*?)(?:\n\nnote:|\n\n----|\Z)", rest, re.S)
    messages[head.strip()] = (match.group(1).strip() if match else rest.strip())

buckets = {"not_implemented": [], "assertion": [], "other": []}
for name in failed:
    message = messages.get(name, "")
    if "not_implemented" in message or "NotImplemented" in message:
        buckets["not_implemented"].append(name)
    elif message.startswith("assertion") or message.startswith("expected HTTP"):
        buckets["assertion"].append(name)
    else:
        buckets["other"].append((name, message.splitlines()[0] if message else "(no message)"))

total = len(passed) + len(failed) + len(ignored)
print(f"tests: {total}; passed: {len(passed)}; failed: {len(failed)}; ignored: {len(ignored)}")
print(f"failed because of the stub (not_implemented): {len(buckets['not_implemented'])}")
print(f"failed on an assertion of the test:          {len(buckets['assertion'])}")
print(f"failed for another reason:                    {len(buckets['other'])}")
for name, message in buckets["other"]:
    print(f"  OTHER  {name}: {message}")
for name in passed:
    print(f"  PASSED on the stub (must be rewritten): {name}")
sys.exit(0 if not passed and not buckets["other"] and not ignored else 1)
