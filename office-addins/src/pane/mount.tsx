import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setApiTransport } from "../../../website/src/lib/api";
import {
  requireWebsiteMessages,
  setWebsiteLocale,
  siteLocaleFromTag,
} from "../../../website/src/lib/i18n";
import {
  displayLanguage,
  type HostName,
  type OfficeGlobal,
  officeGlobal,
  officeReady,
} from "../office";
import { OfficeAccess, type Ready } from "./Access";
import { noSession } from "./sign-in-window";
import "../office.css";

/**
 * The site's copy follows Office's display language, in any of the site's
 * six. The four catalog languages need their words before the first render:
 * the site's, the web client's the panes reuse, and the panes' own (`addins`,
 * kept by `scripts/i18n/website.mjs`).
 */
export async function applyOfficeLanguage(office: OfficeGlobal | null) {
  const locale = siteLocaleFromTag(displayLanguage(office)) ?? "en";
  setWebsiteLocale(locale);
  await Promise.all([
    requireWebsiteMessages("app", locale),
    requireWebsiteMessages("addins", locale),
  ]).catch(() => {
    // A catalog that fails to load leaves the pane in English, never blank.
  });
}

/** Mounts a host's pane once Office is ready, behind the account gate. */
export async function mountPane(
  host: HostName,
  render: (ready: Ready, office: OfficeGlobal) => ReactNode,
) {
  // The pane's origin has no account session and serves no API: until a
  // sign-in window carries them, the site's calls answer "no session" here.
  setApiTransport(noSession);
  const found = officeGlobal();
  const ready = await officeReady(found);
  // A page opened outside Office still renders, and says so.
  const office = ready ? found : null;
  await applyOfficeLanguage(office);
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
