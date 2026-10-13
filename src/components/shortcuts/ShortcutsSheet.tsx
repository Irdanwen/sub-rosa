import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { isMacLikePlatform } from "../../lib/platform";
import { Dialog } from "../ui/Dialog";

/** Ask for the sheet from anywhere (the command palette, a menu). */
export const OPEN_SHORTCUTS_EVENT = "subrosa:open-shortcuts";

export function requestShortcutsSheet() {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
}

type Key = "mod" | "shift" | "alt" | string;
type Shortcut = { keys: Key[]; label: string };
type Group = { title: string; shortcuts: Shortcut[] };

/**
 * Every shortcut the window answers to, in one place. Recognition beats
 * recall: a shortcut nobody can find is a shortcut nobody uses. The list is
 * written by hand next to the handlers it describes (App.tsx, Sidebar.tsx,
 * StudioDesk.tsx, the composer); the global dictation shortcuts are the
 * person's own and live in Settings, which the footer opens.
 */
export function shortcutGroups(): Group[] {
  return [
    {
      title: t("General"),
      shortcuts: [
        { keys: ["mod", "K"], label: t("Search and commands") },
        { keys: ["mod", "N"], label: t("New chat") },
        { keys: ["mod", "shift", "N"], label: t("New note") },
        { keys: ["mod", ","], label: t("Settings") },
        { keys: ["?"], label: t("Keyboard shortcuts") },
      ],
    },
    {
      title: t("Tabs"),
      shortcuts: [
        { keys: ["mod", "T"], label: t("New tab") },
        { keys: ["mod", "W"], label: t("Close tab") },
        { keys: ["mod", "]"], label: t("Next tab") },
        { keys: ["mod", "["], label: t("Previous tab") },
        { keys: ["mod", "1-9"], label: t("Go to a tab") },
      ],
    },
    {
      title: t("Chat"),
      shortcuts: [
        { keys: ["Enter"], label: t("Send") },
        { keys: ["shift", "Enter"], label: t("New line") },
      ],
    },
    {
      title: t("Studio"),
      shortcuts: [{ keys: ["alt", "mod", "I"], label: t("Show or hide the settings panel") }],
    },
  ];
}

/** Apple's order and glyphs on a Mac (⌥⇧⌘), words elsewhere (Ctrl Shift). */
export function keyCaps(keys: Key[], mac = isMacLikePlatform()): string[] {
  const order = mac ? ["alt", "shift", "mod"] : ["mod", "alt", "shift"];
  const modifiers = order.filter((modifier) => keys.includes(modifier));
  const rest = keys.filter((key) => !["mod", "shift", "alt"].includes(key));
  const glyph: Record<string, string> = mac
    ? { mod: "⌘", shift: "⇧", alt: "⌥", Enter: "↩" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt", Enter: "Enter" };
  return [...modifiers, ...rest].map((key) => glyph[key] ?? key);
}

export function ShortcutsSheet({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens Settings on the shortcuts page, for the ones a person chose. */
  onOpenSettings?: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Keyboard shortcuts")}
      width={560}
      className="shortcuts-sheet"
      footer={
        onOpenSettings ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            {t("Dictation shortcuts are in Settings")}
          </button>
        ) : undefined
      }
    >
      <div className="shortcuts-sheet-groups">
        {shortcutGroups().map((group) => (
          <section key={group.title} className="shortcuts-sheet-group">
            <h3>{group.title}</h3>
            <dl>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className="shortcuts-sheet-row">
                  <dt>{shortcut.label}</dt>
                  <dd>
                    <span className="keycap-frame">
                      {keyCaps(shortcut.keys).map((cap) => (
                        <kbd key={cap} className="keycap">
                          {cap}
                        </kbd>
                      ))}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"),
  );
}

/**
 * Mounts the sheet once for the window: "?" opens it when nothing is being
 * typed and no other dialog is open, and the command palette asks for it
 * through OPEN_SHORTCUTS_EVENT.
 */
export function ShortcutsSheetHost({
  onSettingsTab,
  onOpenSettings,
}: {
  /** Points Settings at its shortcuts page before it opens. */
  onSettingsTab?: (tab: "shortcuts") => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener(OPEN_SHORTCUTS_EVENT, show);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, show);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return (
    <ShortcutsSheet
      open={open}
      onClose={() => setOpen(false)}
      onOpenSettings={
        onOpenSettings
          ? () => {
              onSettingsTab?.("shortcuts");
              onOpenSettings();
            }
          : undefined
      }
    />
  );
}
