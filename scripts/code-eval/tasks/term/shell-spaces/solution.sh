#!/bin/sh
cat > archive.sh <<'S'
#!/bin/sh
# Copies every .txt file of a folder (recursively) into an archive folder,
# keeping the relative paths, then prints how many files it copied.
# usage: archive.sh <source> <destination>
src=$1
dest=$2
list=$(mktemp)
find "$src" -name '*.txt' -type f > "$list"
count=0
while IFS= read -r file; do
  rel=${file#"$src"/}
  mkdir -p "$dest/$(dirname "$rel")"
  cp "$file" "$dest/$rel"
  count=$((count + 1))
done < "$list"
rm -f "$list"
echo "archived $count files"
S
