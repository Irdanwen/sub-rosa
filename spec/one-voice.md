# One voice, from the first screen to the last error

**Rule.** User-facing copy speaks to the reader about what they are doing, in
one register. Three things are binding:

1. **Address the reader.** "Your requests are handled by Carpe Diem" — not
   "Inference runs on Carpe Diem, under their terms."
2. **Name the reader's action, never the mechanism.** "Save a recording you
   lost", not "run recovery on the pending dictation row". The implementation
   noun is for the code; the surface says what happens.
3. **No jokes in failures.** Wit is allowed at most once, in a moment that is
   already going well (an empty state, a greeting). An error message explains
   what went wrong and what to do next, and nothing else.

**Why.** The app was reachable in three registers inside one hour of use: a
marketing line on an empty state, a legal-developer sentence on the welcome
screen, and a poetic greeting on the hero. Each was fine alone. Together they
read as three products, which is exactly the impression a private, careful tool
cannot afford. Tone is not decoration here: it is most of what "premium" means
once the pixels are already right.

**How to apply.** Read the sentence out loud. If it describes the system rather
than the person, rewrite it from their side. If it names a table, a row, a
service or a runtime, replace that noun with the thing the reader recognises
(CONTEXT.md is the list of names the product actually uses). If it is an error
and it is being clever, delete the cleverness.

**Exceptions.** Developer-facing surfaces are not covered: console hooks, the
report bundle, log lines, and anything behind an advanced diagnostics setting.
Provider names, model ids and file paths stay exactly as they are — a name the
user has to paste somewhere must not be paraphrased.
