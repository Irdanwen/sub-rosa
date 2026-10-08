import { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import { listNotes } from "../library";
import {
  clearAvatar,
  deleteProfile,
  deleteSite,
  MAX_AVATAR_BYTES,
  type Publications,
  publications,
  publishNote,
  saveProfile,
  saveSite,
  setAvatar,
  unpublishPage,
} from "../publish";
import type { ClientContext } from "./context";

function failure(error: unknown): string {
  const code = (error as { code?: string; status?: number }).code;
  const status = (error as { status?: number }).status;
  if (status === 404)
    return t(
      "This service does not publish pages yet.",
      "Ce service ne publie pas encore de pages.",
    );
  if (code === "content_policy")
    return t(
      "The publishing rules refuse this as it is.",
      "Les règles de publication refusent ce contenu tel quel.",
    );
  if (code === "handle_taken" || code === "slug_taken")
    return t(
      "That address is already taken. Choose another.",
      "Cette adresse est déjà prise. Choisissez-en une autre.",
    );
  if (code === "publishing_suspended")
    return t(
      "Publishing is suspended for this account.",
      "La publication est suspendue pour ce compte.",
    );
  return t("This could not be published. Try again.", "Cela n’a pas pu être publié. Réessayez.");
}

/**
 * Publishing from the browser (ADR-0097): a note as a public page, pages
 * gathered into a site, and the public profile that lists them. What is
 * published is public, has no end date, and stays until it is unpublished;
 * unpublishing cannot reach a copy a reader already has.
 */
export function PublishingView({ ctx }: { ctx: ClientContext }) {
  const [overview, setOverview] = useState<Publications | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [noteId, setNoteId] = useState("");
  const [site, setSite] = useState<{ title: string; pages: string[]; home: string }>({
    title: "",
    pages: [],
    home: "",
  });
  const [profile, setProfile] = useState({ handle: "", displayName: "", bio: "" });
  const notes = listNotes(ctx.sync);
  const reload = useCallback(
    () =>
      publications()
        .then((value) => {
          setOverview(value);
          if (value.profile)
            setProfile({
              handle: value.profile.handle,
              displayName: value.profile.display_name,
              bio: value.profile.bio,
            });
        })
        .catch((failed) => setError(failure(failed))),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const act = (work: Promise<unknown>, message: string) =>
    work
      .then(() => {
        setError("");
        setStatus(message);
        return reload();
      })
      .catch((failed) => setError(failure(failed)));
  const titleOf = (id: string) => overview?.pages.find((page) => page.id === id)?.title ?? id;
  return (
    <section className="wc-view" aria-labelledby="wc-publishing-title">
      <h1 id="wc-publishing-title">{t("Publishing", "Publication")}</h1>
      <p className="notice">
        {t(
          "What you publish is public and readable by anyone, without an end date, until you unpublish it. Unpublishing cannot reach a copy someone already has.",
          "Ce que vous publiez est public et lisible par tous, sans date de fin, jusqu’à ce que vous le retiriez. Retirer n’atteint pas une copie déjà prise.",
        )}
      </p>
      <h2>{t("Pages", "Pages")}</h2>
      <div className="wc-row">
        <label className="wc-grow">
          <span className="sr-only">{t("Note to publish", "Note à publier")}</span>
          <select value={noteId} onChange={(event) => setNoteId(event.target.value)}>
            <option value="">{t("Choose a note", "Choisissez une note")}</option>
            {notes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.title || t("Untitled note", "Note sans titre")}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          type="button"
          disabled={!noteId}
          onClick={() => {
            const note = notes.find((item) => item.id === noteId);
            if (note) void act(publishNote(note), t("Published.", "Publié."));
          }}
        >
          {overview?.pages.some((page) => page.source_id === noteId)
            ? t("Publish changes", "Publier les modifications")
            : t("Publish", "Publier")}
        </button>
      </div>
      {overview && overview.pages.length === 0 && (
        <p className="quiet">
          {t("Nothing is published yet.", "Rien n’est publié pour l’instant.")}
        </p>
      )}
      <ul className="wc-plain">
        {overview?.pages.map((page) => (
          <li key={page.id} className="wc-row">
            <a href={`${overview.publication_url}/p/${page.slug}`} target="_blank" rel="noreferrer">
              {page.title}
            </a>
            {page.taken_down && (
              <span className="quiet">{t("Taken down", "Retiré par la modération")}</span>
            )}
            <button
              className="button"
              type="button"
              onClick={() => void act(unpublishPage(page.id), t("Unpublished.", "Retiré."))}
            >
              {t(`Unpublish ${page.title}`, `Retirer ${page.title}`)}
            </button>
          </li>
        ))}
      </ul>
      <h2>{t("Sites", "Sites")}</h2>
      <p className="quiet">
        {t(
          "A site gathers published pages under one address, with its own navigation.",
          "Un site réunit des pages publiées sous une adresse, avec sa propre navigation.",
        )}
      </p>
      <ul className="wc-plain">
        {overview?.sites.map((item) => (
          <li key={item.id} className="wc-row">
            <span>{item.title}</span>
            <span className="quiet">{item.page_ids.map(titleOf).join(", ")}</span>
            <button
              className="button"
              type="button"
              onClick={() =>
                void act(
                  deleteSite(item.id),
                  t(
                    "Site deleted. Its pages stay published.",
                    "Site supprimé. Ses pages restent publiées.",
                  ),
                )
              }
            >
              {t(`Delete ${item.title}`, `Supprimer ${item.title}`)}
            </button>
          </li>
        ))}
      </ul>
      {overview && overview.pages.length > 0 && (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              saveSite({
                title: site.title,
                homePageId: site.home || site.pages[0] || null,
                pageIds: site.pages,
              }),
              t("Site saved.", "Site enregistré."),
            ).then(() => setSite({ title: "", pages: [], home: "" }));
          }}
        >
          <label>
            <span>{t("New site title", "Titre du nouveau site")}</span>
            <input
              value={site.title}
              maxLength={200}
              onChange={(event) => setSite({ ...site, title: event.target.value })}
            />
          </label>
          <fieldset className="wc-choices">
            <legend>{t("Its pages", "Ses pages")}</legend>
            {overview.pages.map((page) => (
              <label key={page.id} className="check">
                <input
                  type="checkbox"
                  checked={site.pages.includes(page.id)}
                  onChange={() =>
                    setSite({
                      ...site,
                      pages: site.pages.includes(page.id)
                        ? site.pages.filter((id) => id !== page.id)
                        : [...site.pages, page.id],
                    })
                  }
                />
                {page.title}
              </label>
            ))}
          </fieldset>
          {site.pages.length > 1 && (
            <label>
              <span>{t("Home page", "Page d’accueil")}</span>
              <select
                value={site.home}
                onChange={(event) => setSite({ ...site, home: event.target.value })}
              >
                {site.pages.map((id) => (
                  <option key={id} value={id}>
                    {titleOf(id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="button"
            type="submit"
            disabled={!site.title.trim() || !site.pages.length}
          >
            {t("Create site", "Créer le site")}
          </button>
        </form>
      )}
      <h2>{t("Public profile", "Profil public")}</h2>
      <p className="quiet">
        {t(
          "Your profile lists your sites, pages and catalog assistants at one address. It exists only once you create it.",
          "Votre profil liste vos sites, pages et assistants du catalogue à une adresse. Il n’existe qu’une fois créé.",
        )}
      </p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(saveProfile(profile), t("Profile saved.", "Profil enregistré."));
        }}
      >
        <label>
          <span>{t("Handle", "Identifiant")}</span>
          <input
            value={profile.handle}
            minLength={3}
            maxLength={32}
            onChange={(event) => setProfile({ ...profile, handle: event.target.value })}
          />
        </label>
        <label>
          <span>{t("Display name", "Nom affiché")}</span>
          <input
            value={profile.displayName}
            maxLength={80}
            onChange={(event) => setProfile({ ...profile, displayName: event.target.value })}
          />
        </label>
        <label>
          <span>{t("About you", "À propos de vous")}</span>
          <textarea
            rows={3}
            maxLength={500}
            value={profile.bio}
            onChange={(event) => setProfile({ ...profile, bio: event.target.value })}
          />
        </label>
        <div className="wc-row">
          <button
            className="button primary"
            type="submit"
            disabled={profile.handle.trim().length < 3}
          >
            {overview?.profile
              ? t("Save profile", "Enregistrer le profil")
              : t("Create profile", "Créer le profil")}
          </button>
          {overview?.profile && (
            <>
              <a
                className="button"
                href={`${overview.publication_url}/u/${overview.profile.handle}`}
                target="_blank"
                rel="noreferrer"
              >
                {t("See your profile", "Voir votre profil")}
              </a>
              <button
                className="button"
                type="button"
                onClick={() => void act(deleteProfile(), t("Profile deleted.", "Profil supprimé."))}
              >
                {t("Delete profile", "Supprimer le profil")}
              </button>
            </>
          )}
        </div>
      </form>
      {overview?.profile && (
        <div className="wc-row">
          <label className="button wc-attach">
            {t("Choose a picture", "Choisir une photo")}
            <input
              className="sr-only"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > MAX_AVATAR_BYTES) {
                  setError(
                    t("Choose a picture under 256 KB.", "Choisissez une photo de moins de 256 Ko."),
                  );
                  return;
                }
                void file
                  .arrayBuffer()
                  .then((bytes) =>
                    act(
                      setAvatar(new Uint8Array(bytes)),
                      t("Picture saved.", "Photo enregistrée."),
                    ),
                  );
              }}
            />
          </label>
          {overview.profile.has_avatar && (
            <button
              className="button"
              type="button"
              onClick={() => void act(clearAvatar(), t("Picture removed.", "Photo retirée."))}
            >
              {t("Remove picture", "Retirer la photo")}
            </button>
          )}
        </div>
      )}
      {status && (
        <p className="quiet" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
