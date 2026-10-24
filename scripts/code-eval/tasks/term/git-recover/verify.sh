#!/bin/sh
set -e
cd project
git log --format=%s main | grep -qx "write the deployment checklist"
grep -q "rotate the shard keys" notes.md
git show main:notes.md | grep -q "flip the read replica"
[ -z "$(git status --porcelain)" ]
