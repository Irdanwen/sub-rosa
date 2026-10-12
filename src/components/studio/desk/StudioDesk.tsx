// The desk: how a Studio generation surface is laid out on the desktop
// (ADR-0110). The scene in the middle, where the eye waits for the result;
// the dock centred under it, with the one button that spends; the settings
// that do not matter on every render in an inspector at the right that can
// be folded away; and the filmstrip of what was made here under it all.

import { IconSidebarSimpleRightWide } from "central-icons/IconSidebarSimpleRightWide";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t } from "../../../lib/i18n";
import "./desk.css";

const INSPECTOR_STORAGE_KEY = "subrosa:studio:inspector-open";

function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Whether the inspector is shown, remembered across tabs and launches, and
 * toggled with ⌥⌘I. */
export function useInspectorOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(readInspectorOpen);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(INSPECTOR_STORAGE_KEY, String(next));
      } catch {
        // A remembered panel is a nicety, not state.
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "KeyI" || !event.altKey || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
  return [open, toggle];
}

export function StudioDesk({
  tools,
  scene,
  dock,
  notice,
  strip,
  inspector,
}: {
  /** The tool switch above the scene (Create, Retouch, Upscale...). */
  tools?: ReactNode;
  scene: ReactNode;
  dock: ReactNode;
  /** A failure or a note, between the scene and the dock. */
  notice?: ReactNode;
  /** The filmstrip under the dock. */
  strip?: ReactNode;
  /** Every other setting. Omit it for a tool that has none. */
  inspector?: ReactNode;
}) {
  const [inspectorOpen, toggleInspector] = useInspectorOpen();
  const showInspector = Boolean(inspector) && inspectorOpen;
  return (
    <div className="studio-desk" data-inspector={showInspector ? "open" : "closed"}>
      <div className="studio-desk-main">
        <div className="studio-desk-toolbar">
          <div className="studio-desk-tools">{tools}</div>
          {inspector ? (
            <button
              type="button"
              className="stage-icon studio-desk-inspector-toggle"
              aria-pressed={showInspector}
              aria-label={showInspector ? t("Hide settings") : t("Show settings")}
              title={`${showInspector ? t("Hide settings") : t("Show settings")} (⌥⌘I)`}
              onClick={toggleInspector}
            >
              <IconSidebarSimpleRightWide size={18} aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="studio-desk-scene">{scene}</div>
        <div className="studio-desk-dock">
          {notice}
          {dock}
        </div>
        {strip ? <div className="studio-desk-strip">{strip}</div> : null}
      </div>
      {showInspector ? (
        <aside className="studio-inspector stage-tokens" aria-label={t("Settings")}>
          <h2 className="studio-inspector-title">{t("Settings")}</h2>
          <div className="studio-inspector-fields">{inspector}</div>
        </aside>
      ) : null}
    </div>
  );
}

/** The tool switch above the scene: a quiet segmented row on the stage. */
export function DeskTools<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="studio-desk-segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className="studio-desk-segment"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
