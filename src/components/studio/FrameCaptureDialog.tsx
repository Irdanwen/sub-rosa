// Frame capture: pull a still out of a generated clip and keep it as a real
// gallery image, instead of as a data URL living in one form's state.
//
// Persisting it as an artifact is the whole design. Once the still is in the
// gallery, everything it needs already exists and nothing had to be built for
// it: "Save a copy" exports it to disk, "Send to edit" reworks it, the gallery
// picker offers it as a reference to any other surface. A bespoke "export this
// frame" button would have delivered one of those three and had to grow the
// other two later.
//
// Two encodings, deliberately. Scrubbing previews at `payload` quality (a
// downscaled JPEG) because a drag fires one decode per tick and full-size PNGs
// would stall it; the save re-reads the chosen position at `capture` quality
// (native resolution, PNG, no ceiling), because that file is going to disk and
// possibly into another editor.

import { t } from "../../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { artifactSrc, saveArtifactFromBase64 } from "../../lib/studio/artifacts";
import { extractFrameAt, extractHandoffFrame, lastReadableTime } from "../../lib/studio/frames";
import type { StudioArtifact } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import { formatSeconds } from "./controls";

/** A drag fires a stream of values and each one costs a seek plus a readback.
 * Matches the video studio's handoff slider, which has the same problem. */
const SCRUB_DEBOUNCE_MS = 220;

/** Slider granularity. Finer than a frame is pointless: the extraction lands
 * on whatever the decoder gives it anyway. */
const SCRUB_STEP_SECONDS = 0.05;

interface Preview {
  dataUrl: string;
  timeSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
}

export function FrameCaptureDialog({
  artifact,
  onClose,
  onCaptured,
}: {
  /** The clip to read from. */
  artifact: StudioArtifact;
  onClose: () => void;
  /** The still that was saved, so the caller can refresh its gallery. */
  onCaptured?: (still: StudioArtifact) => void;
}) {
  const src = artifactSrc(artifact);
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  // What the slider is asking for, which runs ahead of the extracted preview.
  const [time, setTime] = useState(0);
  // Where the automatic pick landed. Tracked apart from the preview: after a
  // scrub the preview sits wherever the user dragged it, so comparing against
  // it would call every settled position "the default" and grey out the reset.
  const [defaultTime, setDefaultTime] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Suppresses the scrub effect for the position the opening read just landed
  // on, so opening the dialog does not immediately re-extract the same frame.
  const settledTime = useRef<number | undefined>(undefined);

  /** The sharpest frame near the end: the same pick "Continue this shot"
   * makes, and the right default for "I want the last frame of this". */
  const readDefault = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const frame = await extractHandoffFrame(src);
      settledTime.current = frame.timeSeconds;
      setPreview({
        dataUrl: frame.dataUrl,
        timeSeconds: frame.timeSeconds,
        durationSeconds: frame.durationSeconds,
        width: frame.width,
        height: frame.height,
      });
      setTime(frame.timeSeconds);
      setDefaultTime(frame.timeSeconds);
    } catch {
      setError(t("Couldn't read a frame from that clip."));
    } finally {
      setLoading(false);
    }
  }, [src]);

  useEffect(() => {
    void readDefault();
  }, [readDefault]);

  // Scrubbing re-reads at the requested position, debounced.
  useEffect(() => {
    if (!preview || settledTime.current === time) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      extractFrameAt(src, time)
        .then((frame) => {
          if (cancelled) return;
          settledTime.current = frame.timeSeconds;
          setPreview({
            dataUrl: frame.dataUrl,
            timeSeconds: frame.timeSeconds,
            durationSeconds: frame.durationSeconds,
            width: frame.width,
            height: frame.height,
          });
          setError(undefined);
        })
        .catch(() => {
          if (!cancelled) setError(t("Couldn't read that frame."));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, SCRUB_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `preview` is read only to know whether the clip loaded at all; making it
    // a dependency would re-run this on every extraction it performs.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  }, [src, time]);

  const onSave = useCallback(async () => {
    if (!preview) return;
    setSaving(true);
    setError(undefined);
    try {
      // Re-read rather than save the preview: what is on screen is the
      // downscaled JPEG the scrubber can afford, not the file the user wants.
      const full = await extractFrameAt(src, preview.timeSeconds, { encoding: "capture" });
      const still = await saveArtifactFromBase64(full.dataUrl.replace(/^data:[^,]*,/, ""), "png", {
        kind: "image",
        // Nothing generated this image, and naming the clip's model here would
        // claim it did. The gallery already falls back to the file name.
        model: "",
        prompt: `Frame at ${formatSeconds(full.timeSeconds)} of ${artifact.prompt || artifact.fileName}`,
        sourceArtifactId: artifact.id,
        sourceTimeSeconds: full.timeSeconds,
      });
      onCaptured?.(still);
      onClose();
    } catch {
      setError(t("Couldn't save that frame to the gallery."));
    } finally {
      setSaving(false);
    }
  }, [src, preview, artifact, onCaptured, onClose]);

  const duration = preview?.durationSeconds ?? 0;
  const maxTime = lastReadableTime(duration);
  const atDefault = defaultTime !== undefined && Math.abs(time - defaultTime) < 0.01;
  const atLastFrame = duration > 0 && Math.abs(time - maxTime) < 0.01;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Capture a frame")}
      description={t(
        "The still is saved to the gallery, where you can export it, edit it, or use it as a reference.",
      )}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!preview || saving}
            onClick={() => void onSave()}
          >
            {saving ? t("Saving") : t("Save to the gallery")}
          </button>
        </>
      }
    >
      <div className="dialog-body studio-capture">
        <div className="studio-capture-preview">
          {preview ? (
            <img
              src={preview.dataUrl}
              alt={t("Frame at {time}", { time: formatSeconds(preview.timeSeconds) })}
            />
          ) : null}
          {loading ? (
            <span className="studio-capture-busy">
              <Spinner aria-label={t("Reading the frame")} />
            </span>
          ) : null}
        </div>
        {duration > 0 ? (
          <>
            <input
              type="range"
              className="studio-slider"
              min={0}
              max={maxTime}
              step={SCRUB_STEP_SECONDS}
              value={Math.min(time, maxTime)}
              aria-label={t("Position in the clip")}
              onChange={(event) => setTime(Number(event.target.value))}
            />
            <div className="studio-capture-meta">
              <span>
                {/* At the end stop, the tenth-of-a-second rounding makes the
                 * position and the duration print identically ("5s of 5s"),
                 * directly contradicting the note below about stopping short.
                 * Name the position instead of spelling out a false equality. */}
                {atLastFrame
                  ? t("Last frame of {duration}", { duration: formatSeconds(duration) })
                  : t("{time} of {duration}", {
                      time: formatSeconds(preview?.timeSeconds ?? time),
                      duration: formatSeconds(duration),
                    })}
              </span>
              {preview ? (
                <span>
                  {t("{width} x {height}, PNG", { width: preview.width, height: preview.height })}
                </span>
              ) : null}
            </div>
            <div className="studio-capture-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={loading || atDefault}
                onClick={() => void readDefault()}
              >
                {t("Sharpest near the end")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={loading || atLastFrame}
                onClick={() => setTime(maxTime)}
              >
                {t("Last frame")}
              </button>
            </div>
            <p className="studio-field-note">
              {t(
                "The slider stops one frame short of the end: seeking to the very last position reads back black on most decoders.",
              )}
            </p>
          </>
        ) : null}
        {error ? <p className="studio-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
