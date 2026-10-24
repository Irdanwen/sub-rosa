"""Frozen task files are JSON under `scripts/`, which Biome checks: format
them the way `pnpm check` expects, when pnpm is there."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from . import paths


def biome_format(files: list[Path]) -> None:
    if not files or not shutil.which("pnpm"):
        return
    subprocess.run(
        ["pnpm", "exec", "biome", "format", "--write", *map(str, files)],
        cwd=paths.REPO_ROOT,
        capture_output=True,
        check=False,
    )
