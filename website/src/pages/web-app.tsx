import { useCallback, useEffect, useRef, useState } from "react";
import { type Account, ApiError, api, setAccountScope } from "../lib/api";
import {
  AccountClosedError,
  birthKey,
  type DeviceRecord,
  type DeviceStore,
  indexedDbStore,
  needsRenewal,
  openKey,
} from "../lib/browser-device";
import { t } from "../lib/i18n";
import { WebClient } from "../client/ui/WebClient";
import { VaultGate } from "./account";
import { useBrowserDevice } from "./browser-device";

type Key = Uint8Array<ArrayBuffer>;
/** The vault closes after this long without a key or pointer, as on the
 * account page. */
const IDLE_LOCK_MS = 15 * 60 * 1000;

/**
 * `/app`, the web client (WP19). Three gates, in order: a signed-in account,
 * this browser admitted as one of its devices with a live Carpe Diem key
 * (ADR-0096), and the vault unlocked in this tab. Each one that is missing
 * says what to do; none is skipped.
 */
export function WebAppPage({ store = indexedDbStore }: { store?: DeviceStore }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<Account>("/api/v1/me", { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        setAccountScope(value.id);
        setAccount(value);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setAccount(null);
        if (!(err instanceof ApiError) || err.status !== 401)
          setError(
            t(
              "Your account could not be reached. Check your connection and try again.",
              "Votre compte n’a pas pu être joint. Vérifiez votre connexion et réessayez.",
            ),
          );
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const changed = () => setAccount(null);
    window.addEventListener("subrosa:account-session-changed", changed);
    return () => window.removeEventListener("subrosa:account-session-changed", changed);
  }, []);

  if (account === undefined)
    return (
      <section className="page wrap" aria-busy="true">
        <p role="status">{t("Opening your account…", "Ouverture de votre compte…")}</p>
      </section>
    );
  if (!account)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">Sub Rosa</p>
        <h1>{t("Your chats, in the browser.", "Vos discussions, dans le navigateur.")}</h1>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="lede">
          {t(
            "Sign in to continue your conversations here. They stay encrypted end to end, and this browser answers with its own key.",
            "Connectez-vous pour poursuivre vos discussions ici. Elles restent chiffrées de bout en bout, et ce navigateur répond avec sa propre clé.",
          )}
        </p>
        <a className="button primary" href="/auth/login?intent=signin&return_to=%2Fapp">
          {t("Sign in", "Se connecter")}
        </a>
      </section>
    );
  return <DeviceGate account={account} store={store} />;
}

function DeviceGate({ account, store }: { account: Account; store: DeviceStore }) {
  const [record, setRecord] = useBrowserDevice(account.id, store);
  const renewing = useRef(false);
  // Renewed while it still works, so the person never meets an expired key.
  // A renewal that needs a confirmation by mail is left to the devices page.
  useEffect(() => {
    if (!record || renewing.current || !needsRenewal(record) || !record.key) return;
    renewing.current = true;
    birthKey(store, record)
      .then((birth) => {
        if (birth.status === "issued") setRecord(birth.record);
      })
      .catch(async (err) => {
        // The Carpe Diem account was deleted and its keys with it: the gate
        // sends the person to the devices page, which says so and asks.
        if (!(err instanceof AccountClosedError)) return;
        const keyless = { ...record, key: null };
        await store.put(keyless).catch(() => undefined);
        setRecord(keyless);
      });
  }, [record, store, setRecord]);

  if (record === undefined)
    return (
      <section className="page wrap" aria-busy="true">
        <p role="status">{t("Checking this browser…", "Vérification de ce navigateur…")}</p>
      </section>
    );
  const usable = record?.key && Date.parse(record.key.expiresAt) > Date.now();
  if (!record || !usable)
    return (
      <section className="page wrap prose">
        <p className="eyebrow">Sub Rosa</p>
        <h1>
          {record
            ? t("This browser needs a new key.", "Ce navigateur a besoin d’une nouvelle clé.")
            : t(
                "Make this browser one of your devices.",
                "Faites de ce navigateur un de vos appareils.",
              )}
        </h1>
        <p className="lede">
          {t(
            "The web client answers with a key that belongs to this browser alone, capped and short lived. Add the browser from your devices page, then come back.",
            "Le client web répond avec une clé propre à ce navigateur, plafonnée et de courte durée. Ajoutez le navigateur depuis la page de vos appareils, puis revenez.",
          )}
        </p>
        <a className="button primary" href="/account/devices">
          {t("Go to your devices", "Aller à vos appareils")}
        </a>
      </section>
    );
  return <VaultStage account={account} record={record} />;
}

function VaultStage({ account, record }: { account: Account; record: DeviceRecord }) {
  const [vaultKey, setVaultKey] = useState<Key | null>(null);
  const held = useRef<Key | null>(null);
  const lock = useCallback(() => {
    held.current?.fill(0);
    held.current = null;
    setVaultKey(null);
  }, []);
  useEffect(() => lock, [lock]);
  useEffect(() => {
    if (!vaultKey) return;
    let last = Date.now();
    const activity = () => {
      last = Date.now();
    };
    const timer = setInterval(() => {
      if (Date.now() - last > IDLE_LOCK_MS) lock();
    }, 30_000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, [vaultKey, lock]);
  const recordRef = useRef(record);
  recordRef.current = record;
  const open = useCallback(() => openKey(recordRef.current), []);
  if (!vaultKey)
    return (
      <section className="page wrap">
        <p className="eyebrow">Sub Rosa</p>
        <h1>{t("Unlock your chats", "Déverrouillez vos discussions")}</h1>
        <VaultGate
          account={account}
          onOpen={(key) => {
            lock();
            held.current = key;
            setVaultKey(key);
          }}
        />
      </section>
    );
  return (
    <section className="wc-page">
      <WebClient
        account={account}
        vaultKey={vaultKey}
        openKey={open}
        device={{ id: record.deviceId, name: record.name }}
      />
    </section>
  );
}
