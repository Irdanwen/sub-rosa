import { useEffect, useId, useState } from "react";
import { placesClearGoogleKey, placesGetSettings, placesSetGoogleKey } from "../../lib/tauri";

/**
 * Place search settings: the optional Google Places key that upgrades the
 * chat's place cards from the keyless OSM data (names, addresses) to ratings,
 * reviews and photos. Mirrors the Carpe Diem key row: keychain storage, only
 * presence crosses IPC, per-request use — nothing to restart.
 */
export function PlacesSettingsSection() {
  const keyInputId = useId();
  const [keyPresent, setKeyPresent] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    placesGetSettings()
      .then((settings) => {
        if (!cancelled) setKeyPresent(settings.googleKeyPresent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const canSave = keyDraft.trim().length > 0;

  const saveKey = async () => {
    setError(null);
    try {
      const settings = await placesSetGoogleKey(keyDraft.trim());
      setKeyPresent(settings.googleKeyPresent);
      setKeyDraft("");
    } catch {
      setError("That key could not be saved. Check it and try again.");
    }
  };

  const removeKey = async () => {
    setError(null);
    try {
      const settings = await placesClearGoogleKey();
      setKeyPresent(settings.googleKeyPresent);
    } catch {
      setError("The key could not be removed.");
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Place search</h3>
            <p className="settings-row-description">
              Place cards in chat work without any key, using OpenStreetMap data. Add your own
              Google Places API key to get ratings, reviews and photos. The key stays in your
              keychain and is only sent with place searches.
            </p>
            {error ? (
              <p className="settings-row-substatus" role="status">
                {error}
              </p>
            ) : null}
          </div>
          <div className="settings-row-control settings-secret-control">
            <input
              id={keyInputId}
              className="settings-secret-input"
              type="password"
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              placeholder={keyPresent ? "Saved key hidden" : "AIza…"}
              aria-label="Google Places API key"
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSave) void saveKey();
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canSave}
              onClick={() => void saveKey()}
            >
              Save
            </button>
            {keyPresent ? (
              <button type="button" className="btn btn-secondary" onClick={() => void removeKey()}>
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
