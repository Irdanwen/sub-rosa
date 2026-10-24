#!/bin/sh
mkdir -p photos
for stamp in 20250101_123456 20250214_080000 20251231_235959 20260704_101010 20260301_000001; do
  echo "jpeg $stamp" > "photos/IMG_${stamp}.jpg"
done
echo "jpeg dup" > "photos/IMG_20250101_123456 (1).jpg"
echo "a note" > photos/README.txt
echo "jpeg upper" > photos/IMG_20260915_141500.JPG
