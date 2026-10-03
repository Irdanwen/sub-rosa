import { intlLocale, t } from "../../../../lib/i18n";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useState } from "react";
import { usePlayableMediaUrl, useArtifactThumbnail } from "../../../../lib/artifact-media";
import type { ArtifactKind, StudioArtifact } from "../../../../lib/studio/types";
import { Spinner } from "../../../ui/Spinner";
import { formatNoteTime } from "../NoteRow";
import { markMediaPlayback } from "./StudioControls";

/** What each gallery bucket is called, in the one place both the picker and
 * the tiles read it from. */
function _kindLabel(kind: ArtifactKind): string {
  const labels: Record<ArtifactKind, string> = {
    image: t("Images"),
    video: t("Videos"),
    music: t("Music"),
    speech: t("Speech"),
    sfx: t("Effects"),
  };
  return labels[kind];
}

/** "Today", "Yesterday", then a written date. */
export function dayLabel(createdAt: number): string {
  const date = new Date(createdAt);
  const today = new Date();
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (days <= 0) return t("Today");
  if (days === 1) return t("Yesterday");
  return date.toLocaleDateString(intlLocale(), {
    weekday: days < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/**
 * The last few things made in this tab, under its form.
 *
 * The tab used to end with the whole gallery (search, select, delete, every
 * tile), a second Gallery tab under the first. Under a form, what helps is what
 * you just made; the rest is one tap away in Gallery.
 */
export function RecentStrip({
  items,
  kind,
  onOpen,
  onSeeAll,
  pending = [],
}: {
  items: StudioArtifact[];
  kind: ArtifactKind;
  onOpen: (artifact: StudioArtifact) => void;
  onSeeAll: () => void;
  /** Renders not here yet, shown first in the place they will take. Never
   * artifacts: nothing is written to the gallery before it exists. */
  pending?: { key: string }[];
}) {
  if (items.length === 0 && pending.length === 0) return null;
  const isAudioKind = kind === "music" || kind === "speech" || kind === "sfx";
  const recent = items.slice(0, isAudioKind ? 3 : 12);
  return (
    <section className="mobile-studio-recent" aria-label={t("Recent")}>
      <div className="mobile-studio-recent-head">
        <h2 className="mobile-studio-recent-title">{t("Recent")}</h2>
        <button type="button" className="mobile-chip-button" onClick={onSeeAll}>
          {t("See all")}
        </button>
      </div>
      {isAudioKind ? (
        <ul className="mobile-note-list" aria-label={t("Generated audio")}>
          {pending.map((entry) => (
            <li key={entry.key} className="mobile-music-row mobile-music-row-pending stage-pending">
              <span className="mobile-studio-pending-label">{t("Rendering")}</span>
            </li>
          ))}
          {recent.map((artifact) => (
            <MusicRow
              key={artifact.path}
              artifact={artifact}
              selecting={false}
              selected={false}
              onToggle={() => undefined}
            />
          ))}
        </ul>
      ) : (
        <div className="mobile-studio-recent-strip">
          {pending.map((entry) => (
            <span
              key={entry.key}
              className="mobile-studio-cell mobile-studio-cell-pending stage-pending"
            >
              <span className="mobile-studio-pending-label">{t("Rendering")}</span>
            </span>
          ))}
          {recent.map((artifact) => (
            <GalleryCell key={artifact.path} artifact={artifact} onOpen={() => onOpen(artifact)} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A library tile: the picture, plus what made it.
 *
 * The per-kind strips are three columns of bare thumbnails, which is right for
 * glancing at what you just generated. The library is where you go to *find*
 * something, so it trades a column for a caption: without one, a grid of
 * images carries no prompt, no model, and no way to tell a video from a still.
 */
export function LibraryCell({
  artifact,
  onOpen,
  selecting = false,
  selected = false,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
}) {
  const thumbnail = useArtifactThumbnail(artifact);
  // Only a clip that failed to decode reaches a media element, and that is the
  // one case where its own metadata is the only place a length can come from.
  const [measured, setMeasured] = useState<number | null>(null);
  const isVideo = artifact.kind === "video";
  const seconds = thumbnail?.durationSeconds ?? measured;
  const duration = seconds && seconds > 0 ? formatClipLength(seconds) : "";

  return (
    <div className="mobile-library-item">
      <button
        type="button"
        className="mobile-studio-cell"
        data-selected={selected ? "true" : undefined}
        onClick={onOpen}
      >
        {thumbnail ? (
          thumbnail.kind === "media" ? (
            // A clip whose poster could not be read. `#t=0.1` asks WKWebView to
            // paint the first frame; it often refuses, and the tile then shows
            // its own background rather than nothing at all.
            <video
              src={`${thumbnail.src}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const length = event.currentTarget.duration;
                if (Number.isFinite(length) && length > 0) setMeasured(length);
              }}
            />
          ) : (
            <img src={thumbnail.src} alt={artifact.prompt || t("Generated image")} />
          )
        ) : (
          <span className="mobile-studio-cell-loading" aria-hidden />
        )}
        {isVideo ? (
          <span className="mobile-library-badge" aria-hidden>
            <IconPlay size={11} />
            {duration}
          </span>
        ) : null}
        {selecting ? (
          <span
            className="mobile-studio-cell-check"
            data-on={selected ? "true" : undefined}
            aria-hidden
          >
            {selected ? <IconCheckmark1Small size={14} /> : null}
          </span>
        ) : null}
      </button>
      <span className="mobile-library-caption">
        <span className="mobile-library-prompt">
          {artifact.prompt?.trim() || t("No prompt recorded")}
        </span>
        <span className="mobile-library-meta">
          {[artifact.model, formatNoteTime(new Date(artifact.createdAt).toISOString())]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </div>
  );
}

/** "0:42", "3:07" — the way a player writes it. */
export function formatClipLength(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole % 60).toString().padStart(2, "0")}`;
}

export function GalleryCell({
  artifact,
  onOpen,
  selecting = false,
  selected = false,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
}) {
  const thumbnail = useArtifactThumbnail(artifact);
  return (
    <button
      type="button"
      className="mobile-studio-cell"
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
    >
      {thumbnail ? (
        thumbnail.kind === "media" ? (
          // Only a clip that decoded no picture lands here; see `LibraryCell`.
          <video src={`${thumbnail.src}#t=0.1`} muted playsInline preload="metadata" />
        ) : (
          <img src={thumbnail.src} alt={artifact.prompt ?? t("Generated image")} />
        )
      ) : (
        <span className="mobile-studio-cell-loading" aria-hidden />
      )}
      {selecting ? (
        <span
          className="mobile-studio-cell-check"
          data-on={selected ? "true" : undefined}
          aria-hidden
        >
          {selected ? <IconCheckmark1Small size={14} /> : null}
        </span>
      ) : null}
    </button>
  );
}

export function MusicRow({
  artifact,
  selecting,
  selected,
  onToggle,
}: {
  artifact: StudioArtifact;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { src, onError } = usePlayableMediaUrl(artifact);
  return (
    <li className="mobile-music-row" data-selected={selected ? "true" : undefined}>
      {selecting ? (
        <button
          type="button"
          className="mobile-studio-row-check"
          data-on={selected ? "true" : undefined}
          onClick={onToggle}
          aria-label={selected ? t("Deselect track") : t("Select track")}
        >
          {selected ? <IconCheckmark1Small size={14} /> : null}
        </button>
      ) : null}
      <span className="mobile-note-row-title">{artifact.prompt?.slice(0, 60) || t("Track")}</span>
      {src ? (
        <audio
          src={src}
          controls
          preload="metadata"
          onError={onError}
          onPlay={() => markMediaPlayback(true)}
          onPause={() => markMediaPlayback(false)}
          onEnded={() => markMediaPlayback(false)}
        />
      ) : (
        <Spinner />
      )}
    </li>
  );
}
