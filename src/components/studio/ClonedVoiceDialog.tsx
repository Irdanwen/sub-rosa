// Making and forgetting cloned voices (ADR-0077). Shared by the desktop and
// mobile speech panels: a voice is a name, a short sample of one's own voice
// and a consent, made for the one engine that clones.

import { t } from "../../lib/i18n";
import { useId, useState } from "react";
import {
  type ClonedVoice,
  createClonedVoice,
  deleteClonedVoice,
  extensionOf,
} from "../../lib/studio/cloned-voices";
import type { SpeechCapabilities } from "../../lib/studio/speech";
import type { MediaModel } from "../../lib/studio/types";
import { Dialog } from "../ui/Dialog";

export function ClonedVoiceDialog({
  open,
  onClose,
  model,
  cloning,
  voices,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  model: MediaModel;
  cloning: NonNullable<SpeechCapabilities["cloning"]>;
  /** The voices already made for this engine. */
  voices: ClonedVoice[];
  /** A voice was made (its id) or forgotten (undefined). */
  onChanged: (created?: ClonedVoice) => void;
}) {
  const [name, setName] = useState("");
  const [sample, setSample] = useState<File | undefined>(undefined);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameId = useId();
  const fileId = useId();
  const consentId = useId();

  const canCreate = Boolean(name.trim() && sample && consent) && !busy;

  const create = async () => {
    if (!sample || !canCreate) return;
    setBusy(true);
    setError(undefined);
    try {
      const voice = await createClonedVoice({
        name: name.trim(),
        model: model.id,
        sample,
        extension: extensionOf(sample.name),
        consent,
      });
      setName("");
      setSample(undefined);
      setConsent(false);
      onChanged(voice);
    } catch (failure) {
      setError(
        failure && typeof failure === "object" && "message" in failure
          ? t(String(failure.message))
          : t("The voice could not be made."),
      );
    } finally {
      setBusy(false);
    }
  };

  const forget = async (voice: ClonedVoice) => {
    setError(undefined);
    try {
      await deleteClonedVoice(voice.id);
      onChanged(undefined);
    } catch {
      setError(t("The voice could not be deleted."));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Your voices")}
      description={t(
        "Make a voice from {seconds} to 10 seconds of clear speech, one speaker, no music. The sample stays on this device. {engine} keeps a copy for {days} days, and Sub Rosa sends the sample again when it needs to.",
        { seconds: cloning.minSampleSeconds, engine: model.name, days: cloning.retentionDays },
      )}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Close")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {busy ? t("Making the voice...") : t("Make this voice")}
          </button>
        </>
      }
    >
      <div className="cloned-voice-form">
        {voices.length > 0 ? (
          <ul
            className="cloned-voice-list"
            aria-label={t("Voices made for {engine}", { engine: model.name })}
          >
            {voices.map((voice) => (
              <li key={voice.id} className="cloned-voice-row">
                <span>{voice.name}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={t("Delete {name}", { name: voice.name })}
                  onClick={() => void forget(voice)}
                >
                  {t("Delete")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="cloned-voice-field" htmlFor={nameId}>
          <span>{t("Name")}</span>
          <input
            id={nameId}
            className="studio-input"
            value={name}
            maxLength={60}
            placeholder={t("My voice")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="cloned-voice-field" htmlFor={fileId}>
          <span>{t("Sample")}</span>
          <input
            id={fileId}
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.flac"
            onChange={(event) => setSample(event.target.files?.[0])}
          />
        </label>
        <label className="cloned-voice-consent" htmlFor={consentId}>
          <input
            id={consentId}
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>{t("This is my own voice, or one I have permission to use.")}</span>
        </label>
        {error ? <p className="studio-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}
