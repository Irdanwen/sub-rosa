import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { type FormEvent, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  isValidPin,
  type ProtectedModeStatus,
  protectedModeDisable,
  protectedModeEnable,
  protectedModeStatus,
} from "../../lib/protected-mode";
import { Dialog, DialogField } from "../ui/Dialog";
import { ProtectedModeLimits } from "./ProtectedModeLimits";

type Step = "enable" | "disable" | null;

/**
 * Settings › Privacy › Protected mode (ADR-0084), on both shells: the phone's
 * Privacy screen renders the same section.
 *
 * The guards are Rust's. This card only turns them on with a new PIN and off
 * with that PIN, and says plainly what they do and what they do not stop.
 */
export function ProtectedModeSection() {
  const [status, setStatus] = useState<ProtectedModeStatus | null>(null);
  const [step, setStep] = useState<Step>(null);

  useEffect(() => {
    let cancelled = false;
    protectedModeStatus()
      .then((next) => {
        if (!cancelled) setStatus(next ?? { enabled: false });
      })
      .catch(() => {
        if (!cancelled) setStatus({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enabled = status?.enabled === true;

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <IconShieldCheck size={15} ariaHidden />
        <h3 className="settings-row-title">{t("Protected mode")}</h3>
      </div>
      <p className="settings-row-description">
        {t(
          "For a child or a shared device. While it is on, adult and uncensored models are hidden from every picker, Studio images are made with safe mode on, chats follow stricter rules, and the limits below apply. Turning it off or changing a limit takes the PIN.",
        )}
      </p>
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <p className="settings-row-title" role="status">
              {status === null ? t("Checking") : enabled ? t("On") : t("Off")}
            </p>
            <p className="settings-row-description">
              {t(
                "It stops changes made in the app. Someone who can edit this device's files or reinstall the app can still remove it.",
              )}
            </p>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="primary-action"
              disabled={status === null}
              onClick={() => setStep(enabled ? "disable" : "enable")}
            >
              {enabled ? t("Turn off") : t("Turn on")}
            </button>
          </div>
        </div>
        {enabled && status ? <ProtectedModeLimits status={status} onChanged={setStatus} /> : null}
      </div>
      {step ? (
        <PinDialog
          step={step}
          onClose={() => setStep(null)}
          onDone={(next) => {
            setStatus(next);
            setStep(null);
          }}
        />
      ) : null}
    </div>
  );
}

function PinDialog({
  step,
  onClose,
  onDone,
}: {
  step: "enable" | "disable";
  onClose: () => void;
  onDone: (status: ProtectedModeStatus) => void;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const enabling = step === "enable";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isValidPin(pin)) {
      setError(t("Use a PIN of 4 to 6 digits."));
      return;
    }
    if (enabling && pin !== confirm) {
      setError(t("The two PINs do not match."));
      return;
    }
    setBusy(true);
    try {
      onDone(enabling ? await protectedModeEnable(pin) : await protectedModeDisable(pin));
    } catch (caught) {
      setError(messageFromError(caught));
      setPin("");
      setConfirm("");
    } finally {
      setBusy(false);
    }
  }

  const digitsOnly = (value: string) => value.replace(/\D/g, "").slice(0, 6);

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={enabling ? t("Turn on protected mode") : t("Turn off protected mode")}
      description={
        enabling
          ? t("Choose a PIN of 4 to 6 digits. You will need it to turn protected mode off.")
          : t("Enter the PIN to turn protected mode off.")
      }
      initialFocusSelector='input[name="protected-mode-pin"]'
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            form="protected-mode-form"
            className="primary-action primary-solid"
            disabled={busy || pin.length < 4 || (enabling && confirm.length < 4)}
          >
            {enabling ? t("Turn on") : t("Turn off")}
          </button>
        </>
      }
    >
      <form id="protected-mode-form" className="dialog-body" onSubmit={(e) => void submit(e)}>
        <DialogField label={t("PIN")} htmlFor="protected-mode-pin">
          <input
            id="protected-mode-pin"
            name="protected-mode-pin"
            className="dialog-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => {
              setPin(digitsOnly(event.currentTarget.value));
              setError(undefined);
            }}
          />
        </DialogField>
        {enabling ? (
          <DialogField label={t("Confirm the PIN")} htmlFor="protected-mode-confirm">
            <input
              id="protected-mode-confirm"
              name="protected-mode-confirm"
              className="dialog-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={confirm}
              onChange={(event) => {
                setConfirm(digitsOnly(event.currentTarget.value));
                setError(undefined);
              }}
            />
          </DialogField>
        ) : null}
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
