import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const escapeAttribute = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const server = await createServer({
  mode: "production",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const i18n = await server.ssrLoadModule("/src/lib/i18n.ts");
  const { alternateLinks, siteOrigin } = await server.ssrLoadModule("/src/lib/alternates.ts");
  const { pageMeta } = await server.ssrLoadModule("/src/pages/meta.ts");
  const { guides } = await server.ssrLoadModule("/src/pages/docs-content.ts");
  const { families } = await server.ssrLoadModule("/src/models/catalog.ts");
  await (await server.ssrLoadModule("/src/models/loader.ts")).loadModelCatalog();
  const { categories } = await server.ssrLoadModule("/src/models/catalog.ts");
  const { loadDetails } = await server.ssrLoadModule("/src/models/details.ts");
  // Marks every kind's words as needed, so each language below loads them all.
  await Promise.all(categories.map((category) => loadDetails(category.id)));
  const template = await readFile("dist/index.html", "utf8");
  const pages = [
    "/",
    "/downloads",
    "/privacy",
    "/security",
    "/help",
    "/docs",
    ...guides.map((guide) => `/docs/${guide.slug}`),
    "/models",
    "/models/guide",
    "/models/compare",
    ...categories.map((category) => `/models/${category.id}`),
    ...families.map((family) => `/models/${family.slug}`),
  ];
  // hreflang alternates must be absolute URLs, so the build knows its origin.
  const origin = siteOrigin(server.config.base, server.config.env.VITE_SITE_ORIGIN ?? "");
  // Every public page in each of the site's languages: English at the root,
  // the others under their prefix (`/fr/`, `/de/`, `/pt-br/`), each naming
  // all of them as alternates.
  for (const locale of i18n.SITE_LOCALES) {
    await i18n.loadWebsiteMessages(locale);
    for (const page of pages) {
      const path = i18n.localizedPublicPath(page, locale);
      i18n.setWebsiteLocale(locale);
      const body = renderToString(createElement(App, { initialPath: path }));
      i18n.setWebsiteLocale(locale);
      const { title, description } = pageMeta(page);
      const alternates = alternateLinks(page, server.config.base, origin);
      const html = template
        .replace('<html lang="en">', `<html lang="${locale}">`)
        .replace(
          /<meta name="description" content="[^"]*" \/>/,
          `<meta name="description" content="${escapeAttribute(description)}" />${alternates}`,
        )
        .replace("<title>Sub Rosa</title>", `<title>${escapeText(title)}</title>`)
        .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
      if (html === template) throw new Error("Prerender root is missing");
      const directory = join("dist", path.slice(1));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.html"), html);
    }
  }
} finally {
  await server.close();
}
