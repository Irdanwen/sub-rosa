import { afterEach, describe, expect, it } from "vitest";
import type { OfficeGlobal } from "../../office-addins/src/office";
import { applyOfficeLanguage } from "../../office-addins/src/pane/mount";
import addinsDe from "../../website/src/locales/addins/de.json";
import appDe from "../../website/src/locales/app/de.json";
import { setWebsiteLocale, t, websiteLocale } from "../../website/src/lib/i18n";

/**
 * The task panes speak Office's display language, in any of the site's six:
 * their own sentences come from the `addins` catalog part, the web client's
 * sentences they reuse from `app`, both loaded before the first render.
 */
const office = (displayLanguage: string) =>
  ({ context: { displayLanguage } }) as unknown as OfficeGlobal;

describe("an Office pane's language", () => {
  afterEach(() => setWebsiteLocale("en"));

  it("follows Office into a catalog language and loads the panes' words", async () => {
    await applyOfficeLanguage(office("de-DE"));
    expect(websiteLocale()).toBe("de");
    expect(t("Shorten", "Raccourcir")).toBe(addinsDe.Shorten);
    expect(t("Shorten", "Raccourcir")).not.toBe("Shorten");
    expect(t("Through your app", "Par votre app")).toBe(appDe["Through your app"]);
  });

  it("keeps French in the code and falls back to English for a language the site lacks", async () => {
    await applyOfficeLanguage(office("fr-CA"));
    expect(t("Shorten", "Raccourcir")).toBe("Raccourcir");
    await applyOfficeLanguage(office("ja-JP"));
    expect(websiteLocale()).toBe("en");
    expect(t("Shorten", "Raccourcir")).toBe("Shorten");
  });
});
