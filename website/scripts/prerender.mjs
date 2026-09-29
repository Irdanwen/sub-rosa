import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  mode: "production",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { guides, guideBySlug } = await server.ssrLoadModule("/src/pages/docs-content.ts");
  const template = await readFile("dist/index.html", "utf8");
  const pages = [
    "/",
    "/downloads",
    "/privacy",
    "/security",
    "/help",
    "/docs",
    ...guides.map((guide) => `/docs/${guide.slug}`),
  ];
  const base = server.config.base.replace(/\/$/, "");
  for (const path of [...pages, ...pages.map((page) => (page === "/" ? "/fr/" : `/fr${page}`))]) {
    const french = path === "/fr/" || path.startsWith("/fr/");
    const page = french ? (path === "/fr/" ? "/" : path.slice(3)) : path;
    const body = renderToString(createElement(App, { initialPath: path }));
    const guide = page.startsWith("/docs/") ? guideBySlug(page.slice(6)) : null;
    const title = guide
      ? `${guide.title[french ? 1 : 0]} · Sub Rosa`
      : page === "/"
        ? "Sub Rosa"
        : `${{ "/downloads": french ? "Télécharger" : "Download", "/privacy": french ? "Confidentialité" : "Privacy", "/security": french ? "Sécurité" : "Security", "/help": "Documentation", "/docs": "Documentation" }[page]} · Sub Rosa`;
    const description = guide
      ? guide.summary[french ? 1 : 0]
      : french
        ? "Sub Rosa réunit vos conversations, vos notes et vos idées dans un espace personnel. Téléchargez l’app pour votre appareil."
        : "Sub Rosa brings conversations, notes and ideas into one personal workspace. Download the app for your device.";
    const enPath = `${base}${page}`;
    const frPath = `${base}/fr${page === "/" ? "/" : page}`;
    const html = template
      .replace('<html lang="en">', `<html lang="${french ? "fr" : "en"}">`)
      .replace(
        /<meta name="description" content="[^"]*" \/>/,
        `<meta name="description" content="${description}" /><link rel="alternate" hreflang="en" href="${enPath}" /><link rel="alternate" hreflang="fr" href="${frPath}" />`,
      )
      .replace("<title>Sub Rosa</title>", `<title>${title}</title>`)
      .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    if (html === template) throw new Error("Prerender root is missing");
    const directory = join("dist", path.slice(1));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.html"), html);
  }
} finally {
  await server.close();
}
