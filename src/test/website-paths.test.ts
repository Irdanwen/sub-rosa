import { describe, expect, it } from "vitest";
import { createSitePaths } from "../../website/src/lib/paths";

describe("website deployment boundaries", () => {
  it("keeps the dedicated account host at root with relative links", () => {
    const site = createSitePaths();
    expect(site.href("/account/devices/verify?code=ABCD")).toBe(
      "/account/devices/verify?code=ABCD",
    );
    expect(site.route("/downloads/")).toBe("/downloads");
    expect(site.hostsAccounts).toBe(true);
    expect(
      site.handles(new URL("https://accounts.example/auth/login"), "https://accounts.example"),
    ).toBe(false);
    expect(
      site.handles(new URL("https://accounts.example/api/v1/me"), "https://accounts.example"),
    ).toBe(false);
  });

  it("prefixes marketing links and sends accounts to a separate HTTPS origin", () => {
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    expect(site.href("/")).toBe("/subrosa/");
    expect(site.href("/downloads")).toBe("/subrosa/downloads");
    expect(site.href("/rose.png")).toBe("/subrosa/rose.png");
    expect(site.href("/account?intent=signup")).toBe(
      "https://accounts.example/account?intent=signup",
    );
    expect(site.route("/subrosa")).toBe("/");
    expect(site.route("/subrosa/downloads/")).toBe("/downloads");
    expect(site.route("/subrosanews")).toBeNull();
    expect(site.hostsAccounts).toBe(false);
    expect(
      site.handles(
        new URL("https://marketing.example/subrosa/downloads"),
        "https://marketing.example",
      ),
    ).toBe(true);
    for (const path of [
      "/",
      "/other",
      "/subrosa/rose.png",
      "/subrosa/api/v1/me",
      "/subrosa/account",
      "/subrosa/downloads#details",
    ])
      expect(
        site.handles(new URL(path, "https://marketing.example"), "https://marketing.example"),
      ).toBe(false);
    expect(site.handles(new URL(site.href("/account")), "https://marketing.example")).toBe(false);
  });

  it("never mounts account functionality on a shared-origin path", () => {
    expect(createSitePaths("/subrosa/").hostsAccounts).toBe(false);
  });

  it("rejects unsafe base and account settings", () => {
    for (const base of [
      "https://other.example/",
      "//other/",
      "/../",
      "/subrosa",
      "/a%2fb/",
      "/a?b/",
    ])
      expect(() => createSitePaths(base)).toThrow();
    for (const origin of [
      "http://accounts.example",
      "https://user:password@accounts.example",
      "https://accounts.example/path",
      "https://accounts.example/",
      "https://accounts.example?redirect=x",
    ])
      expect(() => createSitePaths("/", origin)).toThrow();
    for (const path of [
      "//other.example",
      "https://other.example",
      "/\\other.example",
      "/account#secret",
    ])
      expect(() => createSitePaths().href(path)).toThrow();
  });
});
