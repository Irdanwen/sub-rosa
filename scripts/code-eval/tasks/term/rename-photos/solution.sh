#!/bin/sh
cd photos
python3 - <<'PY'
import os, re
for name in os.listdir("."):
    m = re.fullmatch(r"IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?: \((\d+)\))?\.(?i:jpg)", name)
    if m:
        y, mo, d, h, mi, s, dup = m.groups()
        os.rename(name, f"{y}-{mo}-{d}_{h}-{mi}-{s}" + (f"_{dup}" if dup else "") + ".jpg")
PY
