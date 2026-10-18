# ComfyUI template corpus

A frozen sample of the official ComfyUI workflow templates, used by
`src/test/workflow-comfy-corpus.test.ts` to measure what the importer
(ADR-0075) keeps, adjusts and drops on real files, and by the default
catalog work (ADR-0121) to read each recipe before re-authoring it.

- **Source:** `Comfy-Org/workflow_templates`, commit
  `59a3b48bf369c5a15f29a1308bae3e279fa15505` (2026-10-18), `templates/<name>.json`.
  Minified, otherwise unchanged.
- **Licence:** MIT, Copyright (c) 2023-present Comfy Org, see `LICENSE` here.
- **`catalog.json`:** the media models Carpe Diem published the same day
  (`GET /api/operator/v1/models`, id and `carpe_diem_type` only), so the
  importer picks models against a real catalog rather than a hand-made one.

To refresh, download the same names at a newer commit, rewrite `catalog.json`
from the live endpoint, then run the test with `-u` and read the diff of
`report.json`: every line that moved is an importer behaviour that changed.
