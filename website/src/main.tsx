import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  browserWebsiteLocale,
  initialWebsiteLocale,
  loadWebsiteMessages,
  localizedPublicPath,
  rememberWebsiteLocale,
  requestedWebsiteLocale,
  savedWebsiteLocale,
  setWebsiteLocale,
  splitLocalePath,
  websiteLocale,
} from "./lib/i18n";
import { siteHref, sitePaths } from "./lib/paths";
import { loadModelCatalog, modelsPath } from "./models/loader";

const root = document.getElementById("root");
const route = sitePaths.route(location.pathname) ?? "/not-found";
const languages = navigator.languages?.length ? navigator.languages : navigator.language;
const requestedLanguage = requestedWebsiteLocale(location.search);
if (requestedLanguage) rememberWebsiteLocale(requestedLanguage);
const { locale: prefixed, page } = splitLocalePath(route);
if (prefixed) rememberWebsiteLocale(prefixed);
// The home page opens in the reader's language: the one they chose, or else
// the first of their browser's languages the site speaks.
const preferred = savedWebsiteLocale() ?? browserWebsiteLocale(languages);
const redirectTo = route === "/" && preferred && preferred !== "en" ? preferred : null;
if (redirectTo) {
  location.replace(siteHref(localizedPublicPath("/", redirectTo)));
} else {
  setWebsiteLocale(
    prefixed ??
      (route.startsWith("/account") || route.startsWith("/s/") || route.startsWith("/app")
        ? initialWebsiteLocale(route, location.search, languages)
        : "en"),
  );
}
const render = () =>
  root &&
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
// The prerendered page stays on screen until its words (and, on the catalog,
// its chunk) are here, then the first render already has them: no English
// frame, no empty frame in between.
if (!redirectTo) {
  const words = loadWebsiteMessages(websiteLocale());
  if (modelsPath(page.split("?")[0]))
    Promise.all([loadModelCatalog(), words])
      .then(([catalog]) => catalog.prepareCatalogPath(page.split("?")[0], location.search.slice(1)))
      .then(render, render);
  else words.then(render, render);
}
