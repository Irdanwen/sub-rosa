// Every version of the session, as a strip of frames. The main line runs
// straight; a version retouched twice opens a branch under it.

import { isMobilePlatform } from "../../../lib/mobile";
import { artifactSrc } from "../../../lib/studio/artifacts";
import { useEffect, useState } from "react";
import { artifactDataUrl, useArtifactPreview } from "../../../lib/artifact-media";
import { downscaleDataUrl, imageSize } from "../../../lib/studio/downscale";
import { t } from "../../../lib/i18n";
import { filmstripRows, type RetouchSession } from "../../../lib/studio/retouch/lineage";
import { versionCaption, versionTitle } from "../../../lib/studio/retouch/labels";
import type { PendingStep } from "../../../lib/studio/retouch/useRetouchSession";
import type { StudioArtifact } from "../../../lib/studio/types";

export interface VersionPicture {
  src: string;
  /** The version's own pixel size, when what is shown is a reduced copy. */
  size?: { width: number; height: number };
}

const displayCache = new Map<string, VersionPicture>();
const DISPLAY_CACHE_MAX = 12;

/** The picture to show for a version. The desktop streams the file itself.
 * The iOS webview has no asset protocol and decodes what it is handed, so a
 * phone shows a copy no larger than 2048 px: an upscaled version is 16 MP,
 * which is a decoded bitmap the webview can lose under memory pressure. */
export function useVersionSrc(version: StudioArtifact | undefined): VersionPicture | undefined {
  const mobile = isMobilePlatform();
  const path = version?.path;
  const [picture, setPicture] = useState<VersionPicture | undefined>(() =>
    path ? displayCache.get(path) : undefined,
  );
  useEffect(() => {
    if (!mobile || !version) return;
    const cached = displayCache.get(version.path);
    if (cached) {
      setPicture(cached);
      return;
    }
    let cancelled = false;
    setPicture(undefined);
    void (async () => {
      const full = await artifactDataUrl(version);
      const size = await imageSize(full);
      const src = await downscaleDataUrl(full, { maxEdge: 2048, quality: 0.9 });
      const next = { src, size: size.width ? size : undefined };
      displayCache.set(version.path, next);
      while (displayCache.size > DISPLAY_CACHE_MAX) {
        const oldest = displayCache.keys().next().value;
        if (oldest === undefined) break;
        displayCache.delete(oldest);
      }
      if (!cancelled) setPicture(next);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mobile, version]);
  if (!version) return undefined;
  return mobile ? picture : { src: artifactSrc(version) };
}

export function RetouchFilmstrip({
  session,
  cursorId,
  pending,
  onSelect,
  orientation = "vertical",
}: {
  session: RetouchSession;
  cursorId?: string;
  pending: PendingStep[];
  onSelect: (id: string) => void;
  orientation?: "vertical" | "horizontal";
}) {
  const rows = filmstripRows(session);
  return (
    <nav className="retouch-filmstrip" data-orientation={orientation} aria-label={t("Versions")}>
      <ol>
        {rows.map((row) => (
          <li key={row.version.id} style={{ "--depth": row.depth } as React.CSSProperties}>
            <Frame
              version={row.version}
              active={row.version.id === cursorId}
              branchStart={row.branchStart}
              onSelect={onSelect}
            />
          </li>
        ))}
        {pending.map((step) => (
          <li key={step.key} className="retouch-frame-pending" aria-hidden>
            <span className="retouch-thumb" />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Frame({
  version,
  active,
  branchStart,
  onSelect,
}: {
  version: StudioArtifact;
  active: boolean;
  branchStart: boolean;
  onSelect: (id: string) => void;
}) {
  const preview = useArtifactPreview(version);
  const title = versionTitle(version);
  const caption = versionCaption(version);
  return (
    <button
      type="button"
      className="retouch-thumb"
      data-active={active}
      data-branch={branchStart ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      aria-label={caption ? t("{title}: {caption}", { title, caption }) : title}
      title={caption ? t("{title}: {caption}", { title, caption }) : title}
      onClick={() => onSelect(version.id)}
    >
      {preview ? <img src={preview} alt="" draggable={false} /> : null}
      <span className="retouch-thumb-number">{version.edit?.n ?? 0}</span>
    </button>
  );
}
