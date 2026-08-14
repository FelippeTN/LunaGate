#!/usr/bin/env python3
"""Stop hook: block once per changed diff state, telling Claude to run the code-reviewer agent."""
import hashlib
import json
import os
import subprocess
import sys

STATE_FILE = os.path.join(".claude", ".last-review-hash")


def run(*args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def main():
    data = json.load(sys.stdin)
    if data.get("stop_hook_active"):
        return

    status = run("git", "status", "--porcelain")
    if not status.strip():
        return

    content = run("git", "diff", "HEAD")
    for path in run("git", "ls-files", "-o", "--exclude-standard").split():
        try:
            with open(path, "rb") as f:
                content += f.read().decode("utf-8", "ignore")
        except OSError:
            pass

    current = hashlib.md5(content.encode("utf-8")).hexdigest()
    prev = ""
    if os.path.exists(STATE_FILE):
        prev = open(STATE_FILE).read().strip()
    if current == prev:
        return

    with open(STATE_FILE, "w") as f:
        f.write(current)

    print(json.dumps({
        "decision": "block",
        "reason": (
            "There are uncommitted code changes. Use the Agent tool with "
            "subagent_type: code-reviewer to review the diff (correctness, "
            "security, over-engineering) before finishing this turn."
        ),
    }))


if __name__ == "__main__":
    main()
