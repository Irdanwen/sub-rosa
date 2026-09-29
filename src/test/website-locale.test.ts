import { beforeEach, describe, expect, it } from "vitest";
import {
  initialWebsiteLocale,
  rememberWebsiteLocale,
  savedWebsiteLocale,
  setWebsiteLocale,
  t,
} from "../../website/src/lib/i18n";
import { localizedSiteHref, sitePaths } from "../../website/src/lib/paths";
import { accountSignInReturnPath } from "../../website/src/pages/account";

beforeEach(() => {
  localStorage.clear();
  setWebsiteLocale("en");
});

describe("website languages", () => {
  it("uses the browser on a first visit, then keeps an explicit choice", () => {
    expect(initialWebsiteLocale("/account", "", "fr-CH")).toBe("fr");
    rememberWebsiteLocale("en");
    expect(savedWebsiteLocale()).toBe("en");
    expect(initialWebsiteLocale("/account", "", "fr-CH")).toBe("en");
    expect(initialWebsiteLocale("/account", "lang=fr", "en-US")).toBe("fr");
    expect(initialWebsiteLocale("/fr/help", "", "en-US")).toBe("fr");
    expect(t("Help", "Aide")).toBe("Help");
    setWebsiteLocale("fr");
    expect(t("Help", "Aide")).toBe("Aide");
  });

  it("keeps public French routes apart from account and share contracts", () => {
    expect(localizedSiteHref("/downloads", "fr")).toBe("/fr/downloads");
    expect(localizedSiteHref("/account?intent=signup", "fr")).toBe(
      "/account?intent=signup&lang=fr",
    );
    expect(localizedSiteHref("/account", "en")).toBe("/account?lang=en");
    expect(
      sitePaths.handles(new URL("https://site.example/fr/privacy"), "https://site.example"),
    ).toBe(true);
    expect(
      sitePaths.handles(new URL("https://site.example/fr/account"), "https://site.example"),
    ).toBe(false);
  });

  it("does not send the display-language query to the sign-in return allowlist", () => {
    expect(accountSignInReturnPath("/account/top-up?lang=fr")).toBe("/account/top-up");
    expect(accountSignInReturnPath("/account/devices/verify?code=ABCDEFGH&lang=fr")).toBe(
      "/account/devices/verify?code=ABCDEFGH",
    );
    expect(accountSignInReturnPath("/account?intent=signup&lang=fr")).toBe("/account");
  });
});
