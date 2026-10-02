// The settings a retouch can take, offered only where the model lists them:
// resolution, quality, and the shape of the result.

import { type ReactNode, useRef } from "react";
import { t } from "../../../lib/i18n";
import { useModalFocus } from "../../../lib/modal-focus";
import type { RetouchSettings as Settings } from "../../../lib/studio/retouch/prefs";
import type { EditCaps } from "../../../lib/studio/retouch/request";
import { PillGroup } from "../controls";

const QUALITY_LABEL: Record<string, () => string> = {
  low: () => t("Fast"),
  medium: () => t("Balanced"),
  high: () => t("Finest"),
};

export function aspectLabel(aspectRatio: string): string {
  return aspectRatio === "auto" ? t("Same shape") : aspectRatio;
}

export function RetouchSettingsPanel({
  caps,
  settings,
  onChange,
  onClose,
  zoneActive,
  lead,
}: {
  /** Shown first: on a phone, the model and the tries live here. */
  lead?: ReactNode;
  caps: EditCaps;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
  zoneActive: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, { onClose });
  const resolution = settings.resolution ?? caps.defaultResolution;
  const quality = settings.quality ?? caps.defaultQuality;
  return (
    <div
      ref={ref}
      className="retouch-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t("Retouch settings")}
      tabIndex={-1}
    >
      {lead}
      {caps.resolutions.length > 0 && resolution ? (
        <section>
          <h3>{t("Resolution")}</h3>
          <PillGroup
            ariaLabel={t("Resolution")}
            value={resolution}
            options={caps.resolutions.map((value) => ({ value }))}
            onChange={(value) => onChange({ resolution: value })}
          />
        </section>
      ) : null}
      {caps.qualities.length > 0 && quality ? (
        <section>
          <h3>{t("Quality")}</h3>
          <PillGroup
            ariaLabel={t("Quality")}
            value={quality}
            options={caps.qualities.map((value) => ({
              value,
              label: QUALITY_LABEL[value]?.() ?? value,
            }))}
            onChange={(value) => onChange({ quality: value })}
          />
        </section>
      ) : null}
      <section>
        <h3>{t("Shape of the result")}</h3>
        {zoneActive ? (
          <p className="retouch-panel-note">
            {t("A zone keeps the picture's shape: only the zone is replaced.")}
          </p>
        ) : (
          <PillGroup
            ariaLabel={t("Shape of the result")}
            value={settings.aspectRatio}
            options={[
              { value: "auto", label: aspectLabel("auto") },
              ...caps.aspectRatios.map((value) => ({ value })),
            ]}
            onChange={(value) => onChange({ aspectRatio: value })}
          />
        )}
      </section>
      <div className="retouch-panel-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {t("Done")}
        </button>
      </div>
    </div>
  );
}
