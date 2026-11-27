#!/usr/bin/env python3
"""Sorts the result of `cargo test --workspace --no-fail-fast` for stage Э3 (plan, раздел 6, шаг 3).

Expected: every test of the real engine (`real_engine::`, `real_engine_only::`) and every test of
the files `engine_*.rs` of sync/core fails because of the stub (`not yet implemented`); every
other test passes (the mini-engines, the self-checks of the simulation, the earlier stages).
Exit code 1 when a test of the real engine passes, fails for another reason, or any other test
fails.
"""
import re
import sys

text = sys.stdin.read()
binary = None
red_binary = False
results = {}  # (binary, test) -> ok/FAILED
for line in text.splitlines():
    m = re.match(r"\s+Running (?:unittests )?(\S+)", line)
    if m:
        binary = m.group(1)
        red_binary = re.search(r"/engine_[a-z_]+\.rs", binary) is not None or "engine_" in binary.split("/")[-1].split("-")[0][:7]
        continue
    m = re.match(r"test (\S+) \.\.\. (ok|FAILED|ignored)", line)
    if m and binary:
        results[(binary, m.group(1))] = m.group(2)

panics = {}
for m in re.finditer(r"thread '([^']+)' \(\d+\) panicked at [^\n]*\n([^\n]*)", text):
    panics[m.group(1)] = m.group(2)

def expected_red(binary, name):
    stem = binary.split("/")[-1].split("-")[0]
    if stem.startswith("engine_"):
        return True
    return name.startswith("real_engine::") or name.startswith("real_engine_only::")

red = {"stub": 0, "assertion": 0, "other": 0}
bad = []
green_ok = 0
for (binary, name), outcome in sorted(results.items()):
    if outcome == "ignored":
        continue
    if expected_red(binary, name):
        if outcome == "ok":
            bad.append(f"PASSES ON THE STUB: {binary} {name}")
        else:
            msg = panics.get(name, "")
            if "not yet implemented" in msg:
                red["stub"] += 1
            elif msg:
                red["assertion"] += 1
                bad.append(f"fails on an assertion, not on the stub: {name}: {msg[:150]}")
            else:
                red["other"] += 1
                bad.append(f"fails for another reason: {name}")
    else:
        if outcome == "ok":
            green_ok += 1
        else:
            bad.append(f"EXPECTED GREEN BUT FAILS: {binary} {name}: {panics.get(name, '')[:150]}")

print(f"expected red : stub {red['stub']}, assertion {red['assertion']}, other {red['other']}")
print(f"expected green: {green_ok} passed")
for line in bad:
    print(line)
sys.exit(1 if bad else 0)
