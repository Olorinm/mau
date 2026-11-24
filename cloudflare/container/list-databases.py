"""Enumerate database directories without listing their transaction files."""
import json
import subprocess
import sys

root = sys.argv[1]
pending = [""]
while pending:
    parent = pending.pop()
    entries = json.loads(subprocess.check_output(["rclone", "lsjson", "--dirs-only", root + "/" + parent]))
    for entry in entries:
        name = entry["Name"]
        if not name or name in (".", "..") or any(ch in name for ch in "/\r\n?#"):
            raise ValueError("invalid database directory")
        path = parent + name
        if name.endswith(".sqlite"):
            print(path)
        else:
            pending.append(path + "/")
