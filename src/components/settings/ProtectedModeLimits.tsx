import { type FormEvent, useId, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  isValidPin,
  minuteToTime,
  NO_RESTRICTIONS,
  type ProtectedModeStatus,
  type ProtectedRestrictions,
  protectedModeSetRestrictions,
  timeToMinute,
} from "../../lib/protected-mode";
import { Dialog, DialogField } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

/** The switches a person sees, in the order the card lists them. Each turns a
 * feature off when its `...Off` flag is set. */
type FeatureKey = "memoryOff" | "mediaOff" | "voiceOff" | "pastChatsOff";

function features(): { key: FeatureKey; label: string; description: string }[] {
  return [
    {
      key: "memoryOff",
      label: t("Memory"),
      description: t("Chats neither remember nor recall facts about the person."),
    },
    {
      key: "mediaOff",
      label: t("Image and video generation"),
      description: t("Studio and the assistants make no pictures or videos."),
    },
    {
      key: "voiceOff",
      label: t("Voice"),
      description: t("No talking with the assistant out loud."),
    },
    {
      key: "pastChatsOff",
      label: t("Past chats"),
      description: t("Chats do not look through other conversations."),
    },
  ];
}

export function quietHoursLabel(restrictions: ProtectedRestrictions): string {
  const window = restrictions.quietHours;
  if (!window) return t("Off");
  return t("{start} to {end}", {
    start: minuteToTime(window.startMinute),
    end: minuteToTime(window.endMinute),
  });
}

/**
 * The parental-control switches of protected mode (ADR-0084 addendum): quiet
 * hours, memory, image and video generation, voice and past chats. Shown
 * while protected mode is on; changing them takes the PIN. Rust enforces
 * each one where requests leave; this card only shows and sets them.
 */
export function ProtectedModeLimits({
  status,
  onChanged,
}: {
  status: ProtectedModeStatus;
  onChanged: (status: ProtectedModeStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const restrictions = status.restrictions ?? NO_RESTRICTIONS;
  return (
    <>
      <div className="settings-row">
        <div className="settings-row-info">
          <p className="settings-row-title">{t("Quiet hours")}</p>
          <p className="settings-row-description">
            {status.quietNow
              ? t("{window}. Quiet hours are on now.", { window: quietHoursLabel(restrictions) })
              : quietHoursLabel(restrictions)}
          </p>
        </div>
      </div>
      {features().map((feature) => (
        <div className="settings-row" key={feature.key}>
          <div className="settings-row-info">
            <p className="settings-row-title">{feature.label}</p>
            <p className="settings-row-description">{feature.description}</p>
          </div>
          <div className="settings-row-control">
            <span className="settings-row-description">
              {restrictions[feature.key] ? t("Turned off") : t("Allowed")}
            </span>
          </div>
        </div>
      ))}
      <div className="settings-row">
        <div className="settings-row-info">
          <p className="settings-row-description">{t("Changing these takes the PIN.")}</p>
        </div>
        <div className="settings-row-control">
          <button type="button" className="primary-action" onClick={() => setEditing(true)}>
            {t("Change limits")}
          </button>
        </div>
      </div>
      {editing ? (
        <LimitsDialog
          initial={restrictions}
          onClose={() => setEditing(false)}
          onDone={(next) => {
            onChanged(next);
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}

const DEFAULT_QUIET_START = 21 * 60;
const DEFAULT_QUIET_END = 7 * 60;

function LimitsDialog({
  initial,
  onClose,
  onDone,
}: {
  initial: ProtectedRestrictions;
  onClose: () => void;
  onDone: (status: ProtectedModeStatus) => void;
}) {
  const [draft, setDraft] = useState<ProtectedRestrictions>(initial);
  const [start, setStart] = useState(
    minuteToTime(initial.quietHours?.startMinute ?? DEFAULT_QUIET_START),
  );
  const [end, setEnd] = useState(minuteToTime(initial.quietHours?.endMinute ?? DEFAULT_QUIET_END));
  const [quiet, setQuiet] = useState(Boolean(initial.quietHours));
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ids = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    let quietHours: ProtectedRestrictions["quietHours"];
    if (quiet) {
      const startMinute = timeToMinute(start);
      const endMinute = timeToMinute(end);
      if (startMinute === undefined || endMinute === undefined || startMinute === endMinute) {
        setError(t("Choose quiet hours that start and end at different times."));
        return;
      }
      quietHours = { startMinute, endMinute };
    }
    if (!isValidPin(pin)) {
      setError(t("Use a PIN of 4 to 6 digits."));
      return;
    }
    setBusy(true);
    try {
      onDone(await protectedModeSetRestrictions(pin, { ...draft, quietHours }));
    } catch (caught) {
      setError(messageFromError(caught));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("Change protected mode limits")}
      description={t("Choose what stays on, then enter the PIN.")}
      initialFocusSelector='button[role="switch"]'
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            form="protected-mode-limits-form"
            className="primary-action primary-solid"
            disabled={busy || pin.length < 4}
          >
            {t("Save")}
          </button>
        </>
      }
    >
      <form
        id="protected-mode-limits-form"
        className="dialog-body"
        onSubmit={(e) => void submit(e)}
      >
        <div className="settings-row">
          <div className="settings-row-info">
            <p className="settings-row-title" id={`${ids}-quiet`}>
              {t("Quiet hours")}
            </p>
            <p className="settings-row-description">
              {t("Chat and Studio pause every day between these times.")}
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={quiet}
              onCheckedChange={(next) => {
                setQuiet(next);
                setError(undefined);
              }}
              aria-labelledby={`${ids}-quiet`}
            />
          </div>
        </div>
        {quiet ? (
          <>
            <DialogField label={t("From")} htmlFor={`${ids}-start`}>
              <input
                id={`${ids}-start`}
                className="dialog-input"
                type="time"
                value={start}
                onChange={(event) => {
                  setStart(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </DialogField>
            <DialogField label={t("Until")} htmlFor={`${ids}-end`}>
              <input
                id={`${ids}-end`}
                className="dialog-input"
                type="time"
                value={end}
                onChange={(event) => {
                  setEnd(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </DialogField>
          </>
        ) : null}
        {features().map((feature) => (
          <div className="settings-row" key={feature.key}>
            <div className="settings-row-info">
              <p className="settings-row-title" id={`${ids}-${feature.key}`}>
                {feature.label}
              </p>
              <p className="settings-row-description">{feature.description}</p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={!draft[feature.key]}
                onCheckedChange={(on) =>
                  setDraft((current) => ({ ...current, [feature.key]: !on }))
                }
                aria-labelledby={`${ids}-${feature.key}`}
              />
            </div>
          </div>
        ))}
        <DialogField label={t("PIN")} htmlFor={`${ids}-pin`}>
          <input
            id={`${ids}-pin`}
            name="protected-mode-limits-pin"
            className="dialog-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => {
              setPin(event.currentTarget.value.replace(/\D/g, "").slice(0, 6));
              setError(undefined);
            }}
          />
        </DialogField>
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
