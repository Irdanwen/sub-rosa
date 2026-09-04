import { intlLocale, t } from "../../../../lib/i18n";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconAudio } from "central-icons/IconAudio";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { useCallback, useMemo, useState } from "react";
import {
  evictArtifactDataUrl,
  useArtifactDataUrl,
  useArtifactThumbnail,
} from "../../../../lib/artifact-media";
import { hapticNotify, hapticSelection } from "../../../../lib/haptics";
import { deleteArtifact } from "../../../../lib/studio/artifacts";
import type { ArtifactKind, StudioArtifact } from "../../../../lib/studio/types";
import { EmptyState } from "../../../ui/EmptyState";
import { Spinner } from "../../../ui/Spinner";
import { formatNoteTime } from "../NoteRow";
import { markMediaPlayback } from "./StudioControls";

/** What each gallery bucket is called, in the one place both the picker and
 * the tiles read it from. */
export const KIND_LABELS: Record<ArtifactKind, string> = {
  image: "Images",
  video: "Videos",
  music: "Music",
  speech: "Speech",
  sfx: "Effects",
};

/**
 * The gallery: what the studio has already made.
 *
 * Everything here reads artifacts and shows them -- grid cells, day headings,
 * a row per track, and the tiles the audio tab lists. None of it generates
 * anything, which is why it separates cleanly from the panels that do.
 *
 * Moved out of StudioScreen unchanged; `mobile-studio-smoke.test.tsx` mounts
 * the Library tab so the move is checked rather than asserted.
 */
/**
 * Everything ever generated, in one place.
 *
 * The per-kind galleries hang under their own generate form, so answering
 * "what have I made?" meant visiting four tabs and scrolling past four forms.
 * This is the library that question deserves: every kind together, newest
 * first, grouped by day, filterable by kind and searchable by prompt.
 */
export function Library({
  items,
  onOpen,
  onChanged,
}: {
  items: StudioArtifact[];
  onOpen: (artifact: StudioArtifact) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArtifactKind | "all">("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // A library you cannot prune is an archive. Deleting frees real disk on the
  // phone, so it belongs here and not only under each kind's own tab.
  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    for (const artifact of items.filter((entry) => selected.has(entry.path))) {
      try {
        await deleteArtifact(artifact);
        evictArtifactDataUrl(artifact.path);
      } catch {
        // Leave failures in place; the next listing reconciles with disk.
      }
    }
    setDeleting(false);
    hapticNotify("success");
    exitSelection();
    onChanged();
  }, [items, selected, exitSelection, onChanged]);

  // Only offer filters for kinds actually present: a chip row of empty
  // categories is noise on a phone.
  const kinds = useMemo(() => {
    const present = new Set(items.map((artifact) => artifact.kind));
    return (["image", "video", "music", "speech", "sfx"] as const).filter((kind) =>
      present.has(kind),
    );
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((artifact) => {
      if (filter !== "all" && artifact.kind !== filter) return false;
      if (!q) return true;
      return (
        (artifact.prompt ?? "").toLowerCase().includes(q) ||
        (artifact.model ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, filter, query]);

  // Day buckets, in order. A flat wall of two hundred tiles gives the eye
  // nothing to hold on to.
  const groups = useMemo(() => {
    const buckets = new Map<string, StudioArtifact[]>();
    for (const artifact of filtered) {
      const label = dayLabel(artifact.createdAt);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(artifact);
      else buckets.set(label, [artifact]);
    }
    return [...buckets.entries()];
  }, [filtered]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<IconCameraSparkle size={28} />}
        title={t("Nothing generated yet")}
        description={t("Images, videos and audio you make in Studio collect here, on this device.")}
      />
    );
  }

  return (
    <div className="mobile-studio-gallery">
      <div className="mobile-studio-gallery-bar">
        <input
          className="mobile-studio-search"
          type="search"
          value={query}
          placeholder={t("Search everything")}
          aria-label={t("Search the library")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        >
          {selecting ? "Done" : "Select"}
        </button>
      </div>
      {kinds.length > 1 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label={t("Filter by kind")}>
          {(["all", ...kinds] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={filter === entry}
              className="mobile-pill"
              data-active={filter === entry ? "true" : undefined}
              onClick={() => {
                hapticSelection();
                setFilter(entry);
              }}
            >
              {entry === "all" ? "All" : KIND_LABELS[entry]}
            </button>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <p className="mobile-studio-empty-hint">{t("Nothing matches that search.")}</p>
      ) : (
        groups.map(([label, group]) => (
          <section key={label} className="mobile-library-day">
            <h3 className="mobile-library-day-title">{label}</h3>
            <div className="mobile-studio-grid mobile-library-grid">
              {group.map((artifact) =>
                artifact.kind === "image" || artifact.kind === "video" ? (
                  <LibraryCell
                    key={artifact.path}
                    artifact={artifact}
                    selecting={selecting}
                    selected={selected.has(artifact.path)}
                    onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
                  />
                ) : (
                  <AudioTile
                    key={artifact.path}
                    artifact={artifact}
                    selected={selecting && selected.has(artifact.path)}
                    onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
                  />
                ),
              )}
            </div>
          </section>
        ))
      )}
      <p className="mobile-studio-empty-hint">
        {items.length === 1
          ? t("1 item on this device.")
          : t("{count} items on this device.", { count: items.length })}
      </p>
      {selecting ? (
        <div className="mobile-studio-select-bar">
          <span>{t("{size} selected", { size: selected.size })}</span>
          <button
            type="button"
            className="mobile-studio-delete-selected"
            disabled={selected.size === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <Spinner /> : `Delete${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Audio has no thumbnail, so its tile is a label rather than a black square. */
export function AudioTile({
  artifact,
  onOpen,
  selected,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      className="mobile-studio-cell mobile-studio-cell-audio"
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
    >
      <IconAudio size={20} aria-hidden />
      <span>{artifact.prompt?.slice(0, 48) || KIND_LABELS[artifact.kind]}</span>
    </button>
  );
}

/** "Today", "Yesterday", then a written date. */
export function dayLabel(createdAt: number): string {
  const date = new Date(createdAt);
  const today = new Date();
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(intlLocale(), {
    weekday: days < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

export function Gallery({
  items,
  kind,
  onOpen,
  onChanged,
}: {
  items: StudioArtifact[];
  kind: ArtifactKind;
  onOpen: (artifact: StudioArtifact) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (artifact) =>
        (artifact.prompt ?? "").toLowerCase().includes(q) ||
        (artifact.model ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    const targets = items.filter((artifact) => selected.has(artifact.path));
    for (const artifact of targets) {
      try {
        await deleteArtifact(artifact);
        evictArtifactDataUrl(artifact.path);
      } catch {
        // Leave failures in place; the next refresh reconciles with disk.
      }
    }
    setDeleting(false);
    hapticNotify("success");
    exitSelection();
    onChanged();
  }, [items, selected, exitSelection, onChanged]);

  const isAudioKind = kind === "music" || kind === "speech" || kind === "sfx";

  if (items.length === 0) {
    return (
      <EmptyState
        icon={
          kind === "music" || kind === "speech" || kind === "sfx" ? (
            <IconAudio size={28} />
          ) : (
            <IconCameraSparkle size={28} />
          )
        }
        title={
          kind === "image"
            ? "No images yet"
            : kind === "video"
              ? "No videos yet"
              : kind === "speech"
                ? "No narrations yet"
                : kind === "sfx"
                  ? "No sound effects yet"
                  : "No tracks yet"
        }
        description={t("Everything you generate stays on this device.")}
      />
    );
  }

  return (
    <div className="mobile-studio-gallery">
      <div className="mobile-studio-gallery-bar">
        <input
          className="mobile-studio-search"
          type="search"
          value={query}
          placeholder={
            isAudioKind ? "Search audio" : kind === "video" ? "Search videos" : "Search images"
          }
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        >
          {selecting ? "Done" : "Select"}
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="mobile-studio-empty-hint">
          {t("No results for “{query}”.", { query: query.trim() })}
        </p>
      ) : isAudioKind ? (
        <ul className="mobile-note-list" aria-label={t("Generated audio")}>
          {filtered.map((artifact) => (
            <MusicRow
              key={artifact.path}
              artifact={artifact}
              selecting={selecting}
              selected={selected.has(artifact.path)}
              onToggle={() => toggle(artifact.path)}
            />
          ))}
        </ul>
      ) : (
        <div className="mobile-studio-grid">
          {filtered.map((artifact) => (
            <GalleryCell
              key={artifact.path}
              artifact={artifact}
              selecting={selecting}
              selected={selected.has(artifact.path)}
              onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
            />
          ))}
        </div>
      )}
      {selecting ? (
        <div className="mobile-studio-select-bar">
          <span>{t("{size} selected", { size: selected.size })}</span>
          <button
            type="button"
            className="mobile-studio-delete-selected"
            disabled={selected.size === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <Spinner /> : `Delete${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      ) : null}
    </div>
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
            <img src={thumbnail.src} alt={artifact.prompt || "Generated image"} />
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
          {artifact.prompt?.trim() || "No prompt recorded"}
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
          <img src={thumbnail.src} alt={artifact.prompt ?? "Generated image"} />
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
  const src = useArtifactDataUrl(artifact);
  return (
    <li className="mobile-music-row" data-selected={selected ? "true" : undefined}>
      {selecting ? (
        <button
          type="button"
          className="mobile-studio-row-check"
          data-on={selected ? "true" : undefined}
          onClick={onToggle}
          aria-label={selected ? "Deselect track" : "Select track"}
        >
          {selected ? <IconCheckmark1Small size={14} /> : null}
        </button>
      ) : null}
      <span className="mobile-note-row-title">{artifact.prompt?.slice(0, 60) || "Track"}</span>
      {src ? (
        <audio
          src={src}
          controls
          preload="metadata"
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
