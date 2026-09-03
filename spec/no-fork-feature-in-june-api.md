# A fork feature does not live in `june-api/`

**Rule.** Sub Rosa's own features (long-form summaries, note rewrites, the
archive, search, memory) talk to the model through the sidecar's existing
`/v1/*` routes with prompts and logic kept in `src-tauri/`. No new route, no
new prompt, no feature flag goes into `june-api/` for a fork feature.

**Why.** `june-api/` is upstream's backend, kept close to upstream so that a
fix from there can still be cherry-picked (ADR 0040). Every fork line inside
it is a line that has to be re-read against every upstream patch, forever,
and the file both sides rewrite (`venice.rs`) is already the hot spot. ADR
0027 made the call for summaries; it holds for everything since.

**How to apply.** Put the prompt in `src-tauri/src/<feature>/prompts.rs` with
its own prompt version; call `/v1/chat/completions` (or `/v1/embeddings`)
through `june_api.rs`. If the sidecar genuinely lacks a capability, the change
to `june-api/` is the smallest one that exposes it generically, and it says so
in its commit.

**Exceptions.** Contract-level fixes the sidecar needs to serve any client at
all (the Carpe Diem `/router` normalisation, ADR 0015; secrets on stdin,
ADR 0040) are allowed, kept minimal, and recorded in FORK_NOTES.

**Held by.** Review, and `repository-hygiene.yml`, which fails a PR that
reintroduces upstream's hosted coordinates.
