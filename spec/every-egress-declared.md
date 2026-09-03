# Every host the binary can reach is declared

**Rule.** Every HTTP client comes from `src-tauri/src/http_client.rs`, and
every host it may reach is a constant in `src-tauri/src/egress.rs` with a
stated reason. Settings › Privacy shows that list to the user, read from the
same constant.

**Why.** The product's one promise is "nothing leaves except the requests you
make of a model, to the endpoint you configured". A promise is only as good as
the inventory behind it, and an inventory only holds if adding a destination
means editing the list the user sees. The threat model
(`docs/threat-model.md`) rests on this.

**How to apply.** A new outbound call (a places lookup, a captions fetch, a
release check) adds a `Destination` to `egress.rs` with the reason, and takes
its client from the factory. The test compares the declared list to every URL
literal in the tree, so an undeclared host fails the build rather than the
review.

**Exceptions.** `ingest/fetch.rs` builds its own client because its policy is
stricter (HTTPS only, DNS preflight to public addresses, no redirects off
host). It is named in the test.

**Held by.** `src-tauri/tests/egress.rs`.
