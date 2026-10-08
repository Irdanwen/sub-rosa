---
status: accepted
date: 2026-10-08
---

# Data analysis runs Pyodide in the phone's webview and answers in chart blocks

## Context

The parity matrix (ADR-0078) left charts, interactive tables and data
analysis open on every shell. The desktop agent is Hermes, whose
`code_execution` toolset already runs Python on the user's machine; what it
lacked was a way to *show* a result other than a matplotlib PNG the app can
neither theme nor read. The phones run agent-lite (no subprocess is allowed
on iOS, ADR-0018 for background rules), so they had no way to compute at all:
a question about an attached spreadsheet was answered by the model's mental
arithmetic.

Constraints:

- **The webview CSP** allows `connect-src` to the app and loopback only, and
  already allows `'wasm-unsafe-eval'`. No CDN, no remote interpreter.
- **iOS forbids interpreters as processes**, and a native CPython embed is a
  build-system project of its own (per-architecture frameworks, signing every
  extension module, App Store review of an interpreter).
- **ADR-0024**: cards travel in the message text as fenced JSON, validated as
  untrusted, degrading to a code block.
- **ADR-0018**: nothing long may live in a JS promise on the phone.

## Decision

**Two new chat block kinds**, `subrosa:chart` and `subrosa:table`, extend
ADR-0024 unchanged. The parser (`src/lib/chat-blocks-data.ts`) clamps rather
than rejects: eight series at most (the palette's size, never a generated
ninth hue), three for scatter (the only count whose every pair stays apart for
colour-blind readers), 60 bar categories, 400 line points, 2,000 scatter
points, pie slices beyond eight folded into "Other", 12 columns and 500 rows,
every string capped, and the card says what it left out. Charts are hand-drawn
SVG (`ChartCard.tsx`, `chart-geometry.ts`), not a library: the five forms need
a few hundred lines, a library would add a dependency and its own colours, and
a hand-drawn chart takes the app's tokens directly. Colours are eight tokens
(`--chart-1..8`) per theme, the dataviz reference palette in an order that
passes the checker's colour-blind and normal-vision separation gates on the
card surface in both themes; text never wears a series colour, and the light
theme's three sub-3:1 hues are always paired with a legend, a tooltip and the
"Show data" table. One y axis, always. Tables sort, align numbers, keep a
sticky header and scroll on their own. Files are drawn by the webview (it holds
the themed chart) and delivered by Rust like a conversation export.

**The desktop** is taught through the soul (`data_cards::desktop_soul_section`
after `JUNE_SOUL_BLOCKS_MD`): analyse with `code_execution`, answer with the
blocks rather than a matplotlib image, write files to the working folder. The
card shapes are one Rust constant shared with the phone prompt, so the two
agents cannot drift from each other or from the parser in the same build.

**The phones run Pyodide 0.29.5** (CPython 3.13 compiled to WebAssembly) in a
module Web Worker of the webview, with numpy 2.2.5 and pandas 2.3.3. The files
ship in the iOS and Android bundles under `/pyodide/` and are loaded the first
time a run needs them; pandas is loaded only when the code imports it. A Vite
plugin (`scripts/pyodide-assets.mjs`) downloads the pinned files once into
`node_modules/.cache`, verifies each by SHA-256 and size, and emits them only
when `TAURI_ENV_PLATFORM` is `ios` or `android`: the desktop bundle is
unchanged. Added size: **20.35 MB uncompressed** (wasm 8.6, pandas 4.5,
numpy 2.8, stdlib 2.4, JS 1.1, the rest under 1), about **13.3 MB** once
compressed in the IPA or APK.

The tool `run_python(code, files[])` is agent-lite's, offered on the phones to
the default chat only (a custom assistant's tool list does not include it).
The Rust side (`agent_lite/python.rs`) emits `agent-lite://python-run` and
waits on an in-process registry for `agent_lite_python_reply`: "started"
within 5 seconds or the webview is taken to be absent, then the outcome within
120 seconds or Rust emits `agent-lite://python-cancel` and the webview
terminates the worker (wasm cannot be interrupted, only discarded). The
webview refuses at once when the page is hidden and abandons a run when it
becomes hidden, and the tool then answers "Analysis needs the app open" so the
turn continues. The turn's text attachments are mounted under `/data`; a
spreadsheet, which the phone holds as the document reader's cell listing, is
turned back into one CSV per sheet. A prelude defines `subrosa_chart(...)` and
`subrosa_table(...)`, which return block JSON; the tool result hands the model
each block fenced, to copy verbatim. Variables persist per conversation in the
worker's lifetime.

**No durable row.** The run belongs to the turn, and the turn is already the
durable row: a suspension interrupts the turn, the resume sweep re-asks it,
and the model calls the tool again. Liveness is the registry, never the
database. The bounded wait (5 s, then 120 s) is what makes this acceptable
under ADR-0018: nothing waits on a frozen webview beyond those clocks.

**CSP.** Pyodide needs `'wasm-unsafe-eval'`, which the app's CSP already
grants; it does not need `'unsafe-eval'` for this bundle. Its only `eval`
paths are Emscripten's `emscripten_run_script` and the EM_JS/EM_ASM loader of
side modules, and none of the 57 shared objects in the numpy and pandas wheels
carries an EM_JS or EM_ASM section (checked by scanning them for
`__em_js__`/`__start_em_asm`). The desktop CSP is untouched. The wasm uses
legacy WebAssembly exception handling (it compiles with exnref disabled), which
WebKit has supported since Safari 15.2 and Chromium since 95.

## Consequences

- A chart is as trustworthy as its numbers: the prompts forbid estimated
  figures, and on the phone the numbers usually come out of `run_python`. The
  parser cannot check a number's truth, only its shape.
- The phone bundles grow by about 13 MB compressed. Desktop builds pay nothing.
- Python runs only in the foreground. A long analysis on a locked phone is
  refused, and said to be; the alternative (a native interpreter process) is
  impossible on iOS.
- **Open device checks**, not provable from this machine: Pyodide in a module
  worker served from `tauri://localhost` on iOS 16+ and from
  `http://tauri.localhost` in the Android WebView; whether a WKWebView worker
  inherits the page CSP (iOS 15's Safari lacks `'wasm-unsafe-eval'`, so on
  iOS 15 the first run may fail to compile the wasm and the tool says Python is
  unavailable); first-load time and memory on a low-end phone.
- **Fallback if those checks fail**: the spec's alternative stands, a
  `query_data` tool running SQL over the attached tables in an in-memory
  SQLite on the Rust side. It was not chosen because SQL covers grouping and
  totals but not the statistics and reshaping pandas does, and the models
  write pandas far more reliably than ad hoc SQL over a sheet listing.
- Upgrading Pyodide is a pin change in `scripts/pyodide-assets.mjs` (version,
  each file's hash and size) followed by the device checks above.

## Addendum 2026-10-08: run in the iOS simulator, and the worker's policy

The open checks above were run for real, in the app itself: a debug
simulator build (`pnpm tauri ios build --debug --target aarch64-sim`) served
from `tauri://localhost` under the shipped CSP, iPhone 17 Pro, iOS 26.3,
on an Apple M2. The run goes through the whole tool path (Rust event, phone
shell bridge, module worker, Pyodide, the reply command) with no model and no
key: a debug-only self-test, `agent_lite/python_selftest.rs`, started with
`SIMCTL_CHILD_SUBROSA_PYTHON_SELFTEST=1 xcrun simctl launch booted
xyz.carpediem.subrosa`, which writes `python-selftest.json` to the app's data
folder (`Library/Application Support/xyz.carpediem.subrosa/`) and logs each
case. It is the check to re-run after a Pyodide upgrade.

Measured on the Rust clock, from the event to the answer:

| Case | Time |
| --- | --- |
| Cold start (Pyodide boots, `sys.version`) | 1.2 to 1.6 s |
| numpy loaded, `arange(1, 1001)` summed | 0.43 to 0.59 s |
| pandas loaded, CSV read from `/data`, `groupby`, `subrosa_chart` bar | 1.4 to 1.8 s |
| The same pandas run, warm | 7 to 10 ms |
| Variables kept between runs, the spreadsheet listing mounted as `budget.sheet1.csv` and read, a traceback returned | under 10 ms each |

Memory: the webview's content process held 280 MB with the chat idle and
about 670 to 720 MB after the runs, so Pyodide with numpy and pandas costs
about 400 MB. Times are a simulator on a desktop chip; an older iPhone will be
several times slower on the cold start, and its content process has less room.

**What worked as written.** The module worker starts under the custom scheme;
the files are served with usable types (Tauri infers `.mjs` as
`text/javascript` and sniffs `application/wasm` and `application/zip` from the
bytes); Pyodide needs no `unsafe-eval`; the bundled wheels load.

**What did not: the worker ran under no policy at all.** Tauri attaches the
`Content-Security-Policy` header to HTML responses only, and a worker loaded
from a script URL takes its policy from its own response, so `js.eval(...)`
succeeded in the worker and `connect-src` did not apply to it: the model's
code could have sent an attached file anywhere. Fixed by starting the worker
from a one-line blob that imports the bundled script
(`src/lib/python/worker-url.ts`): a blob worker inherits the page's policy.
The CSP gains `worker-src 'self' blob:` for it, and both CSP tests pin that
directive. Measured after the fix: `eval` is refused in the worker and
Pyodide still runs. WebKit leaves a fetch the policy refuses pending rather
than failing it, which would hold a run until its 120 s limit, so the worker
also wraps `fetch` (`guardFetch`) to refuse anything outside `/pyodide/` at
once, with a sentence the model reads.

**The worker no longer outlives the screen.** When the page is hidden, an
idle worker is now terminated as well as a running one: 400 MB held by a
backgrounded app makes it the first one iOS reclaims, which reloads the whole
chat. The simulator showed the memory returned when the app came back (390 MB
against 670 MB); whether it is returned before iOS suspends the process is a
device question. The conversation's variables go with the worker, and the
tool's description says so.

**Deployment target.** The iOS project's minimum is 15.0 (`project.yml`,
`IPHONEOS_DEPLOYMENT_TARGET`). `'wasm-unsafe-eval'` is honoured from Safari
16.0 (MDN browser-compat-data), and Pyodide 0.29 is tested from Safari 16.4.
Now that the worker inherits the page's policy, on iOS 15 Pyodide's wasm
compile is refused there as in the page; on 16.0 to 16.3 it may run but is
untested upstream. Either way a Pyodide that cannot start now answers
"unavailable" to Rust (`WorkerDone.unavailable`), so the tool tells the model
Python is not available on this phone instead of handing it an error to retry.
Raising the deployment target to 16.4 would drop the phones that stop at iOS
15 (iPhone 6s, 7, first SE) for every feature, which this fix does not need.

**Still open, on hardware**: the cold start and memory on a low-end iPhone,
and the Android WebView, whose CSP handling for blob workers is the standard
one but was not run here. The `query_data` fallback stays unbuilt: nothing
here called for it.
