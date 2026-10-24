#!/bin/sh
set -e
head -1 archive.sh | grep -q '^#!/bin/sh'
t=$(mktemp -d)
mkdir -p "$t/my notes/sub dir" "$t/my notes/plain"
echo one > "$t/my notes/a b.txt"
echo two > "$t/my notes/sub dir/c  d.txt"
echo three > "$t/my notes/plain/e.txt"
echo skip > "$t/my notes/plain/f.md"
out=$(sh ./archive.sh "$t/my notes" "$t/the archive")
[ "$out" = "archived 3 files" ]
[ "$(cat "$t/the archive/a b.txt")" = one ]
[ "$(cat "$t/the archive/sub dir/c  d.txt")" = two ]
[ "$(cat "$t/the archive/plain/e.txt")" = three ]
[ ! -e "$t/the archive/plain/f.md" ]
rm -rf "$t"
