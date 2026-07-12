import { useCallback, useEffect, useState } from "react";
import {
  videomakerAccountStatus,
  videomakerActivate,
  videomakerDeactivate,
  videomakerGetSettings,
  videomakerSetBaseUrl,
  type VideomakerAccountStatusDto,
  type VideomakerSettingsDto,
} from "../../lib/tauri";
import { messageFromError } from "../../lib/errors";

type ActivationState = { kind: "idle" } | { kind: "confirming" } | { kind: "working" };

/** Best-effort DIEM figure from the raw balance body (shape is Videomaker's). */
export function diemBalanceOf(balance: Record<string, unknown> | null): number | null {
  if (!balance) return null;
  for (const key of ["available_diem", "balance_diem", "diem", "balance", "available"]) {
    const value = balance[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Film studio account controls: one-click activation (consent-gated), account
 * status (DIEM balance under the user's own Carpe Diem key), deactivation,
 * and the base URL escape hatch. Films are produced by Videomaker Studio and
 * billed in DIEM to the user's Carpe Diem key — this section is where that
 * link is made and unmade.
 */
export function VideomakerSettings() {
  const [settings, setSettings] = useState<VideomakerSettingsDto | null>(null);
  const [account, setAccount] = useState<VideomakerAccountStatusDto | null>(null);
  const [activation, setActivation] = useState<ActivationState>({ kind: "idle" });
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [notice, setNotice] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await videomakerGetSettings();
      setSettings(next);
      if (next.activated) {
        try {
          setAccount(await videomakerAccountStatus());
        } catch {
          // Account status is display-only; the section stays usable offline.
          setAccount(null);
        }
      } else {
        setAccount(null);
      }
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (settings && baseUrlDraft === "") {
      setBaseUrlDraft(settings.baseUrl);
    }
  }, [settings, baseUrlDraft]);

  const activate = useCallback(async () => {
    setActivation({ kind: "working" });
    try {
      const next = await videomakerActivate();
      setSettings(next);
      setNotice("Film production is ready.");
      setActivation({ kind: "idle" });
      await refresh();
    } catch (err) {
      setNotice(messageFromError(err));
      setActivation({ kind: "idle" });
    }
  }, [refresh]);

  const deactivate = useCallback(async () => {
    setActivation({ kind: "working" });
    try {
      const next = await videomakerDeactivate();
      setSettings(next);
      setAccount(null);
      setNotice("Film production is off. Your key was removed from the studio.");
    } catch (err) {
      setNotice(messageFromError(err));
    }
    setActivation({ kind: "idle" });
  }, []);

  const saveBaseUrl = useCallback(async () => {
    try {
      const next = await videomakerSetBaseUrl(baseUrlDraft);
      setSettings(next);
      setNotice("Base URL saved.");
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [baseUrlDraft]);

  const resetBaseUrl = useCallback(async () => {
    if (!settings) return;
    setBaseUrlDraft(settings.defaultBaseUrl);
    try {
      const next = await videomakerSetBaseUrl(settings.defaultBaseUrl);
      setSettings(next);
      setNotice("Base URL reset to the default.");
    } catch (err) {
      setNotice(messageFromError(err));
    }
  }, [settings]);

  const activated = settings?.activated ?? false;
  const hasCarpeDiemKey = settings?.hasCarpeDiemKey ?? false;
  const busy = activation.kind === "working";
  const balanceDiem = diemBalanceOf(account?.balance ?? null);
  const canSaveBaseUrl =
    baseUrlDraft.trim().length > 0 && baseUrlDraft.trim() !== settings?.baseUrl;

  return (
    <div className="settings-group">
      <h2 className="settings-group-heading">Film studio</h2>
      <div className="settings-card">
        <div className="settings-rows">
          {/* Activation */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Film production</h3>
              <p className="settings-row-description">
                Produce complete short films (script, storyboard, shots, final cut) with the
                Videomaker studio. All generation is billed in DIEM to your Carpe Diem key.
              </p>
              {!activated ? (
                <p className="settings-row-description">
                  Activating shares your Carpe Diem key with the Videomaker studio, which stores it
                  encrypted and bills film productions to it. Consider a dedicated key with a
                  limited balance.
                </p>
              ) : (
                <p className="settings-row-description settings-row-substatus" role="status">
                  Active
                  {settings?.walletAddress
                    ? ` · studio account ${shortAddress(settings.walletAddress)}`
                    : ""}
                  {balanceDiem !== null ? ` · ${balanceDiem.toFixed(1)} DIEM available` : ""}
                </p>
              )}
              {!hasCarpeDiemKey && !activated ? (
                <p className="settings-row-description settings-row-substatus">
                  Add your Carpe Diem key in the Carpe Diem settings tab first.
                </p>
              ) : null}
            </div>
            <div className="settings-row-control">
              {!activated && activation.kind === "idle" ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={!hasCarpeDiemKey}
                  onClick={() => setActivation({ kind: "confirming" })}
                >
                  Activate film production
                </button>
              ) : null}
              {!activated && activation.kind === "confirming" ? (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => void activate()}>
                    Share key and activate
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setActivation({ kind: "idle" })}
                  >
                    Cancel
                  </button>
                </>
              ) : null}
              {!activated && activation.kind === "working" ? (
                <button type="button" className="btn btn-secondary" disabled>
                  Activating…
                </button>
              ) : null}
              {activated ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void deactivate()}
                >
                  {busy ? "Working…" : "Deactivate"}
                </button>
              ) : null}
            </div>
          </div>

          {/* Base URL (escape hatch) */}
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Studio URL</h3>
              <p className="settings-row-description">
                The Videomaker studio endpoint. Leave the default unless you were told to change it.
              </p>
            </div>
            <div className="settings-row-control settings-secret-control">
              <input
                className="settings-secret-input"
                type="text"
                value={baseUrlDraft}
                autoComplete="off"
                spellCheck={false}
                placeholder={settings?.defaultBaseUrl ?? "https://…"}
                aria-label="Videomaker base URL"
                onChange={(event) => setBaseUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSaveBaseUrl) void saveBaseUrl();
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!canSaveBaseUrl}
                onClick={() => void saveBaseUrl()}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void resetBaseUrl()}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </div>
      {notice ? <p className="settings-row-description settings-row-substatus">{notice}</p> : null}
    </div>
  );
}
