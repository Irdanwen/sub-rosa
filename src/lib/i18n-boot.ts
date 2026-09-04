/**
 * Imported first by the shell's entry, before any component module: ES
 * modules evaluate in import order, and some components build their copy
 * at module scope (a table of rows with labels, the welcome page's points).
 * Those `t()` calls run when the module loads, so the language has to be
 * decided before that, not in the render that follows.
 */
import { initLocale } from "./i18n";

initLocale();
