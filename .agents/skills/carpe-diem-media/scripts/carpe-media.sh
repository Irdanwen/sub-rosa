#!/usr/bin/env bash
# carpe-media.sh — deterministic CLI for media generation through the backend
# the Sub Rosa app is configured for: Carpe Diem (carpe-diem.xyz) or Venice
# direct (api.venice.ai). Both expose the same endpoint shapes (Carpe Diem
# proxies Venice verbatim); what differs is auth validation, balance reads,
# and the video file download — handled per-backend here.
# Requires: bash, curl, python3. No other dependencies.
#
# Exit codes: 0 ok · 2 usage · 3 no valid key · 4 can't afford / over --max-usd
#             5 job failed or timed out
set -euo pipefail

CD_DEFAULT_BASE="https://carpe-diem.xyz/api/operator/v1"
VENICE_DEFAULT_BASE="https://api.venice.ai/api/v1"
APP_CONFIG_RELEASE="$HOME/Library/Application Support/xyz.carpediem.subrosa/carpe-diem.json"
APP_CONFIG_DEV="$HOME/Library/Application Support/xyz.carpediem.subrosa-dev/carpe-diem.json"
KEYCHAIN_SVC_RELEASE="xyz.carpediem.subrosa.carpe-diem"
KEYCHAIN_SVC_DEV="xyz.carpediem.subrosa-dev.carpe-diem"

usage() {
  cat >&2 <<'EOF'
Usage: carpe-media.sh <command> [options]

  credits                                   validate key + show balance
  models [type]                             list models (image, video, imageToVideo, imageEdit, tts, ...)
  pricing [type]                            per-item costs
  image        --model M --prompt P [--variants N] [--out FILE] [--async]
  image-edit   --model M --prompt P --image FILE [--aspect-ratio R] [--out FILE] [--async]
  upscale      --image FILE [--scale N] [--model upscaler] [--out FILE]
  video-quote  --model M --prompt P --duration Ns [--aspect-ratio R] [--image-url U]
  video        --model M --prompt P --duration Ns [--aspect-ratio R] [--image-url U]
               [--end-image-url U] [--out FILE] [--max-usd X] [--timeout SECS] [--no-quote]

Backend + key resolution (first valid wins):
  1. $CARPE_DIEM_API_KEY / $CARPEDIEM_API_KEY (+ optional $CARPE_DIEM_BASE_URL)
  2. The Sub Rosa app's own config: base_url from carpe-diem.json + key from the
     macOS keychain (release, then dev build) — Venice or Carpe Diem alike
  3. Known .env files (Carpe Diem keys only)
Every candidate is validated with an authenticated balance call before use.
EOF
  exit 2
}

py() { python3 -c "$1" "${@:2}"; }
jget() { # jget <json-string> <key> [fallback-key…] — first non-null wins (no eval)
  py 'import json,sys
d=json.loads(sys.argv[1])
for k in sys.argv[2:]:
    v=d.get(k)
    if v is not None:
        print(v); break
else:
    print("")' "$@"
}
fail() { echo "error: $*" >&2; exit "${FAIL_CODE:-1}"; }

# --- backend + key resolution ------------------------------------------------
keychain_key() { # $1 = keychain service; prints the key or nothing.
  # ACL-gated. If the user granted "Always allow" once, this returns instantly.
  # If not, macOS may either fail fast (rc=128, sandboxed contexts) or HANG on
  # an invisible authorization prompt — so the read is hard-bounded in time.
  # One-time grant (in a plain terminal, click "Always allow" / "Toujours autoriser"):
  #   security find-generic-password -s <service> -a api-key -w
  local svc="$1" out pid i attempt
  for attempt in 1 2; do          # retry once on an empty read (keychain can race)
    out=$(mktemp)
    security find-generic-password -s "$svc" -a "api-key" -w >"$out" 2>/dev/null &
    pid=$!
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "${KEYCHAIN_TIMEOUT_DS:-40}" ]; do
      sleep 0.1; i=$((i+1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "keychain read timed out for $svc (grant not permanent? redo it with 'Always allow') — skipping" >&2
      wait "$pid" 2>/dev/null || true; rm -f "$out"; return 0
    fi
    wait "$pid" 2>/dev/null || true
    if [ -s "$out" ]; then cat "$out"; rm -f "$out"; return 0; fi
    rm -f "$out"
  done
}
# Route strictly by KEY PREFIX (the user's rule): cdm_… → Carpe Diem, anything
# else (e.g. VENICE_…) → Venice direct. The app's base_url only refines the host
# for self-hosted / custom deployments; it never overrides the prefix decision.
backend_of_key() { case "$1" in cdm_*) echo cd;; *) echo venice;; esac; }
app_base_url() { # $1 = carpe-diem.json path; prints base_url or nothing
  [ -f "$1" ] || return 0
  py 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("base_url","").strip().rstrip("/"))
except Exception:
    pass' "$1"
}
base_for() { # $1 = backend, $2 = optional app base_url hint -> chosen base URL
  local be="$1" hint="$2"
  if [ "$be" = "cd" ]; then
    case "$hint" in *carpe-diem*|*operator*) echo "$hint"; return;; esac
    echo "${CARPE_DIEM_BASE_URL:-$CD_DEFAULT_BASE}"
  else
    case "$hint" in *venice.ai*) echo "$hint"; return;; esac
    echo "${VENICE_BASE_URL:-$VENICE_DEFAULT_BASE}"
  fi
}
validate_pair() { # $1=backend $2=base $3=key -> 0 if the key authenticates
  local be="$1" base="$2" key="$3" path code
  case "$be" in
    venice) path="/api_keys/rate_limits";;   # works with an INFERENCE key
    cd) path="/credits";;
  esac
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "Authorization: Bearer $key" "$base$path" || echo 000)
  [ "$code" = "200" ]
}
resolve_backend() { # sets KEY, BASE, ROOT (BASE minus trailing /v1), BACKEND
  local cands=() f k be base
  # candidate keys, in priority order (backend is decided per-key by prefix):
  # 1. explicit env override
  [ -n "${CARPE_DIEM_API_KEY:-}" ] && cands+=("$CARPE_DIEM_API_KEY|")
  [ -n "${CARPEDIEM_API_KEY:-}" ] && cands+=("$CARPEDIEM_API_KEY|")
  [ -n "${VENICE_API_KEY:-}" ] && cands+=("$VENICE_API_KEY|")
  # 2. the Sub Rosa app's own key (macOS keychain) + its configured base_url hint
  if [ "$(uname)" = "Darwin" ]; then
    local cfg svc hint
    for cfg_svc in "$APP_CONFIG_RELEASE|$KEYCHAIN_SVC_RELEASE" "$APP_CONFIG_DEV|$KEYCHAIN_SVC_DEV"; do
      cfg="${cfg_svc%%|*}"; svc="${cfg_svc##*|}"
      k=$(keychain_key "$svc"); k="${k//[$'\t\r\n ']/}"
      [ -n "$k" ] || continue
      hint=$(app_base_url "$cfg")
      cands+=("$k|$hint")
    done
  fi
  # 3. .env fallbacks (cdm_ keys only)
  for f in "$HOME/.env.local" "$HOME/Documents/Codage/Bots/AudiBot/.env" ".env.local"; do
    [ -f "$f" ] || continue
    while IFS= read -r k; do cands+=("$k|"); done < <(
      sed -n 's/^[A-Z_]*CARPE[A-Z_]*API_KEY=//p; s/^SUBROSA_DEV_API_KEY=//p' "$f" \
        | tr -d '"' | tr -d "[:space:]" | grep '^cdm_' || true)
  done
  local cand hint
  for cand in ${cands[@]+"${cands[@]}"}; do
    k="${cand%%|*}"; hint="${cand#*|}"
    [ -n "$k" ] || continue
    be="$(backend_of_key "$k")"
    base="$(base_for "$be" "$hint")"
    if validate_pair "$be" "$base" "$k"; then
      KEY="$k"; BASE="$base"; ROOT="${base%/v1}"; BACKEND="$be"
      echo "backend: $BACKEND ($BASE) — key ${k:0:4}…" >&2
      return 0
    fi
  done
  FAIL_CODE=3 fail "no valid key found (tried ${#cands[@]} candidate(s); each validated against its backend). A cdm_ key routes to Carpe Diem, any other key to Venice. Set CARPE_DIEM_API_KEY / VENICE_API_KEY, or store a key in the Sub Rosa app and grant keychain access once (see SKILL.md)."
}

api() { # api <method> <path> [json-body] -> sets globals RESP (body) and HTTP (code).
  # Never call in a command substitution: $(api …) runs in a subshell and loses both.
  local method="$1" path="$2" body="${3:-}" out
  out=$(mktemp)
  if [ -n "$body" ]; then
    HTTP=$(curl -s -o "$out" -w "%{http_code}" --max-time "${CURL_TIMEOUT:-180}" -X "$method" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$body" "$BASE$path" || echo 000)
  else
    HTTP=$(curl -s -o "$out" -w "%{http_code}" --max-time "${CURL_TIMEOUT:-60}" -X "$method" \
      -H "Authorization: Bearer $KEY" "$BASE$path" || echo 000)
  fi
  RESP=$(cat "$out"); rm -f "$out"
}

available_usd() { # spendable USD on the active backend
  if [ "$BACKEND" = "venice" ]; then
    api GET /api_keys/rate_limits
    printf '%s' "$RESP" | py 'import json,sys
b=json.load(sys.stdin)["data"]["balances"]
print(max(b.get("USD",0),0)+max(b.get("DIEM",0),0))'
  else
    api GET /credits
    jget "$RESP" availableUsdc
  fi
}

# --- arg parsing -------------------------------------------------------------
MODEL="" PROMPT="" VARIANTS=1 OUT="" IMAGE="" ASPECT="" SCALE=2 DURATION=""
IMAGE_URL="" END_IMAGE_URL="" MAX_USD="" TIMEOUT=900 ASYNC=0 NO_QUOTE=0
CMD="${1:-}"; [ -n "$CMD" ] || usage; shift || true
POS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift 2;;
    --prompt) PROMPT="$2"; shift 2;;
    --variants) VARIANTS="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --image) IMAGE="$2"; shift 2;;
    --aspect-ratio) ASPECT="$2"; shift 2;;
    --scale) SCALE="$2"; shift 2;;
    --duration) DURATION="$2"; shift 2;;
    --image-url) IMAGE_URL="$2"; shift 2;;
    --end-image-url) END_IMAGE_URL="$2"; shift 2;;
    --max-usd) MAX_USD="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --async) ASYNC=1; shift;;
    --no-quote) NO_QUOTE=1; shift;;
    -h|--help) usage;;
    *) POS="$1"; shift;;
  esac
done

json_body() { # json_body k=v k=v … (values raw strings; k=@n for numbers/json)
  py 'import json,sys
o={}
for a in sys.argv[1:]:
    k,v=a.split("=",1)
    if k.endswith("@n"): o[k[:-2]]=json.loads(v)
    else: o[k]=v
print(json.dumps(o))' "$@"
}

save_b64_images() { # stdin: JSON with images[]; writes OUT (or per-index files)
  py 'import json,sys,base64
d=json.load(sys.stdin)
imgs=d.get("images") or []
if not imgs:
    sys.stderr.write("no images in response: %s\n" % json.dumps(d)[:400]); sys.exit(5)
out=sys.argv[1]
fmt=(d.get("request") or {}).get("data",{}).get("format","webp")
paths=[]
for i,b in enumerate(imgs):
    p=out if (out and len(imgs)==1) else ((out or "carpe-image") + (f".{i}.{fmt}" if len(imgs)>1 or not out else ""))
    open(p,"wb").write(base64.b64decode(b))
    paths.append(p)
print("\n".join(paths))' "$1"
}

poll_binary_queue() { # $1=queue path prefix (e.g. /image/generate) $2=queue_id $3=out
  local prefix="$1" qid="$2" out="$3" deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    [ "$(date +%s)" -lt "$deadline" ] || { FAIL_CODE=5 fail "timed out after ${TIMEOUT}s (queue_id=$qid)"; }
    local tmp ct
    tmp=$(mktemp)
    ct=$(curl -s -o "$tmp" -w "%{content_type}" --max-time 60 -X POST \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "{\"queue_id\":\"$qid\"}" "$BASE$prefix/retrieve" || echo "")
    case "$ct" in
      image/*) mv "$tmp" "$out"
        curl -s -o /dev/null -X POST -H "Authorization: Bearer $KEY" \
          -H "Content-Type: application/json" -d "{\"queue_id\":\"$qid\"}" \
          "$BASE$prefix/complete" || true
        echo "$out"; return 0;;
      application/json*)
        local status; status=$(jget "$(cat "$tmp")" status 2>/dev/null || echo "")
        rm -f "$tmp"
        if [ "$status" = "pending" ] || [ "$status" = "processing" ] || [ "$status" = "queued" ]; then
          sleep 2
        else
          FAIL_CODE=5 fail "job failed (queue_id=$qid): status=$status"
        fi;;
      *) cat "$tmp" >&2; rm -f "$tmp"; FAIL_CODE=5 fail "unexpected retrieve response (queue_id=$qid)";;
    esac
  done
}

download_video() { # $1 = video_url from retrieve, $2 = out file
  local vurl="$1" out="$2" url code
  case "$vurl" in
    http*) url="$vurl";;
    *) url="$ROOT$vurl";;   # CD: /v1/video/file/<id> joins onto the /v1-less root
  esac
  code=$(curl -s -o "$out" -w "%{http_code}" --max-time 300 \
    -H "Authorization: Bearer $KEY" "$url" || echo 000)
  if [ "$code" != "200" ] && [ "$url" != "$BASE$vurl" ]; then
    # fallback join for backends that serve the file under the /v1 base itself
    code=$(curl -s -o "$out" -w "%{http_code}" --max-time 300 \
      -H "Authorization: Bearer $KEY" "$BASE$vurl" || echo 000)
  fi
  [ "$code" = "200" ] || FAIL_CODE=5 fail "video download failed (HTTP $code): $vurl"
}

case "$CMD" in
# ------------------------------------------------------------------ credits --
credits)
  resolve_backend
  if [ "$BACKEND" = "venice" ]; then
    api GET /api_keys/rate_limits
    printf '%s' "$RESP" | py 'import json,sys
d=json.load(sys.stdin)["data"]
b=d["balances"]
print("Venice balances: USD %.4f · DIEM %.4f (daily allowance)" % (b.get("USD",0), b.get("DIEM",0)))
print("next epoch: %s · tier: %s" % (d.get("nextEpochBegins","?"), d.get("apiTier",{}).get("id","?")))'
  else
    api GET /credits
    printf '%s' "$RESP" | py 'import json,sys
d=json.load(sys.stdin)
print("available: %.2f credits ($%.4f)" % (d["availableCredits"], d["availableUsdc"]))
print("escrow %.2f · pending %.2f · holds %.2f" % (d["escrowCredits"], d["pendingCredits"], d["holdsCredits"]))'
  fi
  ;;
# ------------------------------------------------------------------- models --
models)
  TYPE="$POS"
  resolve_backend
  if [ "$BACKEND" = "venice" ]; then
    # Venice types: image, video (includes image-to-video), tts, upscale, inpaint, embedding, text
    VT="$TYPE"
    case "$TYPE" in imageEdit) VT=inpaint;; imageToVideo) VT=video;; esac
    api GET "/models${VT:+?type=$VT}"
    printf '%s' "$RESP" | py 'import json,sys
for m in json.load(sys.stdin)["data"]:
    spec=m.get("model_spec",{})
    pr=spec.get("pricing",{}).get("generation",{})
    cost=("$%s" % pr["usd"]) if "usd" in pr else "-"
    print("%-55s %-10s %-8s %s" % (m["id"], m.get("type","?"), cost, spec.get("privacy","")))'
  else
    api GET /models
    printf '%s' "$RESP" | py 'import json,sys
t=sys.argv[1] if len(sys.argv)>1 else ""
for m in json.load(sys.stdin)["data"]:
    if not t or m.get("carpe_diem_type")==t:
        print("%-55s %-14s %-9s %s" % (m["id"], m.get("carpe_diem_type","?"), m.get("tier","?"), m.get("privacy","?")))' "$TYPE"
  fi
  ;;
pricing)
  TYPE="$POS"
  resolve_backend
  if [ "$BACKEND" = "venice" ]; then
    api GET "/models${TYPE:+?type=$TYPE}"
    printf '%s' "$RESP" | py 'import json,sys
rows=[]
for m in json.load(sys.stdin)["data"]:
    pr=m.get("model_spec",{}).get("pricing",{}).get("generation",{})
    if "usd" in pr: rows.append((pr["usd"], m["id"], m.get("type","?")))
for usd,mid,t in sorted(rows):
    print("%-45s %-12s $%.4f" % (mid, t, usd))'
  else
    curl -s --max-time 30 "$ROOT/pricing" | py 'import json,sys
t=sys.argv[1] if len(sys.argv)>1 else ""
fc=json.load(sys.stdin)["fixedCost"]
for f in sorted(fc,key=lambda f:f["costCredits"]):
    if not t or f["type"]==t:
        print("%-45s %-12s %8.2f credits  (x%s)" % (f["model"], f["type"], f["costCredits"], f["multiplier"]))' "$TYPE"
  fi
  ;;
# -------------------------------------------------------------------- image --
image)
  [ -n "$MODEL" ] && [ -n "$PROMPT" ] || usage
  resolve_backend
  OUT="${OUT:-carpe-image.webp}"
  BODY=$(json_body "model=$MODEL" "prompt=$PROMPT" "variants@n=$VARIANTS")
  # Heavy models exceed Carpe Diem's ~60s edge cap on the sync path; Venice
  # direct has no edge proxy but the async queue works there too.
  case "$MODEL" in gpt-image-*|nano-banana-pro|recraft-v4-pro) [ "$BACKEND" = "cd" ] && ASYNC=1;; esac
  if [ "$ASYNC" = "0" ]; then
    api POST /image/generate "$BODY"
    if [ "$HTTP" = "200" ]; then
      printf '%s' "$RESP" | save_b64_images "$OUT"; exit 0
    elif [ "$HTTP" != "502" ]; then
      echo "$RESP" >&2; FAIL_CODE=5 fail "image generation failed (HTTP $HTTP)"
    fi
    echo "sync path hit HTTP 502 (edge cap) — retrying via async queue" >&2
  fi
  api POST /image/generate/queue "$BODY"
  [ "$HTTP" = "202" ] || [ "$HTTP" = "200" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "queue failed (HTTP $HTTP)"; }
  QID=$(jget "$RESP" queue_id id)
  poll_binary_queue /image/generate "$QID" "$OUT"
  ;;
# --------------------------------------------------------------- image-edit --
image-edit)
  [ -n "$MODEL" ] && [ -n "$PROMPT" ] && [ -f "$IMAGE" ] || usage
  resolve_backend
  OUT="${OUT:-carpe-edit.webp}"
  DATA_URI=$(py 'import base64,sys,mimetypes
p=sys.argv[1]
mime=mimetypes.guess_type(p)[0] or "image/png"
print(f"data:{mime};base64,"+base64.b64encode(open(p,"rb").read()).decode())' "$IMAGE")
  ARGS=("model=$MODEL" "prompt=$PROMPT" "image=$DATA_URI")
  [ -n "$ASPECT" ] && ARGS+=("aspect_ratio=$ASPECT")
  BODY=$(json_body "${ARGS[@]}")
  case "$MODEL" in gpt-image-2-edit|gpt-image-1-5-edit|nano-banana-pro-edit) [ "$BACKEND" = "cd" ] && ASYNC=1;; esac
  if [ "$ASYNC" = "0" ]; then
    api POST /image/edit "$BODY"
    if [ "$HTTP" = "200" ]; then printf '%s' "$RESP" | save_b64_images "$OUT"; exit 0
    elif [ "$HTTP" != "502" ]; then echo "$RESP" >&2; FAIL_CODE=5 fail "edit failed (HTTP $HTTP)"; fi
    echo "sync 502 — retrying via async queue" >&2
  fi
  api POST /image/edit/queue "$BODY"
  [ "$HTTP" = "202" ] || [ "$HTTP" = "200" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "queue failed (HTTP $HTTP)"; }
  QID=$(jget "$RESP" queue_id id)
  poll_binary_queue /image/edit "$QID" "$OUT"
  ;;
# ------------------------------------------------------------------ upscale --
upscale)
  [ -f "$IMAGE" ] || usage
  resolve_backend
  OUT="${OUT:-carpe-upscaled.png}"
  RAW_B64=$(py 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' "$IMAGE")
  BODY=$(json_body "model=${MODEL:-upscaler}" "image=$RAW_B64" "scale@n=$SCALE")
  api POST /image/upscale "$BODY"
  [ "$HTTP" = "200" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "upscale failed (HTTP $HTTP) — note: source must be ≥256×256"; }
  printf '%s' "$RESP" | save_b64_images "$OUT"
  ;;
# -------------------------------------------------------------- video-quote --
video-quote)
  [ -n "$MODEL" ] && [ -n "$PROMPT" ] && [ -n "$DURATION" ] || usage
  resolve_backend
  ARGS=("model=$MODEL" "prompt=$PROMPT" "duration=$DURATION")
  [ -n "$ASPECT" ] && ARGS+=("aspect_ratio=$ASPECT")
  [ -n "$IMAGE_URL" ] && ARGS+=("image_url=$IMAGE_URL")
  api POST /video/quote "$(json_body "${ARGS[@]}")"
  echo "$RESP"
  [ "$HTTP" = "200" ] || FAIL_CODE=5 fail "quote failed (HTTP $HTTP) — ltx-* models are known to reject quote; use the video command with --no-quote"
  ;;
# -------------------------------------------------------------------- video --
video)
  [ -n "$MODEL" ] && [ -n "$PROMPT" ] && [ -n "$DURATION" ] || usage
  case "$DURATION" in *s) ;; *) fail "--duration must end in 's' (e.g. 5s)";; esac
  resolve_backend
  OUT="${OUT:-carpe-video.mp4}"
  ARGS=("model=$MODEL" "prompt=$PROMPT" "duration=$DURATION")
  [ -n "$ASPECT" ] && ARGS+=("aspect_ratio=$ASPECT")
  [ -n "$IMAGE_URL" ] && ARGS+=("image_url=$IMAGE_URL")
  [ -n "$END_IMAGE_URL" ] && ARGS+=("end_image_url=$END_IMAGE_URL")
  BODY=$(json_body "${ARGS[@]}")

  if [ "$NO_QUOTE" = "0" ]; then
    api POST /video/quote "$BODY"; QRESP=$RESP
    if [ "$HTTP" = "200" ]; then
      QUOTE=$(jget "$QRESP" quote)
      AVAIL=$(available_usd)
      echo "quote: \$$QUOTE — available: \$$AVAIL" >&2
      py 'import sys
q,a=float(sys.argv[1]),float(sys.argv[2])
cap=float(sys.argv[3]) if sys.argv[3] else None
sys.exit(4 if (q>a or (cap is not None and q>cap)) else 0)' \
        "$QUOTE" "$AVAIL" "$MAX_USD" || {
          FAIL_CODE=4 fail "refusing: quote \$$QUOTE exceeds available \$$AVAIL${MAX_USD:+ or --max-usd \$$MAX_USD}"; }
    else
      echo "quote unavailable (HTTP $HTTP) — proceeding; queue enforces its own balance check" >&2
    fi
  fi

  api POST /video/queue "$BODY"
  [ "$HTTP" = "200" ] || [ "$HTTP" = "202" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "queue failed (HTTP $HTTP)"; }
  QID=$(jget "$RESP" id queue_id)
  [ -n "$QID" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "no job id in queue response"; }
  echo "queued: $QID — polling (timeout ${TIMEOUT}s)" >&2

  DEADLINE=$(( $(date +%s) + TIMEOUT ))
  while :; do
    [ "$(date +%s)" -lt "$DEADLINE" ] || { FAIL_CODE=5 fail "timed out after ${TIMEOUT}s (queue_id=$QID, model=$MODEL — job may still finish; re-poll /video/retrieve)"; }
    # retrieve may answer JSON (status / video_url) or raw video bytes — handle both
    TMP=$(mktemp)
    CT=$(curl -s -o "$TMP" -w "%{content_type}|%{http_code}" --max-time 120 -X POST \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$(json_body "queue_id=$QID" "model=$MODEL")" "$BASE/video/retrieve" || echo "|000")
    CODE="${CT##*|}"; CTYPE="${CT%%|*}"
    case "$CODE" in
      200)
        case "$CTYPE" in
          video/*|application/octet-stream) mv "$TMP" "$OUT"; echo "$OUT"; exit 0;;
          *)
            RESP=$(cat "$TMP"); rm -f "$TMP"
            STATUS=$(jget "$RESP" status)
            if [ "$STATUS" = "completed" ]; then
              VURL=$(jget "$RESP" video_url url)
              [ -n "$VURL" ] || { echo "$RESP" >&2; FAIL_CODE=5 fail "completed but no video_url"; }
              download_video "$VURL" "$OUT"
              echo "$OUT"; exit 0
            fi
            echo "  status: $STATUS" >&2; sleep 5;;
        esac;;
      404) rm -f "$TMP"; FAIL_CODE=5 fail "job not found/expired (queue_id=$QID)";;
      403) rm -f "$TMP"; FAIL_CODE=5 fail "queue_id belongs to another wallet";;
      410) rm -f "$TMP"; FAIL_CODE=5 fail "provider key revoked mid-job — re-queue";;
      429|502|503) rm -f "$TMP"; echo "  transient HTTP $CODE — backing off" >&2; sleep 8;;
      *) cat "$TMP" >&2; rm -f "$TMP"; FAIL_CODE=5 fail "retrieve failed (HTTP $CODE)";;
    esac
  done
  ;;
*) usage;;
esac
