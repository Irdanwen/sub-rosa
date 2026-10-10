// The entry of the office origin's /python-sandbox.html, which the Excel pane
// frames with `sandbox="allow-scripts"` (ADR-0104 addendum of 2026-10-10): the
// site's own sandbox, built again for this origin, since a pane frames the
// sandbox of the origin it runs on. It imports nothing a pane imports, so the
// build keeps it in its own `python-sandbox` chunk, the only scripts the
// frame's policy and this origin's CORS headers admit.
import "../../website/src/client/analysis/python-sandbox";
