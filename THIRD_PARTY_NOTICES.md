# Third-party Notices

June release artifacts may bundle third-party software. Keep upstream license
and notice files with redistributed source or binary builds.

## Hermes Agent

Production desktop builds bundle Hermes Agent from
<https://github.com/NousResearch/hermes-agent> at the commit pinned in
`src-tauri/src/hermes_bridge.rs`. Hermes Agent is licensed under the MIT
License.

The Hermes bundle script preserves upstream license and notice files under
`Contents/Resources/native/hermes/hermes-agent/` in the macOS app bundle and
writes an index at
`Contents/Resources/native/hermes/third_party_notices/THIRD_PARTY_NOTICES.txt`.

The pinned Hermes Agent tarball currently includes additional license or notice
files for bundled plugins and skills. Preserve those files when redistributing
the bundled runtime.

## Symphonia

Every build statically links Symphonia (<https://github.com/pdeljanov/Symphonia>)
and its format and codec crates, at the version pinned in
`src-tauri/Cargo.toml`. It decodes imported audio and video containers in
process, which is what lets an import be longer than one request can carry
(see [ADR-0026](docs/adr/0026-imported-media-is-decoded-in-process.md)).

Symphonia is licensed under the Mozilla Public License 2.0. The MPL is a
file-level copyleft: it is satisfied by using the crates unmodified and making
this notice available with the distributed binaries. If a Symphonia source file
is ever modified, that file's source must be published under the MPL as well —
another reason to keep the fork's own decoding code in
`src-tauri/src/audio/decode.rs` rather than patching the dependency.
