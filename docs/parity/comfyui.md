# Workflows: parity with ComfyUI

What ComfyUI's engine and editor do, and where Sub Rosa stands on each, after
the 2026-10-17 parity plan. Sub Rosa runs hosted models only (ADR-0075), so a
ComfyUI idea is either taken as is, **adapted** to paid, non-deterministic
models, or **refused** with its reason. Nothing is left to do: the test
`src/test/comfy-parity.test.ts` reads this table and fails on a row without a
status or a reference, and on any row marked `todo`.

Statuses: `done` (as ComfyUI does it, or more), `adapted` (the same need,
met differently, said why), `refused` (not taken, said why), `external` (the
app side is done; the provider is asked for the rest).

## Engine

| ComfyUI | Sub Rosa | Status | Where |
|---|---|---|---|
| Execution cache: an unchanged node is not run again | Step cache keyed by the request a step would send; a reused step costs nothing and says so on the canvas | done | #403, ADR-0115 |
| Ready queue: a node starts as soon as its inputs are ready | Ready scheduling, renders first; a failure isolates its branch on the canvas | done | #405, ADR-0114 |
| Partial execution (run up to a node) | Run one step, up to it, or the selection; upstream comes from the cache | done | #405, #411 |
| Lazy evaluation: an untaken branch is not executed | Switch step; the side not taken is never made, and the price counts the dearer side | done | #423, ADR-0114 |
| Lists and per-item execution | Text lists, picture lists, split text; a step runs once per item, gathering inputs take them all | done | #424, ADR-0117 |
| Loops | Per-item runs over a list with a declared maximum; no open loop, whose spending could not be priced | adapted | #424, ADR-0117 |
| Validation with an error per node | Every problem on its step, with its port and a "locate" | done | #405 |
| Bypass and mute modes | Set aside (passes its input on) or muted, still wired | done | #406 |
| Versioned node replacement | Node versions and a replacement registry applied on open and import; a newer format opens read-only | done | #401 |
| Price badges on API nodes | A price on every paid step, a quote for video, the total next to Run, a spend ceiling | done | #407 |
| Progress and time estimates | A rendering step shows its clock and what this model usually takes, learned on the device | adapted | #399 |
| Rate limits: retry after a 429, budget | A refused render is queued again after its `Retry-After`; submissions share one budget per window | done | #402, ADR-0114 |
| Idempotency key on paid requests | Asked of the provider, with a label per request | external | [carpe-diem-parity-requests.md](../carpe-diem-parity-requests.md) |
| Seed control ("control after generate") | "New result every run" on every paid step: off reuses, on makes a new one | adapted | #403, ADR-0115 |
| Batch count (queue N times) | A list of N items runs a step N times, priced before; no button that multiplies spending in one click | adapted | #424 |

## Canvas

| ComfyUI | Sub Rosa | Status | Where |
|---|---|---|---|
| Node search on double-click, filtered when a link is dropped | Search by typing or double-click; dropping a wire offers what fits and wires it | done | #409 |
| Selection toolbox (run, bypass, frame, convert to subgraph) | A bar over the selection: run, set aside, duplicate, frame, block, align, delete | done | #411 |
| Subgraphs with breadcrumb | Blocks, opened in place with a breadcrumb, put in place before a run | done | #417, #418, ADR-0116 |
| Subgraph blueprints | Blocks kept in the library, eight shipped, synced | done | #419, #422, #427 |
| Groups | Frames that carry their steps | done | #415 |
| Notes | Note steps, and a file's notes as notes | done | #415 |
| Minimap | Minimap coloured by each step's state | done | #411 |
| Arrange, with a spacing control | Arrange by layers with a live gap; align and distribute | done | #412 |
| Undo, redo, copy, paste | Undo history, a clipboard across workflows, through the native Edit menu | done | #408 |
| Keyboard shortcuts and command palette | Shortcuts listed in the palette | done | #408 |
| Custom keybindings | Shortcuts follow the platform and the native Edit menu; per-person keymaps are not offered | refused | #408 |
| Link colours by type | Wires coloured by what they carry, in both themes | done | #411 |
| Compact nodes when zoomed out | Steps drawn as their name and state below half zoom | done | #412 |
| Collapse, pin, colour, reroute | Collapse, pin, tint and relay steps | done | #412 |
| Widget converted to input | A setting taken from a connection, priced at its dearest choice | done | #423 |
| Preview nodes | Preview and before/after compare steps | done | #420, #423 |
| Queue and history | Run history per workflow, last results on reopen, reopen a past run | done | #404 |
| Workflow tabs | Tabs that show each run's state; a run goes on in its own tab | done | #428 |
| Large graphs | 150 steps judged, priced, put in place and laid out in about 3 ms (`workflow-scale.test.ts`) | done | #412 |

## Files and import

| ComfyUI | Sub Rosa | Status | Where |
|---|---|---|---|
| Load a workflow JSON (UI and API formats) | Translated into hosted steps with a report, never executed | adapted | #293, ADR-0075 |
| Workflow embedded in PNG, WebP and video | Read from a picture or a video ComfyUI made | done | #414 |
| Save the workflow inside the output | "Save a copy with its workflow", asked each time | done | #416 |
| Groups, notes and modes in a file | Frames, notes, set aside and muted steps | done | #406, #415 |
| Subgraphs, reroutes and primitives in a file | Blocks, relays, settings taken from a connection | done | #430 |
| Partner (API) nodes | Read from a frozen table of ComfyUI's own declarations, regenerated by a script | done | #430 |

## Library and use

| ComfyUI | Sub Rosa | Status | Where |
|---|---|---|---|
| Templates browser | Fifteen templates by kind, priced, pinned to today's catalog | done | #429 |
| Animated template thumbnails | Stills, and the person's own result fading in over a template they used | adapted | #429 |
| App mode | A workflow shown as a form, built in three steps | done | #431, ADR-0119 |
| Workflow assistant that edits the graph | The assistant reads workflows and proposes drafts; it never edits one or runs one | adapted | #433, ADR-0120 |
| Workflow versions | Versions with ⌘S and a summary of what changed | done | #425 |

## Beyond ComfyUI

| What | Sub Rosa | Status | Where |
|---|---|---|---|
| Durable runs | A run survives the app closing and resumes where it stopped | done | ADR-0021 |
| Workflows on every device | Workflows and blocks synced with the account | done | #427, ADR-0118 |
| Apps on the phone | Apps used through their form from the phone's Studio | done | #432, ADR-0119 |
| Provenance | A file a workflow made leads back to it | done | #413 |

## Refused

| ComfyUI | Why not | Status | Where |
|---|---|---|---|
| Executing ComfyUI graphs, local models, custom Python nodes, a local server | Every model is hosted; a file is translated, never run | refused | ADR-0075 |
| Extensions API with third-party JavaScript | The app's CSP and supply chain stay closed | refused | ADR-0039 |
| LiteGraph canvas | React Flow, with DOM steps (ComfyUI is moving to DOM nodes itself) | refused | #398 |
| Auto queue and instant mode | Spending on every change, without a price to look at | refused | #407 |
| Hidden and floating links | Every wire is visible and lands on a port | refused | #411 |
| 3D models and viewer | No hosted 3D generation in the catalog; the importer names those nodes | refused | #430 |
| Mask painting | Zone retouch covers the need with a box | refused | #421 |
| Public workflow hub | Workflows stay the person's; sharing goes through files and pictures that carry them | refused | #416 |
| Fourteen languages | Six languages, each tested complete | refused | #400 |
