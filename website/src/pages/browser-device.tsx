import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, type Device } from "../lib/api";
import {
  AccountClosedError,
  type Admission,
  type Birth,
  type DeviceRecord,
  type DeviceStore,
  admitBrowser,
  birthKey,
  browserFamily,
  forgetBrowser,
  indexedDbStore,
  needsRenewal,
} from "../lib/browser-device";
import { date, number, t } from "../lib/i18n";
import { decode, decrypt, encode, recoveryAdmissionProof } from "../lib/vault";
import { makePairCode } from "./pairing";

/** This browser's device record for `accountId`, read from IndexedDB. */
export function useBrowserDevice(accountId: string, store: DeviceStore = indexedDbStore) {
  const [record, setRecord] = useState<DeviceRecord | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    store
      .get(accountId)
      .then((value) => {
        if (live) setRecord(value?.deviceId ? value : null);
      })
      // Storage blocked (private window, policy): this browser cannot be a
      // device, and nothing else on the page depends on it.
      .catch(() => live && setRecord(null));
    return () => {
      live = false;
    };
  }, [accountId, store]);
  return [record, setRecord] as const;
}

function failure(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  if (code === "recent_auth_required")
    return t(
      "Sign in again first. Adding a device needs a sign-in from the last few minutes.",
      "Connectez-vous à nouveau d’abord. Ajouter un appareil demande une connexion de moins de quelques minutes.",
    );
  if (code === "admission_required")
    return t(
      "This did not admit the browser. Approve it from the Sub Rosa app, or check your recovery key. A vault created by an earlier version of the app can only admit a browser through the app.",
      "Cela n’a pas admis ce navigateur. Approuvez-le depuis l’app Sub Rosa, ou vérifiez votre clé de récupération. Un coffre créé par une version antérieure de l’app ne peut admettre un navigateur que par l’app.",
    );
  if (code === "forbidden")
    return t(
      "This account already has as many browsers as it may. Remove one you no longer use.",
      "Ce compte a déjà autant de navigateurs que permis. Retirez-en un que vous n’utilisez plus.",
    );
  if (code === "ISSUANCE_LIMITED")
    return t(
      "Carpe Diem has issued enough keys for this account today. Try again tomorrow.",
      "Carpe Diem a émis assez de clés pour ce compte aujourd’hui. Réessayez demain.",
    );
  if (code === "device_proof_invalid")
    return t(
      "This browser is no longer one of your devices.",
      "Ce navigateur ne fait plus partie de vos appareils.",
    );
  if (code === "not_found")
    return t(
      "This service does not issue Carpe Diem keys yet.",
      "Ce service n’émet pas encore de clés Carpe Diem.",
    );
  return t(
    "We could not complete this action. Check your connection and try again.",
    "Cette action n’a pas abouti. Vérifiez votre connexion et réessayez.",
  );
}

type Stage =
  | { kind: "idle" }
  | { kind: "choose" }
  | { kind: "recovery" }
  | { kind: "pairing"; code: string; requestId: string }
  | { kind: "confirm"; code: string; emailHint: string }
  /** Carpe Diem says the linked account was deleted. Nothing is asked again
   * until the person chooses a new, empty account. */
  | { kind: "closed"; closedAt: string | null };

export function BrowserDeviceCard({
  accountId,
  devices,
  record,
  setRecord,
  onDevicesChanged,
  store = indexedDbStore,
  office,
}: {
  accountId: string;
  devices: Device[] | null;
  record: DeviceRecord | null | undefined;
  setRecord: (record: DeviceRecord | null) => void;
  onDevicesChanged: () => void;
  store?: DeviceStore;
  /** An Office task pane (ADR-0102): its own heading and device name, its
   * sign-in through a window rather than this frame, and, when its calls
   * travel through Office's channel, no recovery key typed into it. */
  office?: {
    heading: string;
    deviceName: string;
    allowRecovery: boolean;
    signInAgain: () => void;
  };
}) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState("");
  const [stepUp, setStepUp] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const setError = useCallback((value: string, err?: unknown) => {
    setErrorText(value);
    setStepUp(err instanceof ApiError && err.code === "recent_auth_required");
  }, []);
  const [recovery, setRecovery] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const secret = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const renewing = useRef(false);

  const handleBirth = useCallback(
    async (birth: Birth) => {
      if (birth.status === "issued") {
        setRecord(birth.record);
        setStage({ kind: "idle" });
        return;
      }
      // Carpe Diem already knew this address: the person confirms by mail
      // with the code shown here, and the same ephemeral key collects the key.
      setStage({ kind: "confirm", code: birth.code, emailHint: birth.emailHint });
      const deadline = Date.parse(birth.expiresAt) || Date.now() + 15 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        if (!alive.current) return;
        const answer = await birth.poll();
        if (answer.status === "issued") {
          setRecord(answer.record);
          setStage({ kind: "idle" });
          return;
        }
      }
      setStage({ kind: "idle" });
      setError(
        t(
          "The confirmation expired. Ask for a key again.",
          "La confirmation a expiré. Demandez une clé à nouveau.",
        ),
      );
    },
    [setRecord, setError],
  );

  // A device revoked elsewhere: its keys here are dead weight, and keeping
  // them would only confuse the page.
  const forgetRevoked = useCallback(async () => {
    await store.delete(accountId);
    setRecord(null);
    setNotice(
      t(
        "This browser was removed from your devices, so its key was deleted here.",
        "Ce navigateur a été retiré de vos appareils, sa clé a donc été supprimée ici.",
      ),
    );
  }, [accountId, setRecord, store]);

  // The deleted account took this browser's key with it: the copy here is
  // dead, and keeping it would show a key that no longer answers.
  const closed = useCallback(
    async (current: DeviceRecord, err: AccountClosedError) => {
      const keyless = { ...current, key: null };
      await store.put(keyless).catch(() => undefined);
      setRecord(keyless);
      setStage({ kind: "closed", closedAt: err.closedAt });
    },
    [setRecord, store],
  );

  const mint = useCallback(
    async (current: DeviceRecord, reactivate = false) => {
      setBusy(true);
      setError("");
      try {
        await handleBirth(await birthKey(store, current, { reactivate }));
      } catch (err) {
        if (err instanceof ApiError && err.code === "device_proof_invalid") await forgetRevoked();
        else if (err instanceof AccountClosedError) await closed(current, err);
        else setError(failure(err), err);
      } finally {
        setBusy(false);
      }
    },
    [handleBirth, store, setError, forgetRevoked, closed],
  );

  // Only an explicit revocation in the list counts. A list fetched before this
  // browser was admitted does not name it yet, which says nothing; a device
  // that truly vanished fails its next proof, handled in mint.
  useEffect(() => {
    if (!record?.deviceId || !devices) return;
    if (devices.some((device) => device.id === record.deviceId && device.revoked_at))
      void forgetRevoked();
  }, [record, devices, forgetRevoked]);

  // Renewed while the device is live, before it runs out.
  useEffect(() => {
    if (!record || !devices || renewing.current || !needsRenewal(record)) return;
    if (!devices.some((device) => device.id === record.deviceId && !device.revoked_at)) return;
    renewing.current = true;
    void mint(record);
  }, [record, devices, mint]);

  const admit = async (admission: Admission) => {
    const family = browserFamily(navigator.userAgent);
    const name =
      office?.deviceName ??
      (family ? `${t("Browser", "Navigateur")} - ${family}` : t("Browser", "Navigateur"));
    const admitted = await admitBrowser(store, accountId, name, admission);
    setRecord(admitted);
    setStage({ kind: "idle" });
    onDevicesChanged();
    renewing.current = true;
    await mint(admitted);
  };

  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    let proof: Uint8Array<ArrayBuffer> | null = null;
    try {
      proof = await recoveryAdmissionProof(accountId, recovery);
      const value = encode(proof);
      setRecovery("");
      await admit({ recovery_proof: value });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? failure(err)
          : t(
              "This recovery key is not valid. Check it and try again.",
              "Cette clé de récupération n’est pas valide. Vérifiez-la et réessayez.",
            ),
        err,
      );
    } finally {
      proof?.fill(0);
      setBusy(false);
    }
  };

  const startPairing = async () => {
    setBusy(true);
    setError("");
    const requestId = crypto.randomUUID();
    const transfer = crypto.getRandomValues(new Uint8Array(32));
    try {
      await api("/api/v1/pairing", {
        method: "POST",
        body: JSON.stringify({ request_id: requestId }),
      });
      secret.current?.fill(0);
      secret.current = transfer;
      setStage({ kind: "pairing", requestId, code: makePairCode(requestId, accountId, transfer) });
    } catch (err) {
      transfer.fill(0);
      setError(failure(err), err);
    } finally {
      setBusy(false);
    }
  };

  // Waits for the app to approve, checks that what it sent really is this
  // account's vault key, then spends the approval on admitting the browser.
  // biome-ignore lint/correctness/useExhaustiveDependencies: admit is recreated every render and only read when the approval lands.
  useEffect(() => {
    if (stage.kind !== "pairing") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      if (stopped) return;
      if (Date.now() - started > 300_000) {
        setStage({ kind: "choose" });
        setError(
          t(
            "The code expired. Start a new request.",
            "Le code a expiré. Démarrez une nouvelle demande.",
          ),
        );
        return;
      }
      try {
        const result = await api<{ envelope: string | null }>(`/api/v1/pairing/${stage.requestId}`);
        if (stopped) return;
        if (result.envelope && secret.current) {
          const transfer = secret.current;
          secret.current = null;
          const valid = await decrypt<{ v: number; key: string }>(
            transfer,
            result.envelope,
            `subrosa:pairing:v1:${accountId}:${stage.requestId}`,
          )
            .then((value) => {
              const key = decode(value.key);
              const ok = value.v === 1 && key.length === 32;
              key.fill(0);
              return ok;
            })
            .catch(() => false)
            .finally(() => transfer.fill(0));
          if (stopped) return;
          if (!valid) {
            setStage({ kind: "choose" });
            setError(
              t(
                "This approval could not be verified. Start again from the app.",
                "Cette autorisation n’a pas pu être vérifiée. Recommencez depuis l’app.",
              ),
            );
            return;
          }
          setBusy(true);
          try {
            await admit({ pairing_request_id: stage.requestId });
          } catch (err) {
            setStage({ kind: "choose" });
            setError(failure(err), err);
          } finally {
            setBusy(false);
          }
          return;
        }
      } catch {
        // Keep waiting: the relay answers 404 until it has something.
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [stage, accountId]);

  useEffect(
    () => () => {
      alive.current = false;
      secret.current?.fill(0);
    },
    [],
  );

  const remove = async () => {
    if (!record) return;
    setBusy(true);
    try {
      await forgetBrowser(store, record);
      setRecord(null);
      setConfirmRemove(false);
      onDevicesChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <h2>{office?.heading ?? t("This browser", "Ce navigateur")}</h2>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          {stepUp &&
            (office ? (
              <button className="button" type="button" onClick={office.signInAgain}>
                {t("Sign in again", "Se reconnecter")}
              </button>
            ) : (
              <a href="/auth/login?return_to=/account/devices">
                {t("Sign in again", "Se reconnecter")}
              </a>
            ))}
        </p>
      )}
      {record === undefined ? (
        <p role="status">{t("Loading…", "Chargement…")}</p>
      ) : record ? (
        <>
          <p>
            {t(
              "This browser is one of your devices. It has its own Carpe Diem key, kept encrypted here and usable only by this browser.",
              "Ce navigateur est l’un de vos appareils. Il a sa propre clé Carpe Diem, gardée chiffrée ici et utilisable par ce seul navigateur.",
            )}
          </p>
          {stage.kind === "confirm" ? (
            <div className="notice" role="status">
              <p>
                {t(
                  `Carpe Diem sent a confirmation link to ${stage.emailHint}. Open it and enter this code:`,
                  `Carpe Diem a envoyé un lien de confirmation à ${stage.emailHint}. Ouvrez-le et saisissez ce code :`,
                )}
              </p>
              <code className="secret">{stage.code}</code>
            </div>
          ) : stage.kind === "closed" ? (
            <div className="notice" role="alert">
              <p>
                {stage.closedAt
                  ? t(
                      `Your Carpe Diem account was deleted on ${date(stage.closedAt)}. Its credits are gone and cannot be refunded.`,
                      `Votre compte Carpe Diem a été supprimé le ${date(stage.closedAt)}. Ses crédits sont perdus et ne peuvent pas être remboursés.`,
                    )
                  : t(
                      "Your Carpe Diem account was deleted. Its credits are gone and cannot be refunded.",
                      "Votre compte Carpe Diem a été supprimé. Ses crédits sont perdus et ne peuvent pas être remboursés.",
                    )}
              </p>
              <p>
                {t(
                  "You can open a new, empty Carpe Diem account for this browser. Nothing is created unless you choose it.",
                  "Vous pouvez ouvrir un nouveau compte Carpe Diem, vide, pour ce navigateur. Rien n’est créé sans votre choix.",
                )}
              </p>
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void mint(record, true)}
              >
                {t("Open a new, empty account", "Ouvrir un nouveau compte, vide")}
              </button>
            </div>
          ) : record.key ? (
            <p className="quiet">
              {t("Key", "Clé")} {record.key.prefix} ·{" "}
              {t(
                `valid until ${date(record.key.expiresAt)}, renewed while you use this site`,
                `valable jusqu’au ${date(record.key.expiresAt)}, renouvelée tant que vous utilisez ce site`,
              )}
              {record.key.dailyCapCredits !== null &&
                ` · ${t(
                  `at most ${number(record.key.dailyCapCredits)} credits a day`,
                  `au plus ${number(record.key.dailyCapCredits)} crédits par jour`,
                )}`}
            </p>
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void mint(record)}
            >
              {t("Get a Carpe Diem key", "Obtenir une clé Carpe Diem")}
            </button>
          )}
          {confirmRemove ? (
            <div className="actions">
              <button
                className="button danger"
                type="button"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t("Remove this browser", "Retirer ce navigateur")}
              </button>
              <button className="button" type="button" onClick={() => setConfirmRemove(false)}>
                {t("Cancel", "Annuler")}
              </button>
            </div>
          ) : (
            <button className="button" type="button" onClick={() => setConfirmRemove(true)}>
              {t(
                "Stop using this browser as a device",
                "Ne plus utiliser ce navigateur comme appareil",
              )}
            </button>
          )}
        </>
      ) : stage.kind === "idle" ? (
        <>
          <p>
            {t(
              "Make this browser one of your devices to use Sub Rosa here. It gets its own Carpe Diem key with a small daily limit, valid one week and renewed while you use the site. You can revoke it like any other device.",
              "Faites de ce navigateur l’un de vos appareils pour utiliser Sub Rosa ici. Il reçoit sa propre clé Carpe Diem avec une petite limite par jour, valable une semaine et renouvelée tant que vous utilisez le site. Vous pouvez la révoquer comme tout autre appareil.",
            )}
          </p>
          <p className="quiet">
            {t(
              "Only do this on a browser you own. Anyone who can use this browser while you are signed in can spend up to its daily limit.",
              "Ne le faites que sur un navigateur qui vous appartient. Quiconque peut utiliser ce navigateur pendant que vous êtes connecté peut dépenser jusqu’à sa limite par jour.",
            )}
          </p>
          <button
            className="button primary"
            type="button"
            onClick={() => setStage({ kind: "choose" })}
          >
            {t("Use this browser as a device", "Utiliser ce navigateur comme appareil")}
          </button>
        </>
      ) : stage.kind === "pairing" ? (
        <section className="pairing">
          <p>
            {t(
              "In the Sub Rosa app, open Settings, Account, Connect another device, and paste this code. Only an app can admit a browser, not another browser.",
              "Dans l’app Sub Rosa, ouvrez Réglages, Compte, Connecter un autre appareil, et collez ce code. Seule une app peut admettre un navigateur, pas un autre navigateur.",
            )}
          </p>
          <code className="secret">{stage.code}</code>
          <p role="status">
            {busy
              ? t("Adding this browser…", "Ajout de ce navigateur…")
              : t(
                  "Waiting for approval. This code expires in five minutes.",
                  "En attente d’autorisation. Ce code expire dans cinq minutes.",
                )}
          </p>
        </section>
      ) : stage.kind === "recovery" ? (
        <form className="form" onSubmit={(e) => void submitRecovery(e)}>
          <label>
            {t("Recovery key", "Clé de récupération")}
            <input
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
              maxLength={128}
              required
            />
          </label>
          <p className="quiet">
            {t(
              "Your recovery key never leaves this page. Only a value derived from it is sent, which opens nothing.",
              "Votre clé de récupération ne quitte jamais cette page. Seule une valeur dérivée est envoyée, et elle n’ouvre rien.",
            )}
          </p>
          <div className="actions">
            <button className="button primary" type="submit" disabled={busy}>
              {busy
                ? t("Please wait…", "Veuillez patienter…")
                : t("Add this browser", "Ajouter ce navigateur")}
            </button>
            <button className="button" type="button" onClick={() => setStage({ kind: "choose" })}>
              {t("Back", "Retour")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>
            {t(
              "Confirm it is you with something only you have.",
              "Confirmez que c’est vous avec ce que vous seul avez.",
            )}
          </p>
          <div className="actions">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void startPairing()}
            >
              {t("Approve from the app", "Approuver depuis l’app")}
            </button>
            {office?.allowRecovery !== false && (
              <button
                className="button"
                type="button"
                onClick={() => setStage({ kind: "recovery" })}
              >
                {t("Use my recovery key", "Utiliser ma clé de récupération")}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

/** How a device reads in the list: apps and browsers are named differently,
 * and the browser you are using says so. */
export function deviceKindLabel(device: Device, thisDeviceId: string | null | undefined): string {
  if (device.id === thisDeviceId) return t("This browser", "Ce navigateur");
  return device.kind === "browser" ? t("Browser", "Navigateur") : t("App", "App");
}
