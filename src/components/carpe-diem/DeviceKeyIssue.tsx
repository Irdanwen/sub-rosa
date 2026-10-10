import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IssueOutcome,
  accountClosedAt,
  carpeDiemIssueCancel,
  carpeDiemIssueKey,
  carpeDiemIssuePoll,
  openAccountSignIn,
} from "../../lib/carpe-diem-issue";
import { errorCode, messageFromError } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";
import { InlineNotice } from "../ui/InlineNotice";

/** How often a waiting confirmation asks Carpe Diem, while the screen is seen. */
export const CONFIRMATION_POLL_MS = 4_000;

type Phase =
  | { kind: "idle" }
  | { kind: "issuing" }
  | { kind: "confirm"; outcome: IssueOutcome }
  | { kind: "reauth"; opening: boolean }
  | { kind: "issued" }
  | { kind: "closed"; closedAt: Date | null }
  | { kind: "failed"; message: string };

/**
 * Creates this device's Carpe Diem key from the account it is signed in to
 * (ADR-0069). Four things can happen and each gets its own words: the key
 * arrives; Carpe Diem already knows the address and asks the person to
 * confirm by mail with the code shown here; the sign-in is too old and a fresh
 * one is needed (the page opens and the attempt resumes by itself); or it
 * fails, with a way to try again or paste a key instead.
 *
 * One refusal is not a failure to retry: the person deleted the Carpe Diem
 * account this one was linked to. Its credits are gone, and Carpe Diem
 * recreates nothing by itself. The card says so and offers a new, empty
 * account only as a button; that click is the one request that carries
 * `reactivate`, and nothing here sends it on its own.
 *
 * Nothing here outlives the screen: the confirmation is asked about only while
 * the card is visible, and a phone that suspends simply asks again when it
 * comes back (ADR-0018).
 */
export function DeviceKeyIssue({
  autoStart = false,
  onIssued,
  onUseKey,
  actionLabel,
}: {
  /** Start as soon as the card mounts: the first-run paths. */
  autoStart?: boolean;
  onIssued?: () => void;
  /** Leave for the paste-a-key path. */
  onUseKey?: () => void;
  /** The button that starts it when not automatic. */
  actionLabel?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: autoStart ? "issuing" : "idle" });
  const mounted = useRef(true);
  const started = useRef(false);
  const awaitingSignIn = useRef(false);
  /** The current attempt is the person's choice of a new, empty account, so
   * a fresh sign-in it needed resumes it as such. */
  const reactivating = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const settle = useCallback(
    (outcome: IssueOutcome) => {
      if (!mounted.current) return;
      if (outcome.status === "issued") {
        setPhase({ kind: "issued" });
        onIssued?.();
      } else {
        setPhase({ kind: "confirm", outcome });
      }
    },
    [onIssued],
  );

  const fail = useCallback((cause: unknown) => {
    if (!mounted.current) return;
    if (errorCode(cause) === "carpe_diem_reauth_required") {
      setPhase({ kind: "reauth", opening: false });
      return;
    }
    if (errorCode(cause) === "carpe_diem_account_closed") {
      reactivating.current = false;
      setPhase({ kind: "closed", closedAt: accountClosedAt(cause) });
      return;
    }
    setPhase({ kind: "failed", message: messageFromError(cause) });
  }, []);

  const issue = useCallback(
    async (reactivate = false) => {
      reactivating.current = reactivate;
      setPhase({ kind: "issuing" });
      try {
        settle(await carpeDiemIssueKey({ reactivate }));
      } catch (cause) {
        fail(cause);
      }
    },
    [fail, settle],
  );

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void issue();
  }, [autoStart, issue]);

  // A fresh sign-in finishes in Rust, off the deep link. The attempt that
  // asked for it picks up again on its own.
  useEffect(() => {
    let cancelled = false;
    const finished = listen("subrosa://account-updated", () => {
      if (cancelled || !awaitingSignIn.current) return;
      awaitingSignIn.current = false;
      void issue(reactivating.current);
    }).catch(() => () => {});
    return () => {
      cancelled = true;
      void finished.then((stop) => stop()).catch(() => {});
    };
  }, [issue]);

  const waiting = phase.kind === "confirm";
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "hidden") {
        try {
          const outcome = await carpeDiemIssuePoll();
          if (cancelled) return;
          if (outcome.status === "issued") {
            settle(outcome);
            return;
          }
        } catch (cause) {
          if (cancelled) return;
          // A dropped connection keeps the attempt; anything else ends it.
          if (errorCode(cause) !== "carpe_diem_issue_unreachable") {
            fail(cause);
            return;
          }
        }
      }
      timer = setTimeout(() => void poll(), CONFIRMATION_POLL_MS);
    };
    timer = setTimeout(() => void poll(), CONFIRMATION_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting, settle, fail]);

  const signInAgain = async () => {
    setPhase({ kind: "reauth", opening: true });
    awaitingSignIn.current = true;
    try {
      const { opened } = await openAccountSignIn();
      if (!mounted.current) return;
      setPhase({ kind: "reauth", opening: false });
      if (!opened) {
        awaitingSignIn.current = false;
        setPhase({
          kind: "failed",
          message: t("Your browser did not open. Try again, or paste a key instead."),
        });
      }
    } catch (cause) {
      awaitingSignIn.current = false;
      fail(cause);
    }
  };

  const cancel = async () => {
    await carpeDiemIssueCancel().catch(() => undefined);
    if (mounted.current) setPhase({ kind: "idle" });
  };

  const pasteInstead = onUseKey ? (
    <button type="button" className="btn btn-secondary" onClick={onUseKey}>
      {t("Paste a key instead")}
    </button>
  ) : null;

  switch (phase.kind) {
    case "idle":
      return (
        <div className="account-actions">
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void issue()}
          >
            {actionLabel ?? t("Create this device's key")}
          </button>
          {pasteInstead}
        </div>
      );
    case "issuing":
      return (
        <p role="status" className="settings-row-description">
          {t("Creating this device's key with Carpe Diem…")}
        </p>
      );
    case "issued":
      return (
        <p role="status" className="settings-row-description">
          {t("This device has its own key now. It draws on your account's credits.")}
        </p>
      );
    case "confirm":
      return (
        <div className="account-form device-key-confirm">
          <p className="settings-row-description">
            {phase.outcome.emailHint
              ? t(
                  "Carpe Diem already has an account for this address. Open the email sent to {email} and enter this code there to link it:",
                  { email: phase.outcome.emailHint },
                )
              : t(
                  "Carpe Diem already has an account for this address. Open the email it sent you and enter this code there to link it:",
                )}
          </p>
          <code className="account-login-code">{phase.outcome.code}</code>
          <p role="status" className="settings-row-description">
            {t("Waiting for your confirmation. This screen updates by itself.")}
          </p>
          <div className="account-actions">
            <button type="button" className="btn btn-secondary" onClick={() => void cancel()}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      );
    case "reauth":
      return (
        <div className="account-form">
          <p className="settings-row-description">
            {phase.opening || awaitingSignIn.current
              ? t("Finish signing in in your browser. The key is created when you come back.")
              : t(
                  "Creating a key needs a recent sign-in. Sign in again; it takes a moment, and nothing else changes.",
                )}
          </p>
          <div className="account-actions">
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={phase.opening}
              onClick={() => void signInAgain()}
            >
              {phase.opening ? t("Opening…") : t("Sign in again")}
            </button>
            {pasteInstead}
          </div>
        </div>
      );
    case "closed":
      return (
        <div className="account-form">
          <InlineNotice
            role="alert"
            body={
              phase.closedAt
                ? t(
                    "Your Carpe Diem account was deleted on {date}. Its credits are gone and cannot be refunded.",
                    {
                      date: phase.closedAt.toLocaleDateString(intlLocale(), {
                        dateStyle: "long",
                      }),
                    },
                  )
                : t(
                    "Your Carpe Diem account was deleted. Its credits are gone and cannot be refunded.",
                  )
            }
          />
          <p className="settings-row-description">
            {t(
              "You can open a new, empty Carpe Diem account for this device. Nothing is created unless you choose it.",
            )}
          </p>
          <div className="account-actions">
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => void issue(true)}
            >
              {t("Open a new, empty account")}
            </button>
            {pasteInstead}
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="account-form">
          <InlineNotice role="alert" tone="destructive" body={phase.message} />
          <div className="account-actions">
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => void issue(reactivating.current)}
            >
              {t("Try again")}
            </button>
            {pasteInstead}
          </div>
        </div>
      );
  }
}
