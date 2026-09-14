import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  readChanges,
  revisionHeads,
  setAccountScope,
  type Account,
  type Change,
  type Device,
  type VaultRecord,
} from "../lib/api";
import { date, number, t } from "../lib/i18n";
import { decryptObject, prepareObject, prepareVault, sendObject, unlockVault } from "../lib/vault";
import { PairApproval, PairReceiver } from "./pairing";

type Key = Uint8Array<ArrayBuffer>;
const SETTINGS_ID = "00000000-0000-4000-8000-000000000001";
function useLifetime() {
  const active = useRef(new AbortController());
  useEffect(() => {
    active.current = new AbortController();
    return () => active.current.abort();
  }, []);
  return active;
}
function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 401)
    return t(
      "Your session has expired. Sign in again.",
      "Votre session a expiré. Connectez-vous à nouveau.",
    );
  if (error instanceof ApiError && error.status === 409)
    return t(
      "Another device changed this information. Refresh before trying again.",
      "Un autre appareil a modifié ces informations. Actualisez avant de réessayer.",
    );
  if (error instanceof ApiError && error.status === 403)
    return t(
      "Sign in again to confirm this action.",
      "Connectez-vous à nouveau pour confirmer cette action.",
    );
  return t(
    "We could not complete this action. Check your connection and try again.",
    "Cette action n’a pas abouti. Vérifiez votre connexion et réessayez.",
  );
}

export function AccountPage({ path }: { path: string }) {
  const lifetime = useLifetime();
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [vaultKey, setVaultKey] = useState<Key | null>(null);
  const keyRef = useRef<Key | null>(null);
  const lock = useCallback(() => {
    keyRef.current?.fill(0);
    keyRef.current = null;
    setVaultKey(null);
  }, []);
  const open = useCallback(
    (key: Key) => {
      if (lifetime.current.signal.aborted) {
        key.fill(0);
        return;
      }
      lock();
      keyRef.current = key;
      setVaultKey(key);
    },
    [lock, lifetime],
  );
  useEffect(() => {
    const controller = new AbortController();
    api<Account>("/api/v1/me", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setAccountScope(value.id);
          setAccount(value);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted && (!(err instanceof ApiError) || err.status !== 401))
          setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      lock();
    };
  }, [lock]);
  useEffect(() => {
    const changed = () => {
      lifetime.current.abort();
      lock();
      setAccount(null);
      setError(
        t(
          "The account changed in another tab. Sign in again.",
          "Le compte a changé dans un autre onglet. Connectez-vous à nouveau.",
        ),
      );
    };
    window.addEventListener("subrosa:account-session-changed", changed);
    return () => window.removeEventListener("subrosa:account-session-changed", changed);
  }, [lock, lifetime]);
  useEffect(() => {
    if (!vaultKey) return;
    let lastActivity = Date.now();
    const activity = () => {
      if (Date.now() - lastActivity > 15 * 60 * 1000) lock();
      else lastActivity = Date.now();
    };
    const interval = setInterval(() => {
      if (Date.now() - lastActivity > 15 * 60 * 1000) lock();
    }, 30000);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("focus", activity);
    return () => {
      clearInterval(interval);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("focus", activity);
    };
  }, [vaultKey, lock]);
  const logout = async () => {
    lock();
    try {
      await api("/auth/logout", { method: "POST" });
      lock();
      setAccount(null);
      setAccountScope(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  if (loading)
    return (
      <section className="page wrap" aria-busy="true">
        <p role="status">{t("Opening your account…", "Ouverture de votre compte…")}</p>
      </section>
    );
  if (!account)
    return (
      <section className="page wrap">
        <div className="prose">
          <p className="eyebrow">Sub Rosa</p>
          <h1>{t("Your space, together.", "Votre espace, réuni.")}</h1>
          <p className="lede">
            {t(
              "Sign in to connect your devices, manage Carpe Diem and find your work again.",
              "Connectez-vous pour réunir vos appareils, gérer Carpe Diem et retrouver votre travail.",
            )}
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <a
              className="button primary"
              href={`/auth/login?intent=signin&return_to=${encodeURIComponent(path.startsWith("/account/devices/verify") ? path : "/account")}`}
            >
              {t("Sign in", "Se connecter")}
            </a>
            <a className="button" href="/auth/login?intent=signup&return_to=%2Faccount">
              {t("Create an account", "Créer un compte")}
            </a>
          </div>
          <p className="quiet">
            {t(
              "Your Carpe Diem account remains separate. Downloading the app does not require an account.",
              "Votre compte Carpe Diem reste distinct. Vous pouvez télécharger l’app sans créer de compte.",
            )}
          </p>
        </div>
      </section>
    );
  const section = path.split("?")[0];
  const tabs = [
    ["/account", t("Overview", "Vue d’ensemble")],
    ["/account/provider", "Carpe Diem"],
    ["/account/usage", t("Usage", "Consommation")],
    ["/account/devices", t("Devices", "Appareils")],
    ["/account/security", t("Security", "Sécurité")],
  ];
  return (
    <section className="page wrap">
      <div className="row">
        <div>
          <p className="eyebrow">{account.email}</p>
          <h1>{t("Your account", "Votre compte")}</h1>
        </div>
        <button className="button" type="button" onClick={() => void logout()}>
          {t("Sign out", "Se déconnecter")}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="account-layout">
        <nav className="account-nav" aria-label={t("Account navigation", "Navigation du compte")}>
          {tabs.map(([href, label]) => (
            <a key={href} href={href} aria-current={section === href ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="stack">
          {section === "/account/devices/verify" ? (
            <VerifyDevice />
          ) : section === "/account/devices" ? (
            <>
              <Devices />
              {vaultKey ? (
                <PairApproval accountId={account.id} vaultKey={vaultKey} />
              ) : (
                <VaultGate account={account} onOpen={open} />
              )}
            </>
          ) : section === "/account/security" ? (
            <Security
              account={account}
              onDeleted={() => {
                lock();
                setAccountScope(null);
                setAccount(null);
              }}
              lock={lock}
              unlocked={!!vaultKey}
            />
          ) : (
            <>
              {!vaultKey ? (
                <VaultGate account={account} onOpen={open} />
              ) : (
                <div className="notice row">
                  <span>
                    {t(
                      "Your vault is open in this tab.",
                      "Votre coffre est ouvert dans cet onglet.",
                    )}
                  </span>
                  <button className="button" type="button" onClick={lock}>
                    {t("Lock", "Verrouiller")}
                  </button>
                </div>
              )}
              {section === "/account/pair" && vaultKey && (
                <PairApproval accountId={account.id} vaultKey={vaultKey} />
              )}
              {section === "/account/provider" && vaultKey ? (
                <Provider account={account} vaultKey={vaultKey} />
              ) : section === "/account/usage" && vaultKey ? (
                <Usage account={account} vaultKey={vaultKey} />
              ) : section === "/account" ? (
                <>
                  <article className="card">
                    <h2>{t("Pick up the thread", "Reprenez le fil")}</h2>
                    <p>
                      {t(
                        "Connect the same account in the app on your Mac, PC or iPhone. Your recovery kit opens your encrypted vault on a new device.",
                        "Connectez le même compte dans l’app sur votre Mac, PC ou iPhone. Votre kit de récupération ouvre votre coffre chiffré sur un nouvel appareil.",
                      )}
                    </p>
                    <a className="text-link" href="/downloads">
                      {t("Download the app", "Télécharger l’app")} →
                    </a>
                  </article>
                  <article className="card">
                    <h2>
                      {t("One Carpe Diem configuration", "Une seule configuration Carpe Diem")}
                    </h2>
                    <p>
                      {t(
                        "Save your key in your encrypted vault, then restore it from your approved apps.",
                        "Enregistrez votre clé dans votre coffre chiffré, puis restaurez-la depuis vos applications autorisées.",
                      )}
                    </p>
                    <a href="/account/provider" className="text-link">
                      {t("Manage Carpe Diem", "Gérer Carpe Diem")} →
                    </a>
                  </article>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function VaultGate({ account, onOpen }: { account: Account; onOpen: (key: Key) => void }) {
  const lifetime = useLifetime();
  const [record, setRecord] = useState<VaultRecord | null | undefined>(undefined);
  const [prepared, setPrepared] = useState<Awaited<ReturnType<typeof prepareVault>> | null>(null);
  const preparedRef = useRef<Awaited<ReturnType<typeof prepareVault>> | null>(null);
  const [recovery, setRecovery] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api<VaultRecord>("/api/v1/vault", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setRecord(value);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) setRecord(null);
        else setError(errorMessage(err));
      });
    return () => {
      controller.abort();
      preparedRef.current?.key.fill(0);
    };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const signal = lifetime.current.signal;
    try {
      if (record) {
        const key = await unlockVault(account.id, recovery, record);
        if (signal.aborted) {
          key.fill(0);
          return;
        }
        setRecovery("");
        onOpen(key);
      } else if (prepared && saved && recovery.trim() === prepared.recoveryCode) {
        try {
          await api("/api/v1/vault", {
            method: "PUT",
            body: JSON.stringify({ expected_version: 0, envelope: prepared.envelope }),
            signal,
          });
        } catch (error) {
          // A lost acknowledgement must not strand the recovery kit we just saved.
          if (signal.aborted) return;
          const actual = await api<VaultRecord>("/api/v1/vault", { signal }).catch(() => null);
          if (actual?.envelope !== prepared.envelope) throw error;
        }
        if (signal.aborted) return;
        const key = prepared.key.slice();
        preparedRef.current?.key.fill(0);
        preparedRef.current = null;
        setPrepared(null);
        onOpen(key);
      } else if (!prepared) {
        const next = await prepareVault(account.id);
        if (signal.aborted) {
          next.key.fill(0);
          return;
        }
        preparedRef.current = next;
        setPrepared(next);
      }
    } catch (err) {
      if (signal.aborted) return;
      setError(
        record
          ? t(
              "This recovery key could not open your vault. Check the key and try again.",
              "Cette clé de récupération n’a pas pu ouvrir votre coffre. Vérifiez-la et réessayez.",
            )
          : errorMessage(err),
      );
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <article className="card">
      <h2>
        {record
          ? t("Open your vault", "Ouvrir votre coffre")
          : t("Protect your workspace", "Protéger votre espace")}
      </h2>
      <p>
        {t(
          "Your notes and Carpe Diem key are encrypted before they leave your device. Signing in and opening the vault are separate protections.",
          "Vos notes et votre clé Carpe Diem sont chiffrées avant de quitter votre appareil. La connexion et l’ouverture du coffre sont deux protections distinctes.",
        )}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {record === undefined ? (
        <p role="status">{t("Checking your vault…", "Vérification de votre coffre…")}</p>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          {record ? (
            <label>
              {t("Recovery key", "Clé de récupération")}
              <input
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
                required
              />
            </label>
          ) : prepared ? (
            <>
              <p>
                {t(
                  "Save this recovery key in your password manager. Without it or an unlocked app, your encrypted data cannot be recovered.",
                  "Enregistrez cette clé de récupération dans votre gestionnaire de mots de passe. Sans elle ni application déverrouillée, vos données chiffrées ne pourront pas être récupérées.",
                )}
              </p>
              <code className="secret">{prepared.recoveryCode}</code>
              <label>
                {t(
                  "Paste the saved recovery key to confirm",
                  "Collez la clé sauvegardée pour confirmer",
                )}
                <input
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={recovery}
                  onChange={(e) => setRecovery(e.target.value)}
                  required
                  maxLength={128}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                  required
                />
                {t(
                  "I saved my recovery key somewhere safe.",
                  "J’ai enregistré ma clé de récupération en lieu sûr.",
                )}
              </label>
            </>
          ) : (
            <p className="muted">
              {t(
                "A recovery key will be shown once. Keep it somewhere safe before continuing.",
                "Une clé de récupération sera affichée une seule fois. Conservez-la en lieu sûr avant de continuer.",
              )}
            </p>
          )}
          <button
            type="submit"
            className="button primary"
            disabled={busy || (!!prepared && (!saved || recovery.trim() !== prepared.recoveryCode))}
          >
            {busy
              ? t("Please wait…", "Veuillez patienter…")
              : record
                ? t("Open vault", "Ouvrir le coffre")
                : prepared
                  ? t("Activate my vault", "Activer mon coffre")
                  : t("Create my recovery kit", "Créer mon kit de récupération")}
          </button>
        </form>
      )}
      {record && <PairReceiver accountId={account.id} onOpen={onOpen} />}
    </article>
  );
}

function VerifyDevice() {
  const [code, setCode] = useState(new URLSearchParams(location.search).get("code") ?? "");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/v1/device-login/approve", {
        method: "POST",
        body: JSON.stringify({ user_code: code.trim() }),
      });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card">
      <h2>{t("Connect your app", "Connecter votre app")}</h2>
      {done ? (
        <p role="status">
          {t(
            "Your app is connected. You can return to it now.",
            "Votre app est connectée. Vous pouvez y retourner.",
          )}
        </p>
      ) : (
        <form className="form" onSubmit={(e) => void submit(e)}>
          <p>
            {t(
              "Only approve a code shown in an app you are connecting yourself. This grants that app access to your account’s encrypted data.",
              "Autorisez uniquement un code affiché dans une app que vous connectez vous-même. Cette autorisation lui donne accès aux données chiffrées de votre compte.",
            )}
          </p>
          <label>
            {t("Code shown in the app", "Code affiché dans l’app")}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              maxLength={32}
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy} type="submit">
            {t("Authorize this app", "Autoriser cette app")}
          </button>
        </form>
      )}
    </article>
  );
}

function Devices() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setDevices(await api<Device[]>("/api/v1/devices"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await api(`/api/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConfirm(null);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="card">
      <h2>{t("Your devices", "Vos appareils")}</h2>
      <p className="muted">
        {t(
          "Revoking an app stops its access to new data. It cannot erase data or a Carpe Diem key already downloaded.",
          "Révoquer une app bloque son accès aux nouvelles données. Cela n’efface pas les données ni une clé Carpe Diem déjà téléchargées.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{t("Loading…", "Chargement…")}</p>
      ) : devices.length === 0 ? (
        <p>{t("No apps connected yet.", "Aucune app connectée pour le moment.")}</p>
      ) : (
        <div className="stack">
          {devices.map((device) => (
            <div className="row" key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <p className="quiet">
                  {device.last_seen_at ? date(device.last_seen_at) : date(device.created_at)}
                  {device.revoked_at && ` · ${t("Revoked", "Révoqué")}`}
                </p>
              </div>
              {!device.revoked_at &&
                (confirm === device.id ? (
                  <div className="actions">
                    <button
                      className="button danger"
                      disabled={busy}
                      onClick={() => void revoke(device.id)}
                      type="button"
                    >
                      {t("Confirm revocation", "Confirmer la révocation")}
                    </button>
                    <button className="button" onClick={() => setConfirm(null)} type="button">
                      {t("Cancel", "Annuler")}
                    </button>
                  </div>
                ) : (
                  <button className="button" onClick={() => setConfirm(device.id)} type="button">
                    {t("Revoke", "Révoquer")}
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function Provider({ account, vaultKey }: { account: Account; vaultKey: Key }) {
  const lifetime = useLifetime();
  const [reload, setReload] = useState(0);
  const [key, setKey] = useState("");
  const [base, setBase] = useState("https://carpe-diem.xyz/api/operator/router");
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [resolved, setResolved] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const pending = useRef<string | null>(null);
  const [awaitingReceipt, setAwaitingReceipt] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is an explicit request to fetch the latest heads.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReady(false);
    setError("");
    setConflicted(false);
    setResolved([]);
    readChanges(controller.signal, "settings")
      .then(async (changes) => {
        const matches = changes.filter((x) => x.object_id === SETTINGS_ID && x.kind === "settings");
        const heads = revisionHeads(matches);
        // Never silently choose a winning secret when two devices edited it offline.
        if (heads.length > 1) {
          for (const head of heads) {
            await decryptObject(vaultKey, account.id, head);
            if (controller.signal.aborted) return;
          }
          setConflicted(true);
          setParent(heads[0].revision);
          setResolved(heads.slice(1).map((head) => head.revision));
          setReady(true);
          return;
        }
        const last = heads[0];
        if (last) {
          const value = await decryptObject(vaultKey, account.id, last);
          if (controller.signal.aborted) return;
          setParent(last.revision);
          if (!last.deleted && value.table === "carpe_diem_settings") {
            setConfigured(typeof value.row.api_key === "string" && value.row.api_key.length > 0);
            if (typeof value.row.base_url === "string") setBase(value.row.base_url);
          }
        }
        if (!controller.signal.aborted) setReady(true);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [account.id, vaultKey, reload]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    const signal = lifetime.current.signal;
    try {
      const url = new URL(base);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error("Invalid provider URL");
      if (!key.startsWith("cdm_") || key.length > 4096) throw new Error("Invalid provider key");
      if (!pending.current)
        pending.current = await prepareObject(
          vaultKey,
          account.id,
          SETTINGS_ID,
          "settings",
          "carpe_diem_settings",
          { id: SETTINGS_ID, api_key: key, base_url: url.href.replace(/\/$/, "") },
          parent,
          resolved,
        );
      if (signal.aborted) {
        pending.current = null;
        return;
      }
      setAwaitingReceipt(true);
      const result = await sendObject(pending.current, signal);
      if (signal.aborted) return;
      const value = result.results[0];
      if (!value || value.conflict) {
        setConflicted(true);
        setReady(false);
        throw new ApiError("conflict", "Conflict", 409);
      }
      pending.current = null;
      setAwaitingReceipt(false);
      setParent(value.revision);
      setResolved([]);
      setConflicted(false);
      setKey("");
      setConfigured(true);
      setSaved(true);
    } catch (err) {
      if (!signal.aborted) setError(errorMessage(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <article className="card">
      <h2>Carpe Diem</h2>
      {(error || conflicted) && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            pending.current = null;
            setAwaitingReceipt(false);
            setReload((value) => value + 1);
          }}
        >
          {t("Reload latest versions", "Recharger les dernières versions")}
        </button>
      )}
      {conflicted && (
        <p className="notice">
          {t(
            "Your devices saved different configurations. Enter a replacement key and check its URL to replace all versions currently received.",
            "Vos appareils ont enregistré des configurations différentes. Saisissez une clé de remplacement et vérifiez son URL pour remplacer toutes les versions reçues.",
          )}
        </p>
      )}
      <p>
        {configured
          ? t(
              "A key is saved in your vault. It is never displayed here.",
              "Une clé est enregistrée dans votre coffre. Elle n’est jamais réaffichée ici.",
            )
          : t(
              "Add your key once, then restore it in your apps.",
              "Ajoutez votre clé une fois, puis restaurez-la dans vos apps.",
            )}
      </p>
      <form className="form" onSubmit={(e) => void submit(e)}>
        <label>
          {configured ? t("Replacement API key", "Nouvelle clé API") : t("API key", "Clé API")}
          <input
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="cdm_…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
            maxLength={4096}
            disabled={awaitingReceipt}
          />
        </label>
        <details>
          <summary>{t("Advanced settings", "Réglages avancés")}</summary>
          <label>
            {t("Carpe Diem URL", "URL Carpe Diem")}
            <input
              type="url"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              required
              maxLength={2048}
              disabled={awaitingReceipt}
            />
          </label>
        </details>
        <p className="muted">
          {t(
            "Saving encrypts your key. Its validity and balance are checked in the app when you restore it; saving here does not spend credits.",
            "L’enregistrement chiffre votre clé. Sa validité et son solde sont vérifiés dans l’app lors de la restauration ; enregistrer ici ne consomme pas de crédits.",
          )}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="notice" role="status">
            {t(
              "Saved in your encrypted vault. Open Account in the app to restore this configuration.",
              "Enregistrée dans votre coffre chiffré. Ouvrez Compte dans l’app pour restaurer cette configuration.",
            )}
          </p>
        )}
        <button type="submit" className="button primary" disabled={loading || busy || !ready}>
          {awaitingReceipt
            ? t("Retry confirmation", "Réessayer la confirmation")
            : t("Save encrypted key", "Enregistrer la clé chiffrée")}
        </button>
        <a className="text-link" href="https://carpe-diem.xyz" target="_blank" rel="noreferrer">
          {t("Open Carpe Diem", "Ouvrir Carpe Diem")} ↗
        </a>
      </form>
    </article>
  );
}

function Usage({ account, vaultKey }: { account: Account; vaultKey: Key }) {
  const lifetime = useLifetime();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [balance, setBalance] = useState<Record<string, unknown> | null>(null);
  const [turns, setTurns] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    const signal = lifetime.current.signal;
    try {
      const changes = await readChanges(signal, "usage");
      const latest = new Map<string, Change>();
      for (const change of changes)
        if (change.kind === "usage") latest.set(change.object_id, change);
      const output = [];
      const balances: Record<string, unknown>[] = [];
      const observedTurns: Record<string, unknown>[] = [];
      for (const change of latest.values()) {
        const decoded = await decryptObject(vaultKey, account.id, change);
        if (signal.aborted) return;
        if (!decoded.deleted && decoded.table === "account_usage") output.push(decoded.row);
        if (!decoded.deleted && decoded.table === "account_turn_usage")
          observedTurns.push(decoded.row);
        if (
          !decoded.deleted &&
          decoded.table === "account_billing" &&
          typeof decoded.row.sampled_at === "string" &&
          Number.isFinite(Date.parse(decoded.row.sampled_at))
        )
          balances.push(decoded.row);
      }
      if (signal.aborted) return;
      setRows(output.sort((a, b) => String(b.day).localeCompare(String(a.day))));
      setTurns(observedTurns);
      setBalance(
        balances.sort(
          (a, b) => Date.parse(String(b.sampled_at)) - Date.parse(String(a.sampled_at)),
        )[0] ?? null,
      );
      setUpdated(new Date().toISOString());
    } catch (err) {
      if (!signal.aborted) setError(errorMessage(err));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [account.id, vaultKey, lifetime]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const sum = (field: string) =>
    turns.reduce(
      (total, row) =>
        typeof row[field] === "number" && Number.isFinite(row[field]) && row[field] >= 0
          ? total + row[field]
          : total,
      0,
    );
  const reportedCosts = turns.filter(
    (row) => typeof row.cost_usdc_micro === "number" && Number.isFinite(row.cost_usdc_micro),
  );
  return (
    <article className="card">
      <div className="row">
        <h2>{t("Your usage", "Votre consommation")}</h2>
        <button className="button" disabled={busy} onClick={() => void refresh()} type="button">
          {t("Refresh", "Actualiser")}
        </button>
      </div>
      <p className="muted">
        {t(
          "Activity received from your apps. It may be incomplete and does not replace your Carpe Diem statement. Open an app to update provider balances.",
          "Activité reçue de vos apps. Elle peut être incomplète et ne remplace pas votre relevé Carpe Diem. Ouvrez une app pour actualiser les soldes du fournisseur.",
        )}
      </p>
      {balance && (
        <div className="notice">
          <strong>{t("Last verified balance", "Dernier solde vérifié")}</strong>
          <p>
            {typeof balance.available_credits === "number"
              ? number(balance.available_credits, 6)
              : t("Unavailable", "Indisponible")}{" "}
            {t("available credits", "crédits disponibles")}
          </p>
          <p className="quiet">{date(String(balance.sampled_at))}</p>
        </div>
      )}
      {turns.length > 0 && (
        <>
          <div className="grid">
            <div className="notice">
              <strong>{number(sum("prompt_tokens"))}</strong>
              <p>{t("Observed input tokens", "Tokens d’entrée observés")}</p>
            </div>
            <div className="notice">
              <strong>{number(sum("completion_tokens"))}</strong>
              <p>{t("Observed output tokens", "Tokens de sortie observés")}</p>
            </div>
            <div className="notice">
              <strong>
                {reportedCosts.length
                  ? `${number(sum("cost_usdc_micro") / 1e6, 6)} USDC`
                  : t("Unavailable", "Indisponible")}
              </strong>
              <p>
                {t("Reported cost, partial coverage", "Dépense rapportée, couverture partielle")}
              </p>
            </div>
          </div>
          <p className="quiet">
            {t(
              "These totals include only the operator measurements your apps received and saved. Missing reports and interrupted sessions can leave gaps. Consult Carpe Diem for the authoritative statement.",
              "Ces totaux incluent uniquement les mesures de l’opérateur reçues et enregistrées par vos apps. Des relevés absents ou des sessions interrompues peuvent laisser des lacunes. Consultez Carpe Diem pour le relevé de référence.",
            )}
          </p>
        </>
      )}
      <p className="quiet">
        {t(
          "Request attempts and transferred bytes are reported by your apps. They are not billed tokens or a financial ledger.",
          "Les apps comptent les tentatives de requête et les octets transférés. Ces mesures ne sont ni des tokens facturés ni un relevé financier.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy ? (
        <p role="status">
          {t("Loading encrypted activity…", "Chargement de l’activité chiffrée…")}
        </p>
      ) : rows.length === 0 ? (
        <div className="notice">
          <strong>{t("No activity synced yet", "Aucune activité synchronisée")}</strong>
          <p>
            {t(
              "Your first synced requests will appear here. Missing data is not counted as zero usage.",
              "Vos premières requêtes synchronisées apparaîtront ici. Une donnée absente n’est pas comptée comme une consommation nulle.",
            )}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Date", "Date")}</th>
                <th>{t("Model", "Modèle")}</th>
                <th>{t("Requests", "Requêtes")}</th>
                <th>{t("Sent bytes", "Octets envoyés")}</th>
                <th>{t("Received bytes", "Octets reçus")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={String(row.id ?? index)}>
                  <td>
                    {typeof row.day === "string" ? row.day : t("Unavailable", "Indisponible")}
                  </td>
                  <td>{String(row.model ?? t("Unavailable", "Indisponible"))}</td>
                  <td>
                    {typeof row.request_count === "number"
                      ? number(row.request_count)
                      : t("Unavailable", "Indisponible")}
                  </td>
                  <td>
                    {typeof row.request_bytes === "number"
                      ? number(row.request_bytes)
                      : t("Unavailable", "Indisponible")}
                  </td>
                  <td>
                    {typeof row.response_bytes === "number"
                      ? number(row.response_bytes)
                      : t("Unavailable", "Indisponible")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {updated && (
        <p className="quiet">
          {t("Last retrieved: ", "Dernière récupération : ")}
          {date(updated)}
        </p>
      )}
    </article>
  );
}

function Security({
  account,
  onDeleted,
  lock,
  unlocked,
}: {
  account: Account;
  onDeleted: () => void;
  lock: () => void;
  unlocked: boolean;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (confirmation !== account.email) return;
    setBusy(true);
    try {
      await api("/api/v1/me", { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <article className="card">
        <h2>{t("Your recovery kit", "Votre kit de récupération")}</h2>
        <p>
          {t(
            "Keep your recovery key in your password manager. Email recovery restores your account access, not your encrypted data. The support team cannot decrypt your vault.",
            "Conservez votre clé de récupération dans votre gestionnaire de mots de passe. La récupération par e-mail rétablit l’accès au compte, pas aux données chiffrées. L’assistance ne peut pas déchiffrer votre coffre.",
          )}
        </p>
        {unlocked && (
          <button className="button" onClick={lock} type="button">
            {t("Lock this tab", "Verrouiller cet onglet")}
          </button>
        )}
      </article>
      <article className="card">
        <h2>{t("Delete your account", "Supprimer votre compte")}</h2>
        <p>
          {t(
            "This revokes your sessions and deletes your synced data. Local copies may remain on offline devices. Your Carpe Diem account and credits are not deleted. Export your notes from the app first.",
            "Cette action révoque vos sessions et supprime vos données synchronisées. Des copies locales peuvent rester sur les appareils hors ligne. Votre compte Carpe Diem et ses crédits ne sont pas supprimés. Exportez d’abord vos notes depuis l’app.",
          )}
        </p>
        <form className="form" onSubmit={(e) => void remove(e)}>
          <label>
            {t("Enter your email to confirm", "Saisissez votre e-mail pour confirmer")}
            <input
              type="email"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button danger"
            type="submit"
            disabled={busy || confirmation !== account.email}
          >
            {t("Permanently delete my account", "Supprimer définitivement mon compte")}
          </button>
          <a className="text-link" href="/auth/login?intent=signin&return_to=%2Faccount%2Fsecurity">
            {t(
              "Sign in again to confirm a sensitive action",
              "Se reconnecter pour confirmer une action sensible",
            )}
          </a>
        </form>
      </article>
    </>
  );
}
