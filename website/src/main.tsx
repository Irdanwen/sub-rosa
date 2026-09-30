import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import {
  initialWebsiteLocale,
  rememberWebsiteLocale,
  savedWebsiteLocale,
  setWebsiteLocale,
} from "./lib/i18n";
import { siteHref, sitePaths } from "./lib/paths";

const root = document.getElementById("root");
const route = sitePaths.route(location.pathname) ?? "/not-found";
const requestedLanguage = new URLSearchParams(location.search).get("lang");
if (requestedLanguage === "en" || requestedLanguage === "fr")
  rememberWebsiteLocale(requestedLanguage);
if (route === "/fr" || route.startsWith("/fr/")) rememberWebsiteLocale("fr");
const redirectToFrench =
  route === "/" &&
  (savedWebsiteLocale() === "fr" ||
    (!savedWebsiteLocale() && navigator.language.toLowerCase().startsWith("fr")));
if (redirectToFrench) {
  location.replace(siteHref("/fr/"));
} else {
  setWebsiteLocale(
    route === "/fr" || route.startsWith("/fr/")
      ? "fr"
      : route.startsWith("/account") || route.startsWith("/s/")
        ? initialWebsiteLocale(route, location.search, navigator.language)
        : "en",
  );
}
if (root && !redirectToFrench)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
