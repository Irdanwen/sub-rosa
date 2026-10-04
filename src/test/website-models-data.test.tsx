import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "../../website/src/App";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { createSitePaths } from "../../website/src/lib/paths";
import {
  type FamilyDetail,
  benchmarkById,
  benchmarks,
  categories,
  families,
  familyBySlug,
  scores,
  snapshot,
} from "../../website/src/models/catalog";
import { detailOf, loadDetails } from "../../website/src/models/details";
import indexFile from "../../website/src/models/details/index.json";
import { loadModelCatalog } from "../../website/src/models/loader";

const details = Object.values(
  import.meta.glob<{ families: FamilyDetail[] }>(
    ["../../website/src/models/details/*.json", "!../../website/src/models/details/index.json"],
    {
      eager: true,
      import: "default",
    },
  ),
).flatMap((file) => file.families ?? []);
const known = new Set(snapshot.models.map((model) => model.id));
const isoDate = /^\d{4}-\d{2}(-\d{2})?$/;

beforeAll(async () => {
  await loadModelCatalog();
  await Promise.all(categories.map((category) => loadDetails(category.id)));
});

describe("model catalog depth", () => {
  it("gives every family its difference, its history, its use cases and its rivals", () => {
    expect(details.map((detail) => detail.slug).sort()).toEqual(
      families.map((family) => family.slug).sort(),
    );
    for (const detail of details) {
      const family = familyBySlug(detail.slug);
      expect(family, detail.slug).toBeDefined();
      if (!family) continue;
      expect(detail.differentiator[0].length, detail.slug).toBeGreaterThan(40);
      expect(detail.signature, detail.slug).toHaveLength(3);
      expect(detail.releases.length, detail.slug).toBeGreaterThan(0);
      expect(detail.useCases.length, detail.slug).toBeGreaterThanOrEqual(2);
      expect(detail.rivals.length, detail.slug).toBeGreaterThanOrEqual(1);
      for (const rival of detail.rivals)
        expect(familyBySlug(rival.slug)?.category, `${detail.slug} → ${rival.slug}`).toBe(
          family.category,
        );
      for (const url of detail.sources) expect(url, detail.slug).toMatch(/^https:\/\//);
    }
  });

  it("dates releases honestly: a real date, in order, or none at all", () => {
    for (const detail of details) {
      const dated = detail.releases.map((release) => release.date).filter(Boolean) as string[];
      expect([...dated].sort(), detail.slug).toEqual(dated);
      for (const release of detail.releases) {
        if (release.date) {
          expect(release.date, `${detail.slug} ${release.version}`).toMatch(isoDate);
          expect(release.date <= snapshot.checkedAt, `${detail.slug} ${release.version}`).toBe(
            true,
          );
        }
        for (const id of release.ids) expect(known.has(id), id).toBe(true);
      }
      const family = familyBySlug(detail.slug);
      const covered = new Set(detail.releases.flatMap((release) => release.ids));
      for (const id of family?.ids ?? [])
        expect(covered.has(id), `${detail.slug}: ${id} has no release`).toBe(true);
    }
  });

  it("keeps every score sourced, dated, on its own scale and tied to a real model", () => {
    expect(scores.length).toBeGreaterThan(200);
    for (const score of scores) {
      const benchmark = benchmarkById(score.benchmark);
      const name = `${score.benchmark} ${score.model}`;
      expect(benchmark, name).toBeDefined();
      if (!benchmark) continue;
      expect(score.url, name).toMatch(/^https:\/\//);
      expect(score.date, name).toMatch(isoDate);
      expect(score.date <= snapshot.checkedAt, name).toBe(true);
      expect(["independent", "vendor"]).toContain(score.kind);
      expect(
        score.value >= benchmark.scale[0] && score.value <= benchmark.scale[1],
        `${name} = ${score.value}`,
      ).toBe(true);
      if (!score.external) expect(known.has(score.model), name).toBe(true);
    }
    for (const benchmark of benchmarks) {
      expect(benchmark.measures[1].length, benchmark.id).toBeGreaterThan(20);
      expect(benchmark.howToRead[1].length, benchmark.id).toBeGreaterThan(20);
    }
  });

  it("indexes every dated release the pages list without their detail chunk", () => {
    const index = indexFile as {
      families: { slug: string; releases: { version: string; date: string }[] }[];
    };
    for (const detail of details) {
      const entry = index.families.find((item) => item.slug === detail.slug);
      expect(
        entry?.releases.map((release) => release.version),
        detail.slug,
      ).toEqual(
        detail.releases.filter((release) => release.date).map((release) => release.version),
      );
    }
  });

  it("routes the guide, the comparator and every kind of work in both languages", () => {
    const site = createSitePaths("/subrosa/", "https://accounts.example");
    const origin = "https://marketing.example";
    const paths = ["guide", "compare", ...categories.map((category) => category.id)];
    for (const path of paths)
      for (const prefix of ["/subrosa/models/", "/subrosa/fr/models/"])
        expect(site.handles(new URL(`${prefix}${path}`, origin), origin), path).toBe(true);
  });

  it("renders every new page with real numbers, never NaN or undefined", () => {
    const pages = [
      "/fr/models",
      "/models/guide",
      "/fr/models/compare?m=glm,kimi,claude",
      ...categories.map((category) => `/fr/models/${category.id}`),
      ...["glm", "kling-v3", "kokoro", "parakeet", "nano-banana-edit", "mmaudio"].map(
        (slug) => `/models/${slug}`,
      ),
    ];
    for (const path of pages) {
      setWebsiteLocale(path.startsWith("/fr") ? "fr" : "en");
      const html = renderToString(<App initialPath={path} />);
      expect(html, path).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
    }
    setWebsiteLocale("fr");
    const glm = renderToString(<App initialPath="/fr/models/glm" />);
    expect(glm).toContain("Historique des versions");
    expect(glm).toContain(detailOf("glm")?.differentiator[1].slice(0, 30) ?? "missing");
    const compare = renderToString(<App initialPath="/fr/models/compare?m=glm,kimi" />);
    expect(compare).toContain("Kimi");
  });
});
