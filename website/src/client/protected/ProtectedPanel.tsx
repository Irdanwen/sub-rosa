import { type FormEvent, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import { guardsFor, type Restrictions } from "./rules";
import { OFF, ProtectedMode, type ProtectedSettings } from "./state";
import "./protected.css";

function minuteOf(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
function timeOf(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Protected mode for this browser: the switch behind a PIN, and the five
 * parental controls behind the same PIN. */
export function ProtectedPanel({ host, mode }: { host: FeatureHost; mode?: ProtectedMode }) {
  const [protectedMode] = useState(() => mode ?? new ProtectedMode(host.storeFor("protected")));
  const [settings, setSettings] = useState<ProtectedSettings | null>(null);
  const [draft, setDraft] = useState<Restrictions>(OFF.restrictions);
  const [quietOn, setQuietOn] = useState(false);
  const [start, setStart] = useState("21:00");
  const [end, setEnd] = useState("07:00");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);

  const show = (next: ProtectedSettings) => {
    setSettings(next);
    setDraft(next.restrictions);
    setQuietOn(!!next.restrictions.quietHours);
    if (next.restrictions.quietHours) {
      setStart(timeOf(next.restrictions.quietHours.startMinute));
      setEnd(timeOf(next.restrictions.quietHours.endMinute));
    }
    host.setGuards(guardsFor(next.enabled, next.restrictions));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded once per panel.
  useEffect(() => {
    void protectedMode.load().then(show);
  }, [protectedMode]);

  const act = async (event: FormEvent, action: () => Promise<{ ok: boolean; reason?: string }>) => {
    event.preventDefault();
    setError("");
    setMessage("");
    setWorking(true);
    try {
      const outcome = await action();
      if (!outcome.ok) {
        setError(outcome.reason ?? "");
        return;
      }
      setPin("");
      setConfirm("");
      show(await protectedMode.load());
      setMessage(t("Saved.", "Enregistré."));
    } finally {
      setWorking(false);
    }
  };

  if (!settings) return <p role="status">{t("Loading…", "Chargement…")}</p>;

  const pinField = (label: string, value: string, set: (value: string) => void, id: string) => (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={value}
        onChange={(event) => set(event.target.value.replace(/\D/g, ""))}
      />
    </label>
  );

  const restrictionsToSave = (): Restrictions => {
    const startMinute = minuteOf(start);
    const endMinute = minuteOf(end);
    return {
      ...draft,
      quietHours:
        quietOn && startMinute !== null && endMinute !== null
          ? { startMinute, endMinute }
          : undefined,
    };
  };

  return (
    <div className="wc-pm-panel">
      <h1>{t("Protected mode", "Mode protégé")}</h1>
      <p className="lede">
        {t(
          "Hand this browser to a child, or share it, and keep the obvious paths to adult content closed until someone with the PIN opens them again: adult models are hidden and refused, and every chat carries an instruction to stay suitable for a general audience.",
          "Confiez ce navigateur à un enfant, ou partagez-le, et gardez fermés les accès évidents aux contenus pour adultes jusqu’à ce qu’une personne qui connaît le code les rouvre : les modèles pour adultes sont masqués et refusés, et chaque discussion porte une consigne de rester adaptée à tout public.",
        )}
      </p>
      <p className="quiet">
        {t(
          "It holds in this browser only, and only against casual change. Clearing this browser's data removes it, like reinstalling the app, and anyone with your Carpe Diem key can use another app. Set it on each device a child uses.",
          "Il vaut dans ce navigateur seulement, et seulement contre un changement en passant. Effacer les données de ce navigateur le retire, comme réinstaller l’app, et toute personne qui a votre clé Carpe Diem peut utiliser une autre app. Activez-le sur chaque appareil qu’un enfant utilise.",
        )}
      </p>
      {!settings.enabled ? (
        <form
          className="wc-pm-form"
          onSubmit={(event) =>
            void act(event, async () =>
              pin !== confirm
                ? {
                    ok: false,
                    reason: t("The two PINs differ.", "Les deux codes diffèrent."),
                  }
                : protectedMode.turnOn(pin),
            )
          }
        >
          {pinField(
            t("Choose a PIN of 4 to 6 digits", "Choisissez un code de 4 à 6 chiffres"),
            pin,
            setPin,
            "pm-pin",
          )}
          {pinField(t("The PIN again", "Le code à nouveau"), confirm, setConfirm, "pm-confirm")}
          <button className="button primary" type="submit" disabled={working || !pin}>
            {t("Turn on protected mode", "Activer le mode protégé")}
          </button>
        </form>
      ) : (
        <>
          <p role="status">
            <strong>{t("Protected mode is on.", "Le mode protégé est activé.")}</strong>
          </p>
          <form
            className="wc-pm-form"
            onSubmit={(event) =>
              void act(event, () => protectedMode.setRestrictions(pin, restrictionsToSave()))
            }
          >
            <fieldset>
              <legend>{t("Parental controls", "Contrôle parental")}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={quietOn}
                  onChange={(event) => setQuietOn(event.target.checked)}
                />
                {t("Quiet hours: chat pauses", "Heures calmes : le chat se met en pause")}
              </label>
              {quietOn && (
                <div className="wc-row">
                  <label>
                    {t("From", "De")}
                    <input
                      type="time"
                      value={start}
                      onChange={(event) => setStart(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("To", "À")}
                    <input
                      type="time"
                      value={end}
                      onChange={(event) => setEnd(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {(
                [
                  ["memoryOff", t("Memory off", "Mémoire coupée")],
                  [
                    "mediaOff",
                    t("Image and video generation off", "Création d’images et de vidéos coupée"),
                  ],
                  ["pastChatsOff", t("Past chats off", "Discussions passées coupées")],
                  ["voiceOff", t("Voice conversations off", "Conversations vocales coupées")],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={draft[key]}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            {pinField(t("PIN", "Code"), pin, setPin, "pm-change")}
            <button className="button primary" type="submit" disabled={working || !pin}>
              {t("Save the controls", "Enregistrer les contrôles")}
            </button>
          </form>
          <form
            className="wc-pm-form"
            onSubmit={(event) => void act(event, () => protectedMode.turnOff(confirm))}
          >
            {pinField(
              t("PIN to turn it off", "Code pour le désactiver"),
              confirm,
              setConfirm,
              "pm-off",
            )}
            <button className="button" type="submit" disabled={working || !confirm}>
              {t("Turn off protected mode", "Désactiver le mode protégé")}
            </button>
          </form>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="quiet" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
