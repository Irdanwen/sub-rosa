// The English sentence is the key (ADR-0047), so one English word used in two
// senses gets one translation for both, and one of them reads wrong. "Archive"
// was the button that files a chat or a note away (a verb) and the settings
// section that writes the archive file of ADR-0042 (a noun); "Shortcuts" was
// the keyboard shortcuts on the desktop and the Shortcuts app on the iPhone.
// Each sense now has its own sentence, and this pins the split.

import { describe, expect, it } from "vitest";
import archiveSection from "../components/settings/ArchiveSection.tsx?raw";
import sectionScreen from "../components/mobile/screens/SectionScreen.tsx?raw";
import settingsScreen from "../components/mobile/screens/SettingsScreen.tsx?raw";
import notesScreen from "../components/mobile/screens/NotesScreen.tsx?raw";
import sidebarContext from "../components/sidebar/sidebar-context.tsx?raw";
import mobileApp from "../app/mobile/MobileApp.tsx?raw";
import { ARCHIVE_FOLDER_NAME } from "../lib/chat-archive";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import it_ from "../locales/it.json";
import ptBR from "../locales/pt-BR.json";

const catalogs: Record<string, Record<string, string>> = { fr, de, it: it_, es, "pt-BR": ptBR };

describe("words with two senses", () => {
  it("names the archive file apart from the archive action", () => {
    expect(archiveSection).toContain('t("Archive file")');
    expect(archiveSection).not.toContain('t("Archive")');
    expect(sectionScreen).toContain('title={t("Archive file")}');
    expect(settingsScreen).toContain('label={t("Archive file")}');
    // The action keeps the verb.
    expect(sidebarContext).toContain('t("Archive")');
    expect(notesScreen).toContain('label: t("Archive")');
  });

  it("names the Shortcuts app apart from the keyboard shortcuts", () => {
    expect(settingsScreen).toContain('t("Shortcuts app")');
    expect(settingsScreen).not.toContain('t("Shortcuts")');
  });

  it("translates each sense differently in every language", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.Archive, locale).not.toBe(catalog["Archive file"]);
      expect(catalog.Shortcuts, locale).not.toBe(catalog["Shortcuts app"]);
    }
  });

  it("still finds the shared Archive folder by its stored name, not its copy", () => {
    // The folder's name is data synchronised across devices, never a
    // translated label: the phone and the desktop look for "Archive".
    expect(ARCHIVE_FOLDER_NAME).toBe("Archive");
    expect(mobileApp).toContain('folder.name.toLowerCase() === "archive"');
    expect(mobileApp).toContain('createFolder("Archive")');
  });
});
