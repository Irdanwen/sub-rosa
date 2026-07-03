#!/usr/bin/env python3
"""Assemble the Tauri v2 updater `latest.json` from collected build artifacts.

Each `build` matrix job renames its updater artifact with a platform-key prefix
(`darwin-aarch64-...`, `darwin-x86_64-...`, `windows-x86_64-...`) and ships it
next to its detached `.sig`. This merges them into one manifest whose download
URLs point at the public releases repo's assets for the given tag.

Usage:
  build-updater-manifest.py --dir incoming --tag v1.0.0 --version 1.0.0 \
      --repo Irdanwen/sub-rosa-releases --out incoming/latest.json
"""

import argparse
import json
import os
from datetime import datetime, timezone
from urllib.parse import quote

PLATFORM_KEYS = ("darwin-aarch64", "darwin-x86_64", "windows-x86_64")
# Tauri v2 updater artifact suffixes. macOS updates ship as `.app.tar.gz`;
# Windows NSIS updates ship as the `-setup.exe` installer itself (each with a
# detached `.sig`). The `.dmg` installer has no `.sig`, so it can't sneak in.
UPDATER_EXTS = (".app.tar.gz", ".nsis.zip", "-setup.exe")


def platform_for(filename: str) -> str | None:
    for key in PLATFORM_KEYS:
        if filename.startswith(f"{key}-"):
            return key
    return None


def is_updater_artifact(filename: str) -> bool:
    return any(filename.endswith(ext) for ext in UPDATER_EXTS)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--notes", default="")
    parser.add_argument("--pub-date", default="")
    args = parser.parse_args()

    platforms: dict[str, dict[str, str]] = {}
    for name in sorted(os.listdir(args.dir)):
        if not name.endswith(".sig"):
            continue
        asset = name[: -len(".sig")]
        if not is_updater_artifact(asset):
            print(f"[manifest] skipping non-updater sig: {name}")
            continue
        key = platform_for(asset)
        if key is None:
            print(f"[manifest] skipping unrecognized artifact: {asset}")
            continue
        if not os.path.isfile(os.path.join(args.dir, asset)):
            raise SystemExit(f"[manifest] {name} has no paired artifact {asset}; aborting")
        if key in platforms:
            raise SystemExit(f"[manifest] duplicate updater artifact for {key}; aborting")
        with open(os.path.join(args.dir, name), encoding="utf-8") as handle:
            signature = handle.read().strip()
        url = f"https://github.com/{args.repo}/releases/download/{quote(args.tag)}/{quote(asset)}"
        platforms[key] = {"signature": signature, "url": url}
        print(f"[manifest] {key} -> {asset}")

    if not platforms:
        raise SystemExit("[manifest] no updater artifacts found; aborting")

    # tauri-plugin-updater hard-fails deserialization when `pub_date` is not
    # RFC 3339 (an empty string kills the whole update check on every client),
    # so always emit a valid timestamp.
    pub_date = args.pub_date or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {
        "version": args.version,
        "notes": args.notes or f"Sub Rosa {args.tag}",
        "pub_date": pub_date,
        "platforms": platforms,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"[manifest] wrote {args.out} with platforms: {', '.join(platforms)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
