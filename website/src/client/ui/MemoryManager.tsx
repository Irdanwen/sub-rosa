import { useState } from "react";
import { t } from "../../lib/i18n";
import { addMemory, allMemories, forgetMemory, MAX_MEMORY_CHARS, updateMemory } from "../memories";
import { listProjects } from "../projects";
import type { SyncClient } from "../sync";

/**
 * Settings › Memory in the browser: every synchronised memory, the person's
 * own and each project's, added, edited, paused and forgotten as in the app.
 * A change travels like any other write, so every device sees it; pausing
 * keeps a memory unused, forgetting removes it everywhere.
 */
export function MemoryManager({ sync, onChanged }: { sync: SyncClient; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const memories = allMemories(sync);
  const projects = new Map(listProjects(sync).map((project) => [project.id, project.name]));
  const done = (message: string) => {
    setStatus(message);
    onChanged();
  };
  return (
    <section className="wc-memory" aria-labelledby="wc-memory-list">
      <h3 id="wc-memory-list">{t("What Sub Rosa remembers", "Ce dont Sub Rosa se souvient")}</h3>
      <form
        className="wc-row"
        onSubmit={(event) => {
          event.preventDefault();
          void addMemory(sync, draft).then((result) => {
            if (result === "known")
              setStatus(t("That is already remembered.", "C’est déjà retenu."));
            if (result === "stored") {
              setDraft("");
              done(t("Remembered.", "Retenu."));
            }
          });
        }}
      >
        <label className="wc-grow">
          <span className="sr-only">{t("A fact to remember", "Un fait à retenir")}</span>
          <input
            value={draft}
            maxLength={MAX_MEMORY_CHARS}
            placeholder={t("Add something to remember", "Ajouter quelque chose à retenir")}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="button" type="submit" disabled={!draft.trim()}>
          {t("Add", "Ajouter")}
        </button>
      </form>
      {memories.length === 0 ? (
        <p className="quiet">{t("Nothing is remembered yet.", "Rien n’est encore retenu.")}</p>
      ) : (
        <ul className="wc-memory-list">
          {memories.map((memory) => (
            <li key={memory.id} className={memory.disabled ? "wc-paused" : undefined}>
              {editing?.id === memory.id ? (
                <form
                  className="wc-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void updateMemory(sync, memory.id, { text: editing.text }).then((changed) => {
                      setEditing(null);
                      if (changed) done(t("Memory updated.", "Souvenir modifié."));
                    });
                  }}
                >
                  <label className="wc-grow">
                    <span className="sr-only">{t("Memory", "Souvenir")}</span>
                    <input
                      value={editing.text}
                      maxLength={MAX_MEMORY_CHARS}
                      onChange={(event) => setEditing({ id: memory.id, text: event.target.value })}
                    />
                  </label>
                  <button className="button primary" type="submit" disabled={!editing.text.trim()}>
                    {t("Save", "Enregistrer")}
                  </button>
                  <button className="button" type="button" onClick={() => setEditing(null)}>
                    {t("Cancel", "Annuler")}
                  </button>
                </form>
              ) : (
                <>
                  <p>{memory.text}</p>
                  <p className="quiet">
                    {[
                      memory.scope
                        ? t(
                            `Project: ${projects.get(memory.scope) ?? "removed"}`,
                            `Projet : ${projects.get(memory.scope) ?? "supprimé"}`,
                          )
                        : "",
                      memory.disabled ? t("Paused", "En pause") : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="wc-actions">
                    <button
                      type="button"
                      onClick={() => setEditing({ id: memory.id, text: memory.text })}
                    >
                      {t("Edit", "Modifier")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void updateMemory(sync, memory.id, { disabled: !memory.disabled }).then(
                          () =>
                            done(
                              memory.disabled
                                ? t("Memory resumed.", "Souvenir réactivé.")
                                : t("Memory paused.", "Souvenir mis en pause."),
                            ),
                        )
                      }
                    >
                      {memory.disabled ? t("Resume", "Réactiver") : t("Pause", "Mettre en pause")}
                    </button>
                    {confirm === memory.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void forgetMemory(sync, memory.id).then(() => {
                              setConfirm(null);
                              done(
                                t("Forgotten on every device.", "Oublié sur tous les appareils."),
                              );
                            })
                          }
                        >
                          {t("Forget everywhere", "Oublier partout")}
                        </button>
                        <button type="button" onClick={() => setConfirm(null)}>
                          {t("Keep", "Garder")}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setConfirm(memory.id)}>
                        {t("Forget", "Oublier")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
