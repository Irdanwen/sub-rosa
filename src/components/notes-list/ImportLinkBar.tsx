import { t } from "../../lib/i18n";
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
import {
  type Errand,
  errandCancel,
  errandList,
  errandRequest,
  type ErrandTarget,
  errandTargets,
  onErrands,
} from "../../lib/errands";
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
  showField = true,
}: {
  folderId?: string;
  /** False shows only what is under way (downloads, errands) and nothing at
   * all when that is nothing: the phone keeps the field in its Import sheet
   * and the progress on the list. */
  showField?: boolean;
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
  // The devices that could read a link this one cannot. Loaded once: the
  // answer is empty for most people and the list is not worth a request per
  // keystroke.
  const [targets, setTargets] = useState<ErrandTarget[]>([]);
  const [errands, setErrands] = useState<Errand[]>([]);
  const [sending, setSending] = useState(false);
  const previewToken = useRef(0);
  // Held in a ref so the listener can be mounted once: re-subscribing on every
  // render would drop events in the gap.
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;

  useEffect(() => {
    void listActiveIngests()
      .then(setIngests)
      .catch(() => {});
    void errandTargets().then(setTargets);
    void errandList()
      .then(setErrands)
      .catch(() => {});
    return onErrands(setErrands);
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

  // Hand the link to a device that can read it. The extractor does not move
  // and neither does the link: the errand travels encrypted and the other
  // machine fetches it itself (ADR-0054).
  const send = useCallback(
    async (deviceId: string) => {
      const trimmed = url.trim();
      if (!trimmed || sending) return;
      setSending(true);
      try {
        await errandRequest(trimmed, deviceId, folderId);
        setUrl("");
        setPreview(null);
        setError(null);
      } catch (err) {
        setError(messageFromError(err));
      } finally {
        setSending(false);
      }
    },
    [folderId, sending, url],
  );

  const blocked = Boolean(preview && !preview.fetchable);
  const open = errands.filter((errand) => errand.state !== "done");

  if (!showField && open.length === 0 && ingests.length === 0) return null;

  return (
    <div className="import-link">
      {showField ? (
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
              placeholder={t("Paste a podcast or media link")}
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            className="primary-action"
            disabled={!url.trim() || starting || blocked}
          >
            {t("Fetch")}
          </button>
        </form>
      ) : null}

      {showField && preview?.fetchable ? (
        <p className="import-link-hint">
          {preview.kind === "feed"
            ? t("A podcast feed on {host}. The newest episode will be fetched.", {
                host: preview.host,
              })
            : preview.kind === "platformPage"
              ? t(
                  "A page on {host}. yt-dlp will be asked for the audio, and its captions when it has them.",
                  { host: preview.host },
                )
              : t("A media file on {host}.", { host: preview.host })}{" "}
          {t("The download goes straight from this machine to {host}.", { host: preview.host })}
        </p>
      ) : null}

      {showField && blocked && preview?.reason ? (
        <p className="import-link-hint import-link-blocked">{preview.reason}</p>
      ) : null}

      {showField && blocked && targets.length > 0 ? (
        <div className="import-link-handoff">
          <p className="import-link-hint">
            {t("One of your other devices may be able to read it:")}
          </p>
          <div className="import-link-targets">
            {targets.map((target) => (
              <button
                key={target.id}
                type="button"
                className="primary-action"
                disabled={sending}
                onClick={() => void send(target.id)}
              >
                {t("Send to {device}", { device: target.name })}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {showField && error ? (
        <p className="import-link-hint import-link-blocked" role="alert">
          {error}
        </p>
      ) : null}

      {open.map((errand) => (
        <ErrandRow key={errand.id} errand={errand} onDismiss={() => void errandCancel(errand.id)} />
      ))}

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

/** An errand, from the asking side: who has it, and what came back. */
function ErrandRow({ errand, onDismiss }: { errand: Errand; onDismiss: () => void }) {
  const waiting = errand.state === "requested";
  return (
    <div className="import-link-row" data-failed={waiting ? undefined : "true"}>
      {waiting ? <DotSpinner className="import-link-spinner" /> : null}
      <span className="import-link-label" title={errand.url}>
        {errand.url}
      </span>
      <span className="import-link-status">
        {errand.state === "requested"
          ? t("Waiting for your other device")
          : errand.state === "expired"
            ? t("Not picked up in time")
            : (errand.message ?? t("Declined"))}
      </span>
      <button
        type="button"
        className="import-link-dismiss"
        aria-label={waiting ? t("Withdraw") : t("Dismiss")}
        onClick={onDismiss}
      >
        <IconCrossMedium size={13} />
      </button>
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
        aria-label={failed ? t("Dismiss") : t("Stop fetching")}
        onClick={onDiscard}
      >
        <IconCrossMedium size={13} />
      </button>
    </div>
  );
}

function describeProgress(ingest: IngestDto): string {
  if (ingest.status === "pending") return t("Resolving");
  if (!ingest.bytesTotal) return formatBytes(ingest.bytesDone);
  const percent = Math.min(Math.round((ingest.bytesDone / ingest.bytesTotal) * 100), 100);
  return t("{percent}% of {size}", { percent, size: formatBytes(ingest.bytesTotal) });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(Math.round(bytes / 1024), 1)} kB`;
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.round(megabytes)} MB`;
}
