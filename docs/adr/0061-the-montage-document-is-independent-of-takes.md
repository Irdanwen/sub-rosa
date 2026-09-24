---
status: accepted
date: 2026-09-21
---

# The editable montage is independent of generated takes

## Context

A list of gallery videos does not represent a cut. Replacing a generated take
must not undo trimming, dialogue placement, or a grade already chosen for a
montage. Likewise, a flattened video cannot preserve those editing decisions.
ADR-0031 deliberately kept detailed finishing outside the app. The Studio
refactor introduces a local editor while retaining its export constraints.

## Decision

The project's montage is a separate, versioned document. It has ordered picture
and audio tracks, stable clip ids, artifact references, placements, source ranges,
keyframes and effect parameters. It is saved inside the project with the same
revision check. A clip's source is an artifact id, never a mutable "current take"
lookup and never an absolute path. Creating another take leaves the cut intact.

Placements use integer project frames with a rational frame rate. Playback and
editing share the mapping from montage time to source time, including the
integral of positive speed keyframes. Splitting and trimming preserve that
mapping and the evaluated parameter values at the new boundaries. Reverse
playback is outside this document version. The same effect evaluation must be
used for the monitor and recorded output, rather than a second export-only
interpretation of the edit.

This supersedes ADR-0031's choice to reserve all fine edits for an external
editor, not its prohibition on ffmpeg or its timing invariants. The app's video
export still records playback in real time, with format availability determined
by the actual webview. Interrupting that export does not lose the saved montage,
but does require starting the video export again.

An interchange export must state which operations it can represent. It must not
silently drop a grade, a speed curve, a title or an overlay to obtain an apparently
successful FCPXML/xmeml file. Unsupported operations require an explicitly chosen
rendered intermediate or a refusal with an explanation. The original editable
Sub Rosa document remains the source of truth; a flattened intermediate is not
an editable replacement for it.

## Trade-offs and boundaries

Persisting a complete editor document adds schema responsibility and rendering
work compared with delegating every finish to another tool. It makes the central
film-editing workflow available without repeated whole-film generation and
preserves the option to finish elsewhere. Recorded video remains subject to
webview performance and encoding limitations. Support for an interchange
construct is not evidence that every external editor has been tested; those
checks must be recorded separately.
