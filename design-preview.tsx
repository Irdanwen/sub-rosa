/* Dev-only preview of the premium-pass surfaces. Not committed. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./src/styles/fonts.css";
import "./src/styles/tokens.css";
import "./src/styles/app.css";
import "./src/styles/mobile.css";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { IconNoteText } from "central-icons/IconNoteText";
import { AccentWheel } from "./src/components/settings/AccentWheel";
import { TabBar as DesktopTabBar, type TabItem } from "./src/components/tabs/TabBar";
import { TabBar as MobileTabBar } from "./src/components/mobile/TabBar";
import { EmptyState } from "./src/components/ui/EmptyState";
import { SimpleMarkdown } from "./src/lib/simple-markdown";
import { AutomationsSection } from "./src/components/settings/AutomationsSection";
import { MeetingAmbiguityPrompt, MeetingBadge } from "./src/components/calendar/MeetingContext";
import type { BrandId } from "./src/lib/brand";

const TABS: TabItem[] = [
  { id: "a", title: "Notes", icon: <IconNoteText size={14} /> },
  { id: "b", title: "Research pass", icon: <IconBubble3 size={14} />, status: "working" },
  { id: "c", title: "Deploy check", icon: <IconBubble3 size={14} />, status: "waitingForUser" },
  { id: "d", title: "Transcribing note", icon: <IconNoteText size={14} />, status: "working" },
];

function Preview() {
  const [accent, setAccent] = useState<BrandId>("gold");
  return (
    <div style={{ padding: 24, display: "grid", gap: 28, background: "var(--background)" }}>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Desktop tab strip (working / needs you)</h2>
        <div style={{ width: 640, background: "var(--sidebar)", padding: 8 }}>
          <DesktopTabBar
            tabs={TABS}
            activeTabId="b"
            onActivate={() => {}}
            onClose={() => {}}
            onCloseOthers={() => {}}
            onNew={() => {}}
          />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Accent wheel (7 presets, gold selected)</h2>
        <AccentWheel value={accent} onChange={setAccent} />
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Mobile tab bar (chat + studio busy)</h2>
        <div style={{ width: 390, border: "1px solid var(--border)" }}>
          <MobileTabBar active="notes" onSelect={() => {}} busy={{ agent: true, studio: true }} />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Shimmers (chat step, studio progress) + skeleton cell</h2>
        <div style={{ display: "grid", gap: 10, width: 390 }}>
          <span className="mobile-chat-step-label" data-shimmer="true">
            Searching the web · sub rosa meaning
          </span>
          <p className="mobile-studio-progress" data-shimmer="true">
            Rendering video. You can leave this tab; the job resumes.
          </p>
          <span className="mobile-studio-cell-loading" style={{ width: 120, height: 120 }} />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Gallery sheet grid (squeezed flex context)</h2>
        <div style={{ width: 390, maxHeight: 300, display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}>
          <div className="mobile-studio-grid mobile-sheet-grid">
            {["b91c1c", "0e7490", "4d7c0f", "7c3aed", "b45309", "0f766e", "9d174d"].map((c) => (
              <button key={c} type="button" className="mobile-studio-cell">
                <img
                  alt=""
                  src={`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="200"><rect width="60" height="200" fill="%23${c}"/><circle cx="30" cy="100" r="24" fill="white"/></svg>`.replace("%23", "#"))}`}
                />
              </button>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Chat block: links card + skeleton</h2>
        <div style={{ width: 390, display: "grid", gap: 12 }}>
          <SimpleMarkdown
            text={`Voici ce que dit la presse.\n\n\`\`\`subrosa:links\n${JSON.stringify({
              v: 1,
              title: "Sources",
              links: [
                {
                  title: "Swiss cross-border tax rules, 2026 update",
                  url: "https://www.example.com/frontalier-2026",
                  snippet: "The canton of Geneva confirmed the withholding changes.",
                },
                {
                  title: "CE 883/2004 explained",
                  url: "https://europa.example.org/ce-883",
                  snippet: "Which country insures a cross-border worker with a side activity.",
                },
              ],
            })}\n\`\`\``}
          />
          <SimpleMarkdown text={'Checking coverage.\n\n```subrosa:links\n{"v":1,"links":[{"ti'} streaming />
          <SimpleMarkdown
            text={`Voici les principales adresses :\n\n\`\`\`subrosa:places\n${JSON.stringify({
              v: 1,
              title: "Experts-comptables du bassin annemassien",
              attribution: "google",
              places: [
                {
                  name: "Sogeca Experts",
                  lat: 46.1934,
                  lng: 6.2356,
                  rating: 5,
                  reviews: 8,
                  category: "Accountant",
                  address: "Rue de la Gare, Annemasse",
                  note: "Le mieux noté d'Annemasse.",
                  url: "https://sogeca.example.com",
                  photoRef: "places/sogeca/photos/one",
                },
                {
                  name: "Majexperts",
                  lat: 46.1972,
                  lng: 6.2411,
                  rating: 4.7,
                  reviews: 12,
                  category: "Accountant",
                  address: "Avenue de Verdun, Annemasse",
                  photoRef: "places/majexperts/photos/one",
                },
                {
                  name: "Groupement frontaliers",
                  lat: 46.1898,
                  lng: 6.2287,
                  category: "Association",
                  address: "Ville-la-Grand",
                },
              ],
            })}\n\`\`\``}
          />
          <SimpleMarkdown
            text={`D'après tes réunions :\n\n\`\`\`subrosa:notes\n${JSON.stringify({
              v: 1,
              title: "From your notes",
              notes: [
                {
                  id: "note-standup",
                  title: "Standup 12 August",
                  snippet: "Rollout decisions and the two follow-ups.",
                },
                { id: "note-onboarding", title: "Onboarding plan review" },
              ],
            })}\n\`\`\``}
          />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Calendar context on a note</h2>
        <div style={{ width: 390, display: "grid", gap: 16 }}>
          <div>
            <input className="note-title" value="Point produit" readOnly />
            <MeetingBadge
              scheduledStart={new Date(Date.now() + 3600_000).toISOString()}
              attendees={["Marie Dubois", "Tom Keller", "Ana Ruiz", "Sam Vidal"]}
            />
          </div>
          <MeetingAmbiguityPrompt
            noteId="note-demo"
            events={[
              {
                id: "e1",
                title: "Point produit",
                start: Math.floor(Date.now() / 1000) + 120,
                end: Math.floor(Date.now() / 1000) + 1920,
                allDay: false,
                attendees: ["Marie Dubois", "Tom Keller"],
              },
              {
                id: "e2",
                title: "Bloc de travail",
                start: Math.floor(Date.now() / 1000) - 1800,
                end: Math.floor(Date.now() / 1000) + 9000,
                allDay: false,
                attendees: [],
              },
            ]}
            onResolved={() => {}}
          />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Proposal card + automations</h2>
        <div style={{ width: 460, display: "grid", gap: 16 }}>
          <SimpleMarkdown
            text={`Voilà ce que je peux faire :\n\n\`\`\`subrosa:proposal\n${JSON.stringify({
              v: 1,
              proposalId: "prop-demo",
              title: "Follow-ups",
              actions: [
                {
                  kind: "reminder",
                  id: "a1",
                  label: "Envoyer les chiffres à Ana",
                  due: new Date(Date.now() + 86400000).toISOString(),
                },
                {
                  kind: "event",
                  id: "a2",
                  label: "Point de suivi avec Marie",
                  start: new Date(Date.now() + 172800000).toISOString(),
                },
                {
                  kind: "note",
                  id: "a3",
                  label: "Ajouter à la note",
                  noteId: "note-1",
                  text: "Ana pilote la migration.",
                },
              ],
            })}\n\`\`\``}
          />
          <AutomationsSection />
        </div>
      </section>
      <section>
        <h2 style={{ font: "600 13px var(--font-sans)" }}>Empty state with glyph</h2>
        <div style={{ width: 390 }}>
          <EmptyState
            icon={<IconCameraSparkle size={28} />}
            title="Nothing generated yet"
            description="Images, videos and audio you make in Studio collect here, on this device."
          />
        </div>
      </section>
    </div>
  );
}

if (new URLSearchParams(location.search).get("theme") === "dark") {
  document.documentElement.setAttribute("data-theme", "dark");
}
document.documentElement.style.setProperty("--brand", "#8f6b2e");

// Fake Tauri bridge: render_map_card returns a canvas-drawn placeholder so
// the places card shows its full layout in the browser preview.
function fakeMap(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#e9ecdf";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d3e2e8";
  ctx.beginPath();
  ctx.ellipse(canvas.width * 0.2, canvas.height * 0.25, 160, 90, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#c7c3b4";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height * 0.62);
  ctx.quadraticCurveTo(canvas.width * 0.5, canvas.height * 0.45, canvas.width, canvas.height * 0.7);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(canvas.width * 0.35, 0);
  ctx.lineTo(canvas.width * 0.45, canvas.height);
  ctx.stroke();
  return canvas.toDataURL("image/png");
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  transformCallback: (cb: unknown) => cb,
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args?: { request?: { width: number; height: number } }) => {
    if (cmd === "render_map_card" && args?.request) {
      return { dataUrl: fakeMap(args.request.width, args.request.height) };
    }
    if (cmd === "places_photo_data_url") {
      const canvas = document.createElement("canvas");
      canvas.width = 88;
      canvas.height = 88;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, 88, 88);
        grad.addColorStop(0, "#c9a962");
        grad.addColorStop(1, "#936862");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 88, 88);
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        ctx.arc(44, 34, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(44, 74, 24, 18, 0, Math.PI, 0);
        ctx.fill();
      }
      return { dataUrl: canvas.toDataURL("image/png") };
    }
    return null;
  },
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
