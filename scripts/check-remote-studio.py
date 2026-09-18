#!/usr/bin/env python3
"""Keep the retired remote film service out while allowing explicit account hosting."""
import re
import subprocess
import sys

FORBIDDEN = re.compile(r"furetier\.com|vmk_|[Vv]ideomaker")
ACCOUNT_HOST = re.compile(r"(?<![\w.-])subrosa\.furetier\.com(?![\w.-])")
MARKETING_URL = re.compile(r"(?<![\w.-])furetier\.com(?=/subrosa/)")
MARKETING_HOST = re.compile(r"(?<![\w.-])furetier\.com(?![\w.-])")
MARKETING_FILES = {
    "scripts/deploy-website-vps.sh",
    "subrosa-cloud/deploy/nginx-marketing-bootstrap.conf",
    "subrosa-cloud/deploy/nginx-marketing.conf",
}
EXCLUDED = [
    "docs/**", ".agents/**", ".claude/**", "FORK_NOTES.md", "AGENTS.md",
    "CLAUDE.md", "CONTEXT.md", "LICENSE*", ".github/workflows/repository-hygiene.yml",
    "scripts/check-remote-studio.py",
]


def forbidden(path, text):
    # Scrub only the newly authorized hostname/path, never a whole line or file.
    remaining = ACCOUNT_HOST.sub("account-host", text)
    remaining = MARKETING_URL.sub("marketing-host", remaining)
    if path in MARKETING_FILES:
        remaining = MARKETING_HOST.sub("marketing-host", remaining)
    return bool(FORBIDDEN.search(remaining))


def self_test():
    assert not forbidden("src/account.rs", '"https://subrosa.furetier.com"')
    assert not forbidden("HANDOFF.md", "https://furetier.com/subrosa/")
    assert forbidden("src/account.rs", "https://furetier.com/unrelated")
    assert forbidden("src/account.rs", "https://api.subrosa.furetier.com")
    assert forbidden("src/account.rs", "https://subrosa.furetier.com.evil")
    assert forbidden("src/account.rs", "https://subrosa.furetier.com-evil")
    assert forbidden("src/account.rs", "https://subrosa.furetier.com https://studio.furetier.com")
    for path in MARKETING_FILES:
        assert not forbidden(path, "server_name furetier.com;")
        assert forbidden(path, "https://studio.furetier.com")
        assert forbidden(path, "https://api.furetier.com")
        assert forbidden(path, "https://furetier.com.evil")
        assert forbidden(path, "vmk_example Videomaker")


def main():
    self_test()
    result = subprocess.run(
        ["git", "grep", "-I", "-n", "-E", "--", r"furetier\.com|vmk_|[Vv]ideomaker",
         ".", *[f":(exclude){path}" for path in EXCLUDED]],
        capture_output=True, text=True, check=False,
    )
    if result.returncode not in (0, 1):
        print("Could not inspect tracked files for retired studio references.", file=sys.stderr)
        return 1
    matches = []
    for line in result.stdout.splitlines():
        path, _, content = line.split(":", 2)
        if forbidden(path, content):
            matches.append(line)
    if matches:
        print("\n".join(matches), file=sys.stderr)
        print("Retired remote film service reference found; see ADR-0029.", file=sys.stderr)
        return 1
    print("Remote studio guard passed; account and marketing exceptions remain narrow.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
