import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type Account, type Device, api, setAccountScope } from "../../../website/src/lib/api";
import {
  type DeviceRecord,
  type DeviceStore,
  indexedDbStore,
  needsRenewal,
  openKey,
} from "../../../website/src/lib/browser-device";
import { date, t } from "../../../website/src/lib/i18n";
import { BrowserDeviceCard } from "../../../website/src/pages/browser-device";
import type { HostName, OfficeGlobal } from "../office";
import { openSignInWindow, type SignInWindow, SignInWindowError } from "./sign-in-window";

/** The account this pane last worked for. Not a secret: it names which
 * device record to read when the frame has no session to ask. */
const LAST_ACCOUNT = "subrosa:office-account";

function rememberAccount(account: Account) {
  try {
    localStorage.setItem(LAST_ACCOUNT, JSON.stringify({ id: account.id, email: account.email }));
  } catch {
    // Storage blocked: the pane asks for a sign-in each time instead.
  }
}
function lastAccount(): Account | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_ACCOUNT) ?? "null") as Account | null;
    return typeof value?.id === "string" && typeof value.email === "string"
      ? { id: value.id, email: value.email, created_at: "" }
      : null;
  } catch {
    return null;
  }
}

/** Whether the record holds a key that still works. */
export function hasLiveKey(record: DeviceRecord | null | undefined, now = Date.now()): boolean {
  return !!record?.deviceId && !!record.key && Date.parse(record.key.expiresAt) > now;
}

export interface Ready {
  account: Account;
  /** The `cdm_` key, opened for one use. */
  openKey(): Promise<string | null>;
}

type Session = { mode: "direct" } | { mode: "window"; window: SignInWindow } | null;

/**
 * Who the pane is and whether it may spend (ADR-0102). The pane is a browser
 * device of its own (ADR-0096): it keeps its device key and its bounded Carpe
 * Diem key in this frame's storage, and asks a session only to become a
 * device or renew the key. That session is this frame's own when Office lets
 * the account cookie reach it (the desktop apps' task panes are top-level
 * pages), and otherwise the sign-in window's.
 */
export function OfficeAccess({
  office,
  host,
  store = indexedDbStore,
  children,
}: {
  office: OfficeGlobal | null;
  host: HostName;
  store?: DeviceStore;
  children: (ready: Ready) => ReactNode;
}) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [session, setSession] = useState<Session>(null);
  const [record, setRecord] = useState<DeviceRecord | null | undefined>(undefined);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const sessionRef = useRef<Session>(null);
  sessionRef.current = session;

  // This frame's own session first, then the account it last worked for.
  useEffect(() => {
    let live = true;
    api<Account>("/api/v1/me")
      .then((me) => {
        if (!live) return;
        setAccountScope(me.id);
        rememberAccount(me);
        setAccount(me);
        setSession({ mode: "direct" });
      })
      .catch(() => live && setAccount(lastAccount()));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (account === undefined) return;
    if (!account) {
      setRecord(null);
      return;
    }
    let live = true;
    store
      .get(account.id)
      .then((value) => live && setRecord(value?.deviceId ? value : null))
      .catch(() => live && setRecord(null));
    return () => {
      live = false;
    };
  }, [account, store]);

  const loadDevices = useCallback(() => {
    api<Device[]>("/api/v1/devices")
      .then(setDevices)
      .catch(() => setDevices(null));
  }, []);
  useEffect(() => {
    if (session && account) loadDevices();
  }, [session, account, loadDevices]);

  // The window is closed as soon as the key it was opened for is there.
  const keyId = record?.key?.keyId;
  const openedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = sessionRef.current;
    if (current?.mode !== "window" || !hasLiveKey(record) || needsRenewal(record ?? null)) return;
    if (keyId === openedFor.current) return;
    current.window.close();
    setSession(null);
    setManaging(false);
  }, [record, keyId]);

  useEffect(
    () => () => {
      const current = sessionRef.current;
      if (current?.mode === "window") current.window.close();
    },
    [],
  );

  const signIn = useCallback(
    async (fresh = false) => {
      if (!office) return;
      setError("");
      setOpening(true);
      const previous = sessionRef.current;
      if (previous?.mode === "window") previous.window.close();
      try {
        openedFor.current = record?.key?.keyId;
        const opened = await openSignInWindow(office, {
          fresh,
          onClosed: () => setSession((now) => (now?.mode === "window" ? null : now)),
        });
        if (account && account.id !== opened.account.id) setRecord(undefined);
        rememberAccount(opened.account);
        setAccount(opened.account);
        setSession({ mode: "window", window: opened });
      } catch (err) {
        const code = err instanceof SignInWindowError ? err.code : "blocked";
        if (code === "unsupported")
          setError(
            t(
              "This version of Office cannot open the sign-in window. Update Office, or use Sub Rosa in Word, Excel or PowerPoint on your Mac or PC.",
              "Cette version d’Office ne peut pas ouvrir la fenêtre de connexion. Mettez Office à jour, ou utilisez Sub Rosa dans Word, Excel ou PowerPoint sur votre Mac ou PC.",
            ),
          );
        else if (code === "blocked")
          setError(
            t(
              "The sign-in window did not open. Allow pop-ups for Office, then try again.",
              "La fenêtre de connexion ne s’est pas ouverte. Autorisez les fenêtres surgissantes pour Office, puis réessayez.",
            ),
          );
      } finally {
        setOpening(false);
      }
    },
    [office, account, record],
  );

  if (account === undefined || record === undefined)
    return <p role="status">{t("Loading…", "Chargement…")}</p>;

  const ready = account && hasLiveKey(record);
  const card =
    account && session ? (
      <BrowserDeviceCard
        accountId={account.id}
        devices={devices}
        record={record}
        setRecord={setRecord}
        onDevicesChanged={loadDevices}
        store={store}
        office={{
          heading: t("This add-in", "Ce complément"),
          deviceName: t(`Office add-in - ${host}`, `Complément Office - ${host}`),
          // A recovery proof typed here would cross Office's channel when
          // the window carries the call: the app's approval only, then.
          allowRecovery: session.mode === "direct",
          signInAgain: () => void signIn(true),
        }}
      />
    ) : null;

  const signInButton = (label: string) => (
    <button
      className="button primary"
      type="button"
      disabled={opening || !office}
      onClick={() => void signIn()}
    >
      {opening ? t("Please wait…", "Veuillez patienter…") : label}
    </button>
  );

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {ready && account ? (
        <>
          {children({ account, openKey: () => openKey(record as DeviceRecord) })}
          <footer className="office-footer">
            <p className="quiet">
              {t(
                `${account.email} · key valid until ${date(record?.key?.expiresAt ?? "")}`,
                `${account.email} · clé valable jusqu’au ${date(record?.key?.expiresAt ?? "")}`,
              )}
            </p>
            {needsRenewal(record ?? null) && !session && (
              <p className="notice">
                {t(
                  "This key runs out soon. Sign in to renew it.",
                  "Cette clé arrive bientôt à échéance. Connectez-vous pour la renouveler.",
                )}{" "}
                {signInButton(t("Renew the key", "Renouveler la clé"))}
              </p>
            )}
            {managing ? (
              (card ?? signInButton(t("Sign in", "Se connecter")))
            ) : (
              <button
                className="button quiet-button"
                type="button"
                onClick={() => setManaging(true)}
              >
                {t("Manage this add-in", "Gérer ce complément")}
              </button>
            )}
          </footer>
        </>
      ) : card ? (
        card
      ) : (
        <article className="card">
          <h2>{t("Connect Sub Rosa", "Relier Sub Rosa")}</h2>
          <p>
            {office
              ? t(
                  "Sign in to your Sub Rosa account, then approve this add-in from the Sub Rosa app. It gets its own Carpe Diem key with a small daily limit, kept in this add-in only.",
                  "Connectez-vous à votre compte Sub Rosa, puis approuvez ce complément depuis l’app Sub Rosa. Il reçoit sa propre clé Carpe Diem avec une petite limite par jour, gardée dans ce complément seulement.",
                )
              : t(
                  "Open this page from Word, Excel or PowerPoint: it is an Office add-in. The guide on the Sub Rosa site explains how to add it.",
                  "Ouvrez cette page depuis Word, Excel ou PowerPoint : c’est un complément Office. Le guide du site Sub Rosa explique comment l’ajouter.",
                )}
          </p>
          {office && signInButton(t("Sign in", "Se connecter"))}
        </article>
      )}
    </>
  );
}
