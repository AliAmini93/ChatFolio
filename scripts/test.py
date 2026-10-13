#!/usr/bin/env python3
"""Run all standalone browser regressions in isolated subprocesses.

Existing tests remain untouched except for portable Chromium configuration;
this runner intentionally does not mistake printed JSON for a passing exit code.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pattern", default="test_*.py", help="Filename glob under tests/")
    parser.add_argument("--timeout", type=int, default=240, help="Seconds per test")
    args = parser.parse_args()
    tests = sorted((ROOT / "tests").glob(args.pattern))
    if not tests:
        parser.error(f"No tests matched {args.pattern!r}")
    failed = []
    start = time.monotonic()
    env = os.environ.copy()
    for i, test in enumerate(tests, 1):
        print(f"[{i}/{len(tests)}] {test.name} ...", flush=True)
        t0 = time.monotonic()
        try:
            run = subprocess.run(
                [sys.executable, str(test)],
                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", timeout=args.timeout,
            )
            duration = time.monotonic() - t0
            if run.returncode:
                failed.append(test.name)
                print(f"FAIL ({duration:.1f}s, code={run.returncode})\n{run.stdout[-10000:]}", flush=True)
            else:
                print(f"PASS ({duration:.1f}s)", flush=True)
        except subprocess.TimeoutExpired as exc:
            failed.append(test.name)
            print(f"TIMEOUT after {args.timeout}s: {exc}", flush=True)
    print(f"Completed {len(tests)} tests in {time.monotonic()-start:.1f}s; failed={len(failed)}", flush=True)
    for name in failed:
        print(f" - {name}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
