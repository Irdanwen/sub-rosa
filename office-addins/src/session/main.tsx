import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { officeGlobal, officeReady } from "../office";
import { applyOfficeLanguage } from "../pane/mount";
import { SessionWindow } from "./SessionWindow";
import "../office.css";

const office = officeGlobal();
void officeReady(office).then(async (host) => {
  const root = document.getElementById("root");
  // Only an add-in opens this window; outside Office it has nobody to carry for.
  if (!root || !office || !host) return;
  await applyOfficeLanguage(office);
  createRoot(root).render(
    <StrictMode>
      <SessionWindow
        office={office}
        fresh={new URLSearchParams(location.search).get("fresh") === "1"}
      />
    </StrictMode>,
  );
});
