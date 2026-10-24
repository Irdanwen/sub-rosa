#!/bin/sh
# Copies every .txt file of a folder (recursively) into an archive folder,
# keeping the relative paths, then prints how many files it copied.
# usage: archive.sh <source> <destination>
src=$1
dest=$2
count=0
for file in $(find $src -name '*.txt'); do
  rel=${file#$src/}
  mkdir -p $dest/$(dirname $rel)
  cp $file $dest/$rel
  count=$((count + 1))
done
echo "archived $count files"
