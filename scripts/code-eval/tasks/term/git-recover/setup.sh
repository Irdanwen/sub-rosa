#!/bin/sh
# A nested repository whose last two commits were thrown away by a reset.
set -e
mkdir project && cd project
git init -q -b main
git config user.name dev && git config user.email dev@localhost
echo "v1" > notes.md && git add notes.md && git commit -qm "start notes"
printf 'v1\n\n## Deployment checklist\n1. drain the queue\n2. rotate the shard keys\n3. flip the read replica\n' > notes.md
git commit -qam "write the deployment checklist"
echo "scratch" > scratch.txt && git add scratch.txt && git commit -qm "scratch file"
git reset -q --hard HEAD~2
git reflog expire --expire=never --all
