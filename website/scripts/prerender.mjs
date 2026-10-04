import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const escapeAttribute = (value) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const server = await createServer({
  mode: "production",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { App } = await server.ssrLoadModule("/src/App.tsx");
  const { guides, guideBySlug } = await server.ssrLoadModule("/src/pages/docs-content.ts");
  const { families, familyBySlug } = await server.ssrLoadModule("/src/models/catalog.ts");
  await (await server.ssrLoadModule("/src/models/loader.ts")).loadModelCatalog();
  const { categories } = await server.ssrLoadModule("/src/models/catalog.ts");
  const { loadDetails } = await server.ssrLoadModule("/src/models/details.ts");
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
  const base = server.config.base.replace(/\/$/, "");
  for (const path of [...pages, ...pages.map((page) => (page === "/" ? "/fr/" : `/fr${page}`))]) {
    const french = path === "/fr/" || path.startsWith("/fr/");
    const page = french ? (path === "/fr/" ? "/" : path.slice(3)) : path;
    const body = renderToString(createElement(App, { initialPath: path }));
    const guide = page.startsWith("/docs/") ? guideBySlug(page.slice(6)) : null;
    const family = page.startsWith("/models/") ? familyBySlug(page.slice(8)) : null;
    const kind = page.startsWith("/models/")
      ? categories.find((item) => item.id === page.slice(8))
      : null;
    const catalogTitle = french ? "Catalogue des modèles" : "Model catalog";
    const extraTitle =
      page === "/models/guide"
        ? `${french ? "Comprendre les modèles" : "Understanding models"} · ${catalogTitle} · Sub Rosa`
        : page === "/models/compare"
          ? `${french ? "Comparer les modèles" : "Compare models"} · ${catalogTitle} · Sub Rosa`
          : kind
            ? `${kind.title[french ? 1 : 0]} · ${catalogTitle} · Sub Rosa`
            : null;
    const title = extraTitle
      ? extraTitle
      : guide
        ? `${guide.title[french ? 1 : 0]} · Sub Rosa`
        : family
          ? `${french ? (family.nameFr ?? family.name) : family.name} · ${french ? "Catalogue des modèles" : "Model catalog"} · Sub Rosa`
          : page === "/"
            ? "Sub Rosa"
            : `${{ "/downloads": french ? "Télécharger" : "Download", "/privacy": french ? "Confidentialité" : "Privacy", "/security": french ? "Sécurité" : "Security", "/help": "Documentation", "/docs": "Documentation", "/models": french ? "Catalogue des modèles" : "Model catalog" }[page]} · Sub Rosa`;
    const description = kind
      ? escapeAttribute(kind.description[french ? 1 : 0])
      : page === "/models/guide"
        ? french
          ? "Jetons, fenêtre de contexte, raisonnement, poids ouverts, benchmarks et classements Elo : ce qui rend les modèles d’IA différents, expliqué simplement."
          : "Tokens, context windows, reasoning, open weights, benchmarks and Elo ratings: what makes AI models different, explained plainly."
        : page === "/models/compare"
          ? french
            ? "Comparez jusqu’à trois modèles d’IA côte à côte : scores, prix, versions, forces et limites."
            : "Compare up to three AI models side by side: scores, prices, versions, strengths and limits."
          : guide
            ? guide.summary[french ? 1 : 0]
            : family
              ? escapeAttribute(family.summary[french ? 1 : 0])
              : page === "/models"
                ? french
                  ? "Ce que chaque modèle de Sub Rosa sait faire, ce qu’il coûte et comment choisir : texte, transcription, image, retouche, vidéo, voix et musique."
                  : "What each Sub Rosa model is good at, what it costs and how to choose: text, transcription, image, editing, video, voice and music."
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
