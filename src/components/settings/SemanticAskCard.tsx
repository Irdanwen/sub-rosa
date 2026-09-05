import { t } from "../../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { type AskIndexStatusDto, askIndexStatus, setAskSettings } from "../../lib/ask";
import { messageFromError } from "../../lib/errors";
import { Switch } from "../ui/Switch";

/** The sentence under the switch: what has been cut and embedded so far. */
export function semanticSentence(status: AskIndexStatusDto | null) {
  if (!status) return "";
  if (!status.settings.semantic) {
    return t(
      "Off. Questions match your notes by their words only, and no passage is kept as a vector.",
    );
  }
  if (status.passages === 0) {
    return t("On. No passage cut yet; the first pass runs in the background after a note changes.");
  }
  if (status.embedded === status.passages) {
    return status.passages === 1
      ? t("On. 1 passage cut from your notes, all embedded.")
      : t("On. {count} passages cut from your notes, all embedded.", { count: status.passages });
  }
  return status.passages === 1
    ? t(
        "On. 1 passage cut from your notes, {embedded} embedded so far, the rest waits for the next pass.",
        { embedded: status.embedded },
      )
    : t(
        "On. {count} passages cut from your notes, {embedded} embedded so far, the rest waits for the next pass.",
        { count: status.passages, embedded: status.embedded },
      );
}

/**
 * Settings › Privacy: whether "Ask your notes" also matches by meaning.
 * That means passages of every note go to the configured endpoint once
 * more, in the background, to be embedded, which is why the switch lives
 * here, next to the ledger that shows those calls (ADR-0046).
 */
export function SemanticAskCard() {
  const [status, setStatus] = useState<AskIndexStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => askIndexStatus())
      .then((next) => {
        // A bridge without the command (a preview page, an older build)
        // answers nothing, and the card stays quiet rather than crashing.
        if (next?.settings) setStatus(next);
      })
      .catch((err) => setError(messageFromError(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(semantic: boolean) {
    setSaving(true);
    setError(null);
    try {
      setStatus(await setAskSettings({ semantic }));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row-text">
          <h3 className="settings-row-title" id="semantic-ask-title">
            {t("Understand questions by meaning")}
          </h3>
          <p className="settings-row-description">
            {t(
              "Passages of your notes are sent to your endpoint once more, in the background, to be turned into vectors, so a question finds a note that says the same thing in other words. Off, questions match by words only, and the vectors are deleted.",
            )}
          </p>
          {status ? <p className="settings-row-description">{semanticSentence(status)}</p> : null}
          {error ? <p className="settings-row-description">{error}</p> : null}
        </div>
        <div className="settings-row-control">
          <Switch
            checked={status?.settings.semantic === true}
            disabled={status === null || saving}
            onCheckedChange={(next) => void toggle(next)}
            aria-labelledby="semantic-ask-title"
          />
        </div>
      </div>
    </div>
  );
}
