import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setWebsiteLocale } from "../../../website/src/lib/i18n";
import {
  displayLanguage,
  type HostName,
  type OfficeGlobal,
  officeGlobal,
  officeReady,
} from "../office";
import { OfficeAccess, type Ready } from "./Access";
import "../office.css";

/** The site's copy follows Office's display language. */
export function applyOfficeLanguage(office: OfficeGlobal | null) {
  setWebsiteLocale(displayLanguage(office).toLowerCase().startsWith("fr") ? "fr" : "en");
}

/** Mounts a host's pane once Office is ready, behind the account gate. */
export async function mountPane(
  host: HostName,
  render: (ready: Ready, office: OfficeGlobal) => ReactNode,
) {
  const found = officeGlobal();
  const ready = await officeReady(found);
  // A page opened outside Office still renders, and says so.
  const office = ready ? found : null;
  applyOfficeLanguage(office);
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <main className="office-pane">
        <header className="office-header">
          <h1 className="office-brand">Sub Rosa</h1>
          <span className="quiet">{host}</span>
        </header>
        <OfficeAccess office={office} host={host}>
          {(access) => (office ? render(access, office) : null)}
        </OfficeAccess>
      </main>
    </StrictMode>,
  );
}
