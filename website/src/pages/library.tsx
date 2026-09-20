import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Account, type Change, readChanges, revisionHeads } from "../lib/api";
import { date, t } from "../lib/i18n";
import { Markdown } from "../lib/markdown";
import { decryptObject } from "../lib/vault";

type Key = Uint8Array<ArrayBuffer>;

/**
 * Your notes, in a browser that has never seen the app.
 *
 * Read only, and not as a limitation to lift later: writing from here would put
 * a second author on the journal with none of the app's conflict handling, and
 * the page is the surface the threat model already names as outside its
 * boundary. Reading is the whole value — a work computer, a borrowed machine —
 * and it costs nothing that unlocking the vault here did not already cost.
 *
 * Search is done over what has been pulled and decrypted, in this tab. The
 * service has no index and is not going to get one: it cannot read the notes,
 * and an index it could read would be the thing it is built not to have.
 */
interface Entry {
  id: string;
  title: string;
  body: string;
  updated_at: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function Library({ account, vaultKey }: { account: Account; vaultKey: Key }) {
  const active = useRef(new AbortController());
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const signal = active.current.signal;
    setError("");
    try {
      const heads = revisionHeads(await readChanges(signal, "note"));
      const found: Entry[] = [];
      for (const change of heads as Change[]) {
        if (change.deleted) continue;
        const decoded = await decryptObject(vaultKey, account.id, change);
        if (signal.aborted) return;
        if (decoded.deleted || decoded.table !== "notes") continue;
        const row = decoded.row;
        found.push({
          id: change.object_id,
          title: text(row.title),
          body: text(row.edited_content) || text(row.generated_content),
          updated_at: text(row.updated_at),
        });
      }
      if (signal.aborted) return;
      setEntries(found.sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    } catch {
      if (!signal.aborted)
        setError(
          t(
            "Your notes could not be read here. Check your connection and try again.",
            "Vos notes n’ont pas pu être lues ici. Vérifiez votre connexion et réessayez.",
          ),
        );
    }
  }, [account.id, vaultKey]);

  useEffect(() => {
    active.current = new AbortController();
    void load();
    return () => active.current.abort();
  }, [load]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries ?? [];
    return (entries ?? []).filter(
      (entry) =>
        entry.title.toLowerCase().includes(needle) || entry.body.toLowerCase().includes(needle),
    );
  }, [entries, query]);
  const open = matches.find((entry) => entry.id === openId) ?? null;

  if (error)
    return (
      <article className="card">
        <p className="error" role="alert">
          {error}
        </p>
      </article>
    );
  if (!entries)
    return (
      <article className="card" aria-busy="true">
        <p role="status">{t("Reading your notes…", "Lecture de vos notes…")}</p>
      </article>
    );
  if (open)
    return (
      <>
        <button className="button" type="button" onClick={() => setOpenId(null)}>
          ← {t("All notes", "Toutes les notes")}
        </button>
        <article className="card">
          <h2>{open.title || t("Untitled note", "Note sans titre")}</h2>
          <Markdown text={open.body} />
        </article>
      </>
    );
  return (
    <>
      <article className="card">
        <h2>{t("Your notes", "Vos notes")}</h2>
        <p>
          {t(
            "Read only, decrypted in this tab. Edit in the app.",
            "Lecture seule, déchiffrée dans cet onglet. Modifiez dans l’app.",
          )}
        </p>
        <div className="form">
          <label>
            <span className="quiet">{t("Search", "Rechercher")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Title or words in a note", "Titre ou mots d’une note")}
            />
          </label>
        </div>
      </article>
      {entries.length === 0 ? (
        <article className="card">
          <p>
            {t(
              "Nothing has synchronised to this account yet. Turn on synchronisation in the app.",
              "Rien n’a encore été synchronisé sur ce compte. Activez la synchronisation dans l’app.",
            )}
          </p>
        </article>
      ) : (
        <div className="note-list">
          {matches.map((entry) => (
            <button
              key={entry.id}
              className="note-row"
              type="button"
              onClick={() => setOpenId(entry.id)}
            >
              <strong>{entry.title || t("Untitled note", "Note sans titre")}</strong>
              {entry.updated_at && <span className="quiet">{date(entry.updated_at)}</span>}
            </button>
          ))}
        </div>
      )}
      {matches.length === 0 && entries.length > 0 && (
        <p className="quiet">{t("No note matches.", "Aucune note ne correspond.")}</p>
      )}
    </>
  );
}
