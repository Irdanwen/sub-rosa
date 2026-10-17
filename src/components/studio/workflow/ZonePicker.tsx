// The zone a retouch changes: a rectangle drawn over the picture it is given
// (dragged with the pointer), or typed as percentages. Stored as fractions
// of the picture, so it means the same part whatever the size.

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { zoneOf } from "../../../lib/studio/workflow/zone-param";

type Zone = ReturnType<typeof zoneOf>;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function ZonePicker({
  value,
  source,
  label,
  onChange,
}: {
  value: unknown;
  /** The picture the zone is on, once one reaches the step. */
  source?: string;
  label: string;
  onChange: (zone: Zone) => void;
}) {
  const zone = zoneOf(value);
  const frame = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Zone>();
  const latest = useRef(onChange);
  latest.current = onChange;

  // Pointer handling on the frame: press, drag, release draws a rectangle.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let start: { x: number; y: number } | undefined;
    let current: Zone | undefined;
    const point = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      return {
        x: clamp((event.clientX - box.left) / Math.max(1, box.width)),
        y: clamp((event.clientY - box.top) / Math.max(1, box.height)),
      };
    };
    const down = (event: PointerEvent) => {
      element.setPointerCapture?.(event.pointerId);
      start = point(event);
      current = undefined;
    };
    const move = (event: PointerEvent) => {
      if (!start) return;
      const here = point(event);
      current = {
        x: Math.min(start.x, here.x),
        y: Math.min(start.y, here.y),
        width: Math.abs(here.x - start.x),
        height: Math.abs(here.y - start.y),
      };
      setDraft(current);
    };
    const up = () => {
      // A click with no drag leaves the zone as it was.
      if (current && current.width > 0.02 && current.height > 0.02) latest.current(current);
      start = undefined;
      current = undefined;
      setDraft(undefined);
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
  }, []);

  const shown = draft ?? zone;
  const style = {
    "--zone-x": `${shown.x * 100}%`,
    "--zone-y": `${shown.y * 100}%`,
    "--zone-w": `${shown.width * 100}%`,
    "--zone-h": `${shown.height * 100}%`,
  } as CSSProperties;
  const percent = (key: keyof Zone, name: string) => (
    <label className="studio-zone-number">
      <span>{name}</span>
      <input
        type="number"
        className="studio-input nodrag"
        min={0}
        max={100}
        value={Math.round(zone[key] * 100)}
        onChange={(event) => onChange(zoneOf({ ...zone, [key]: Number(event.target.value) / 100 }))}
      />
    </label>
  );
  return (
    <fieldset className="studio-zone">
      <legend>{label}</legend>
      <div ref={frame} className="studio-zone-frame nodrag" style={style}>
        {source ? (
          <img src={source} alt="" draggable={false} />
        ) : (
          <p className="studio-node-port-label">
            {t("Drag on the picture once it arrives, or set the zone below.")}
          </p>
        )}
        <span className="studio-zone-rect" aria-hidden />
      </div>
      <div className="studio-zone-numbers">
        {percent("x", t("From the left"))}
        {percent("y", t("From the top"))}
        {percent("width", t("Width"))}
        {percent("height", t("Height"))}
      </div>
    </fieldset>
  );
}
