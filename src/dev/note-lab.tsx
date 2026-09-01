/** Scratch harness: mounts the note editor on its own, with no Tauri bridge.
 * Not shipped — `note-lab.html` is not a build input. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NotePreview } from "../components/note-editor/NotePreview";
import "../styles/app.css";

// A fake backend, so the revision surface can be driven without a sidecar and
// without a paid call. It speaks enough of the Tauri bridge for `listen` and
// `invoke` to work, and streams a canned reply word by word the way the real
// one does.
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<string, number[]>();
let nextCallbackId = 1;

function emit(eventName: string, payload: unknown) {
  for (const id of listeners.get(eventName) ?? []) {
    callbacks.get(id)?.({ event: eventName, id, payload });
  }
}

(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
  transformCallback(cb: (payload: unknown) => void) {
    const id = nextCallbackId++;
    callbacks.set(id, cb);
    return id;
  },
  async invoke(cmd: string, args: Record<string, unknown>) {
    if (cmd === "plugin:event|listen") {
      const eventName = args.event as string;
      const handler = args.handler as number;
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return handler;
    }
    if (cmd === "plugin:event|unlisten" || cmd === "cancel_note_rewrite") return;
    if (cmd !== "note_rewrite") throw new Error(`unmocked command: ${cmd}`);

    const request = args.request as { requestId: string; kind: string; text: string };
    const reply =
      request.kind === "restructure"
        ? "## Ce qu'il faut faire\n\n- [ ] Prévenir Sébastien de la date d'intervention\n- [ ] Envoyer les PDF d'exécution via wetransfert\n- [ ] Prévoir les manchons pour le tirage depuis la chambre\n\n## Qui paye\n\nLoïc paye l'armoire ; la facture de l'électricien passe par les TPG."
        : `${request.text} — réécrit.`;
    const pieces = reply.split(/(\s+)/);
    for (const piece of pieces) {
      await new Promise((r) => setTimeout(r, 24));
      emit("june://note-rewrite", {
        requestId: request.requestId,
        phase: "delta",
        text: piece,
      });
    }
    return { requestId: request.requestId, text: reply, promptVersion: "lab" };
  },
};

const SEED = [
  "# Séance avec Sébastien Lopez des TPG",
  "",
  "Pour la modification de l'armoire au carrefour Vernier. Du texte avec du **gras**, de l'*italique*, du `code`, un [lien](https://example.com) et du ==surligné==.",
  "",
  "## Gestion des réseaux",
  "",
  "- TPG : Sébastien Lopez, Asmir Zeneli",
  "  - Sous-point imbriqué",
  "- Swisscom : Thierry Jungo",
  "",
  "### À faire",
  "",
  "- [x] Envoyer les PDF via wetransfert",
  "- [ ] Prévenir Sébastien de la date d'intervention",
  "  - [ ] confirmer avec son électricien",
  "- [ ] Refaire le FIA quand les plans sont envoyés",
  "",
  "1. Première étape",
  "2. Deuxième étape",
  "",
  "> Voir avec Loïc, qui paye pour l'armoire.",
  "",
  "---",
  "",
  "```sh",
  "curl -s https://example.com | jq .",
  "```",
].join("\n");

function Lab() {
  const [markdown, setMarkdown] = useState(SEED);
  const [saved, setSaved] = useState(SEED);
  const [reading, setReading] = useState(false);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: "100vh" }}>
      <div style={{ padding: "32px 40px", overflow: "auto" }}>
        <button type="button" onClick={() => setReading((on) => !on)} style={{ marginBottom: 16 }}>
          {reading ? "Back to writing" : "Read"}
        </button>
        <div className="note-body-stack" data-reading={reading || undefined}>
          <NotePreview
            noteId="lab"
            markdown={markdown}
            editable={!reading}
            onChange={(_id, next) => {
              setSaved(next);
              setMarkdown(next);
            }}
          />
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "32px 40px",
          overflow: "auto",
          borderLeft: "1px solid var(--border)",
          background: "var(--card)",
          font: "12px/1.6 ui-monospace, monospace",
          whiteSpace: "pre-wrap",
        }}
      >
        {saved}
      </pre>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Lab />);
