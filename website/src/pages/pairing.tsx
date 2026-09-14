import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { decode, decrypt, encode, encrypt } from "../lib/vault";
import { t } from "../lib/i18n";

type Key = Uint8Array<ArrayBuffer>;
function usePairingScope(accountId: string, key?: Key) {
  const scope = useRef(new AbortController());
  // biome-ignore lint/correctness/useExhaustiveDependencies: identity and key changes invalidate in-flight authorizations.
  useEffect(() => {
    if (scope.current.signal.aborted) scope.current = new AbortController();
    const current = scope.current;
    return () => current.abort();
  }, [accountId, key]);
  return scope;
}
let initialFragment =
  typeof location !== "undefined" &&
  location.pathname === "/account/pair" &&
  location.hash.startsWith("#srpair1.")
    ? location.hash.slice(1)
    : "";
if (initialFragment) history.replaceState(null, "", location.pathname + location.search);

export function parsePairCode(code: string, accountId: string) {
  if (!code.startsWith("srpair1.") || code.length > 1024) throw new Error("Invalid pairing code");
  const value = JSON.parse(new TextDecoder().decode(decode(code.slice(8)))) as {
    request_id: string;
    account_id: string;
    secret: string;
  };
  if (
    value.account_id !== accountId ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.request_id)
  )
    throw new Error("Pairing account mismatch");
  const secret = decode(value.secret);
  if (secret.length !== 32) throw new Error("Invalid pairing secret");
  return { ...value, secret };
}
export function PairApproval({ accountId, vaultKey }: { accountId: string; vaultKey: Key }) {
  const scope = usePairingScope(accountId, vaultKey);
  const [code, setCode] = useState(initialFragment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    initialFragment = "";
  }, []);
  const approve = async (e: FormEvent) => {
    e.preventDefault();
    const current = scope.current;
    if (current.signal.aborted || busy) return;
    setBusy(true);
    setError("");
    let secret: Key | undefined;
    try {
      const parsed = parsePairCode(code.trim(), accountId);
      secret = parsed.secret;
      const envelope = await encrypt(
        secret,
        { v: 1, key: encode(vaultKey) },
        `subrosa:pairing:v1:${accountId}:${parsed.request_id}`,
      );
      if (current.signal.aborted) return;
      await api(`/api/v1/pairing/${parsed.request_id}/approve`, {
        signal: current.signal,
        method: "POST",
        body: JSON.stringify({ envelope }),
      });
      if (current.signal.aborted) return;
      setCode("");
      setDone(true);
    } catch {
      if (current.signal.aborted) return;
      setError(
        t(
          "This code has expired or could not be verified. Start again on the device you want to connect.",
          "Ce code a expiré ou n’a pas pu être vérifié. Recommencez depuis l’appareil à connecter.",
        ),
      );
    } finally {
      secret?.fill(0);
      if (!current.signal.aborted) setBusy(false);
    }
  };
  return (
    <article className="card">
      <h2>{t("Authorize a new device", "Autoriser un nouvel appareil")}</h2>
      {done ? (
        <p className="notice" role="status">
          {t(
            "Authorization sent. Return to your new device to finish.",
            "Autorisation envoyée. Retournez sur votre nouvel appareil pour terminer.",
          )}
        </p>
      ) : (
        <form className="form" onSubmit={(e) => void approve(e)}>
          <p>
            {t(
              "Only approve a code from a device you are connecting yourself. Your vault key will be encrypted for that device.",
              "Autorisez uniquement un code provenant d’un appareil que vous connectez vous-même. Votre clé de coffre sera chiffrée pour cet appareil.",
            )}
          </p>
          <label>
            {t("Pairing code", "Code d’association")}
            <input
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              type="password"
              maxLength={1024}
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" type="submit" disabled={busy}>
            {t("Authorize this device", "Autoriser cet appareil")}
          </button>
        </form>
      )}
    </article>
  );
}

export function PairReceiver({
  accountId,
  onOpen,
}: {
  accountId: string;
  onOpen: (key: Key) => void;
}) {
  const scope = usePairingScope(accountId);
  const [code, setCode] = useState("");
  const [requestId, setRequestId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const secretRef = useRef<Key | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the previous account's pending secret when identity changes.
  useEffect(() => {
    setCode("");
    setRequestId("");
    return () => {
      secretRef.current?.fill(0);
      secretRef.current = null;
    };
  }, [accountId]);
  const start = async () => {
    const current = scope.current;
    if (current.signal.aborted || busy) return;
    setBusy(true);
    setError("");
    const id = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    try {
      await api(`/api/v1/pairing`, {
        method: "POST",
        body: JSON.stringify({ request_id: id }),
        signal: current.signal,
      });
      if (current.signal.aborted) {
        secret.fill(0);
        return;
      }
      secretRef.current?.fill(0);
      secretRef.current = secret;
      setCode(
        `srpair1.${encode(new TextEncoder().encode(JSON.stringify({ request_id: id, account_id: accountId, secret: encode(secret) })))}`,
      );
      setRequestId(id);
    } catch {
      secret.fill(0);
      if (current.signal.aborted) return;
      setError(
        t(
          "Pairing is unavailable. Try again or use your recovery kit.",
          "L’association est indisponible. Réessayez ou utilisez votre kit de récupération.",
        ),
      );
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    if (!requestId) return;
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      if (stopped) return;
      if (Date.now() - started > 300000) {
        setError(
          t(
            "The code expired. Start a new request.",
            "Le code a expiré. Démarrez une nouvelle demande.",
          ),
        );
        setCode("");
        setRequestId("");
        secretRef.current?.fill(0);
        secretRef.current = null;
        return;
      }
      let received: Key | undefined;
      let transferred = false;
      try {
        const result = await api<{ envelope: string | null; expires_at: string }>(
          `/api/v1/pairing/${requestId}`,
          { signal: controller.signal },
        );
        if (stopped) return;
        if (result.envelope && secretRef.current) {
          const value = await decrypt<{ v: number; key: string }>(
            secretRef.current,
            result.envelope,
            `subrosa:pairing:v1:${accountId}:${requestId}`,
          );
          if (value.v !== 1) throw new Error("Invalid vault version");
          received = decode(value.key);
          if (received.length !== 32) throw new Error("Invalid vault key");
          if (stopped) return;
          await api(`/api/v1/pairing/${requestId}`, {
            method: "DELETE",
            signal: controller.signal,
          });
          if (stopped) return;
          secretRef.current?.fill(0);
          secretRef.current = null;
          setCode("");
          onOpen(received);
          transferred = true;
          return;
        }
      } catch {
        if (!stopped)
          setError(
            t(
              "Waiting for your other device. Keep this page open.",
              "En attente de votre autre appareil. Gardez cette page ouverte.",
            ),
          );
      } finally {
        if (!transferred) received?.fill(0);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [requestId, accountId, onOpen]);
  const link = code ? `${location.origin}/account/pair#${code}` : "";
  return (
    <section className="pairing">
      <h3>{t("Use another device", "Utiliser un autre appareil")}</h3>
      <p>
        {t(
          "Open this QR code on a device where your vault is already unlocked, or copy the pairing code into Account, Devices.",
          "Ouvrez ce QR code sur un appareil où votre coffre est déjà déverrouillé, ou copiez le code dans Compte, Appareils.",
        )}
      </p>
      {code ? (
        <>
          <QRCodeSVG
            value={link}
            size={224}
            marginSize={4}
            title={t("Pairing QR code", "QR code d’association")}
          />
          <details>
            <summary>{t("Show pairing code", "Afficher le code d’association")}</summary>
            <code className="secret">{code}</code>
          </details>
          <p role="status">
            {t(
              "Waiting for approval. This code expires in five minutes.",
              "En attente d’autorisation. Ce code expire dans cinq minutes.",
            )}
          </p>
        </>
      ) : (
        <button className="button" type="button" disabled={busy} onClick={() => void start()}>
          {t("Connect using another device", "Se connecter avec un autre appareil")}
        </button>
      )}
      {error && (
        <p role="status" className="notice">
          {error}
        </p>
      )}
    </section>
  );
}
