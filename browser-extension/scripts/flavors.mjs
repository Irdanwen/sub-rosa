/**
 * One source manifest, one per browser family. Chrome, Edge and Brave read
 * the Chromium shape (a side panel, a service worker); Firefox reads a
 * sidebar and an event page, and identifies the add-on by
 * `browser_specific_settings` instead of a `key`.
 */

/**
 * The Chromium manifest. `forStore` drops the `key`: the stores assign their
 * own id and refuse an upload that carries one.
 */
export function chromiumManifest(base, { forStore = false } = {}) {
  const manifest = structuredClone(base);
  delete manifest.browser_specific_settings;
  if (forStore) delete manifest.key;
  return manifest;
}

export function firefoxManifest(base) {
  const manifest = structuredClone(base);
  delete manifest.key;
  delete manifest.side_panel;
  delete manifest.minimum_chrome_version;
  manifest.permissions = manifest.permissions.filter((permission) => permission !== "sidePanel");
  manifest.background = { scripts: [base.background.service_worker], type: "module" };
  manifest.sidebar_action = {
    default_panel: base.side_panel.default_path,
    default_title: "__MSG_actionTitle__",
    default_icon: base.action.default_icon,
  };
  return manifest;
}

/** The popup is the panel's page on its other surface. */
export function popupHtml(panelHtml) {
  return panelHtml.replace('data-surface="panel"', 'data-surface="popup"');
}
