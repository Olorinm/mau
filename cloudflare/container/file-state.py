"""Fingerprint the files mirrored by rclone without consulting remote storage."""
import hashlib
import os
import stat
import sys

root = sys.argv[1]
digest = hashlib.sha256()

def fail(error):
    raise error

for directory, dirs, files in os.walk(root, onerror=fail):
    dirs.sort()
    files.sort()
    if os.path.relpath(directory, root) == "router" and "tmp" in dirs:
        dirs.remove("tmp")
    for name in dirs + files:
        if name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
            continue
        path = os.path.join(directory, name)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            continue  # rclone skips symlinks by default
        digest.update(os.fsencode(os.path.relpath(path, root)) + b"\0")
        if stat.S_ISREG(info.st_mode):
            digest.update(f"f:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}".encode())
        else:
            digest.update(b"d")
        digest.update(b"\0")
print(digest.hexdigest())
