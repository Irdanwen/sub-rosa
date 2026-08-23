import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  discardIngest,
  INGEST_EVENT,
  type IngestDto,
  listActiveIngests,
  type LinkPreview,
  previewIngestLink,
  startLinkIngest,
} from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";

/**
 * Paste a link, get a note (ADR-0028).
 *
 * The bar says what a link is *before* fetching it, because the three kinds
 * behave very differently: a direct file and a podcast feed just work, and a
 * platform page needs an extractor this app deliberately does not ship. Saying
 * so while the user is still looking at the field beats a download that fails
 * a minute later.
 *
 * Downloads are rows, not promises, so this component can be unmounted, the
 * window closed and the app killed without losing one.
 */
/** Long enough that a pasted link classifies instantly and a typed one does
 * not classify once per character. */
const PREVIEW_DEBOUNCE_MS = 180;

export function ImportLinkBar({
  folderId,
  onCompleted,
}: {
  folderId?: string;
  /** A fetch produced a note. The shell has to be told: the note was created
   * by a background task, and the notes list only reloads on an explicit
   * action, so without this the download finishes and nothing appears. */
  onCompleted?: (noteId: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [ingests, setIngests] = useState<IngestDto[]>([]);
  const previewToken = useRef(0);
  // Held in a ref so the listener can be mounted once: re-subscribing on every
  // render would drop events in the gap.
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;

  useEffect(() => {
    void listActiveIngests()
      .then(setIngests)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<IngestDto>(INGEST_EVENT, (event) => {
      setIngests((current) => {
        const rest = current.filter((ingest) => ingest.id !== event.payload.id);
        // A finished ingest leaves the bar: its note is the thing to look at.
        return event.payload.status === "done" ? rest : [event.payload, ...rest];
      });
      if (event.payload.status === "done" && event.payload.noteId) {
        completedRef.current?.(event.payload.noteId);
      }
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Classification never touches the network, but it does cross the IPC
  // boundary and read the extractor setting, so it is not free per keystroke.
  // Debounced, and every answer carries a token so a slow reply for an old
  // string can never overwrite the current one.
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      previewToken.current += 1;
      setPreview(null);
      setError(null);
      return;
    }
    const token = ++previewToken.current;
    const timer = window.setTimeout(() => {
      void previewIngestLink(trimmed)
        .then((next) => {
          if (token !== previewToken.current) return;
          setPreview(next);
          setError(null);
        })
        .catch((err) => {
          if (token !== previewToken.current) return;
          setPreview(null);
          setError(messageFromError(err));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [url]);

  const submit = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    try {
      const ingest = await startLinkIngest(trimmed, folderId);
      setIngests((current) => [ingest, ...current.filter((row) => row.id !== ingest.id)]);
      setUrl("");
      setPreview(null);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setStarting(false);
    }
  }, [folderId, starting, url]);

  const blocked = Boolean(preview && !preview.fetchable);

  return (
    <div className="import-link">
      <form
        className="import-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="import-link-field">
          <IconChainLink1 size={14} />
          <input
            type="url"
            inputMode="url"
            placeholder="Paste a podcast or media link"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
          />
        </label>
        <button
          type="submit"
          className="primary-action"
          disabled={!url.trim() || starting || blocked}
        >
          Fetch
        </button>
      </form>

      {preview?.fetchable ? (
        <p className="import-link-hint">
          {preview.kind === "feed"
            ? `A podcast feed on ${preview.host}. The newest episode will be fetched.`
            : preview.kind === "platformPage"
              ? `A page on ${preview.host}. yt-dlp will be asked for the audio, and its captions when it has them.`
              : `A media file on ${preview.host}.`}{" "}
          The download goes straight from this machine to {preview.host}.
        </p>
      ) : null}

      {blocked && preview?.reason ? (
        <p className="import-link-hint import-link-blocked">{preview.reason}</p>
      ) : null}

      {error ? (
        <p className="import-link-hint import-link-blocked" role="alert">
          {error}
        </p>
      ) : null}

      {ingests.map((ingest) => (
        <IngestRow
          key={ingest.id}
          ingest={ingest}
          onDiscard={() => void discardIngest(ingest.id)}
        />
      ))}
    </div>
  );
}

function IngestRow({ ingest, onDiscard }: { ingest: IngestDto; onDiscard: () => void }) {
  const label = ingest.title?.trim() || ingest.url;
  const failed = ingest.status === "failed";
  return (
    <div className="import-link-row" data-failed={failed ? "true" : undefined}>
      {failed ? null : <DotSpinner className="import-link-spinner" />}
      <span className="import-link-label" title={ingest.url}>
        {label}
      </span>
      <span className="import-link-status">
        {failed ? ingest.lastError : describeProgress(ingest)}
      </span>
      <button
        type="button"
        className="import-link-dismiss"
        aria-label={failed ? "Dismiss" : "Stop fetching"}
        onClick={onDiscard}
      >
        <IconCrossMedium size={13} />
      </button>
    </div>
  );
}

function describeProgress(ingest: IngestDto): string {
  if (ingest.status === "pending") return "Resolving";
  if (!ingest.bytesTotal) return formatBytes(ingest.bytesDone);
  const percent = Math.min(Math.round((ingest.bytesDone / ingest.bytesTotal) * 100), 100);
  return `${percent}% of ${formatBytes(ingest.bytesTotal)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(Math.round(bytes / 1024), 1)} kB`;
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}
