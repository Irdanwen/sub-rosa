# Montage renderer

`EditorDocument` stores project-frame positions on the existing rational frame rate.
A clip's source mapping integrates its piecewise-linear positive speed curve.
Splitting and trimming sample that mapping and slice all automation together.
Generated takes remain immutable gallery artifacts, resolved at playback time.

`EditorCompositor` is the sole picture renderer for both the monitor and recorded
exports. WebGL2 applies transform, crop, opacity, fades, grade, five-point curves,
blur and trilinear 3D `.cube` lookup. Titles are local canvas textures. Later
picture tracks overlay earlier ones. Muted tracks retain picture; hidden tracks
supply neither picture nor sound.

`EditorAudio` uses the same Signalsmith Stretch 1.3.2 WASM worklet for both paths.
The package is version-pinned and bundled locally. `moduleUrl` points to the
same-origin package asset, avoiding a `blob:` script allowance. The CSP permits
WASM compilation with `wasm-unsafe-eval`, never JavaScript `unsafe-eval`.
Pitch stays unchanged as time stretches, with formant compensation enabled.
Each output-frame interval has the exact mean speed of the picture's ramp, so
picture/audio mappings agree at every frame boundary. Automated gain and fades
use the same frame samples. Decoding failures on explicit sounds block export;
a silent/undecodable video track is reported and retains its picture.

The pinned upstream JS wrapper contains two scheduling defects. The pnpm patch
uses the documented `output` property when inserting a schedule entry and only
prunes entries older than the current audio clock. It deliberately leaves the
DSP's latency-aware processing lookup untouched. `studio-stretch.test.mjs`
executes the shipped patched worklet with its real embedded WASM and checks
future start/stop timing, non-silence, and a 440 Hz tone still at 440 Hz after a
2x time stretch. Remove the patch only when the same test passes against an
upstream release.

Exports record in real time and stop explicitly if the document is hidden. No
ffmpeg, remote renderer or new paid request is involved. Editable interchange
uses the existing FCPXML/xmeml bundle writer. Operations its conservative schema
cannot represent are listed before the user chooses a flattened render. Every
bundle also contains `studio-montage.json` and copies of the original source
media, even if its interchange spine uses a rendered intermediate.
