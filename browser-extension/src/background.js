/**
 * The service worker (an event page in Firefox): the selection menu, and
 * nothing else. It reads no page and talks to no app; the panel does both,
 * on the person's click.
 */

const ext = globalThis.browser ?? globalThis.chrome;
const MENU_ID = "subrosa-ask-selection";

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.create({
    id: MENU_ID,
    title: ext.i18n.getMessage("menuAskSelection"),
    contexts: ["selection"],
  });
});

/** The panel may only be opened inside the click's own gesture. */
function openPanel(tab) {
  if (ext.sidePanel?.open) return ext.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
  if (ext.sidebarAction?.open) return ext.sidebarAction.open().catch(() => undefined);
  return Promise.resolve();
}

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab) return;
  openPanel(tab);
  // The panel picks this up when it opens, or at once when it is open.
  ext.storage.session.set({
    pendingSelection: {
      text: String(info.selectionText ?? "").slice(0, 20_000),
      url: tab.url ?? "",
      title: tab.title ?? "",
      at: Date.now(),
    },
  });
});
