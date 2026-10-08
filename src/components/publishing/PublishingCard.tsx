import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  accountPublications,
  deletePublicProfile,
  deletePublishedSite,
  isValidHandle,
  normalizeHandle,
  type PublishedSite,
  type Publications,
  publicPageUrl,
  publicProfileUrl,
  savePublicProfile,
  savePublishedSite,
  setPublicAvatar,
  unpublishAssistant,
  unpublishPage,
} from "../../lib/publishing";
import "./publishing.css";

const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * What this account has made public (ADR-0097): the opt-in profile, the
 * published pages and the sites built from them, and catalog listings. It
 * reads the service only when opened, and every removal is one tap: taking
 * something back is never harder than putting it out.
 */
export function PublishingCard() {
  const [data, setData] = useState<Publications | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setData(await accountPublications());
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setLoaded(true);
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="settings-card account-card publishing-card"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded) void load();
      }}
    >
      <summary className="settings-row-title">{t("Public pages and profile")}</summary>
      <p className="settings-row-description">
        {t(
          "What you publish is public and unencrypted, and stays online until you unpublish it. Publish a note from its share menu, and an assistant from its options.",
        )}
      </p>
      {error ? (
        <p role="alert" className="settings-row-description">
          {error}
        </p>
      ) : null}
      {!loaded ? null : data ? (
        <>
          <ProfileEditor data={data} busy={busy} run={run} />
          <PagesList data={data} busy={busy} run={run} />
          <SitesEditor data={data} busy={busy} run={run} />
          {data.assistants.length > 0 ? (
            <section className="publishing-section">
              <h4 className="publishing-heading">{t("Assistants in the catalog")}</h4>
              <ul className="publishing-list">
                {data.assistants.map((listing) => (
                  <li key={listing.id}>
                    <span className="publishing-item-title">{listing.name}</span>
                    <span className="settings-row-description">
                      {listing.taken_down
                        ? t("Taken down by the service")
                        : t("{count} imports", { count: listing.import_count })}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void run(() => unpublishAssistant(listing.id))}
                    >
                      {t("Unpublish")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </details>
  );
}

type SectionProps = {
  data: Publications;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
};

function ProfileEditor({ data, busy, run }: SectionProps) {
  const profile = data.profile;
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [name, setName] = useState(profile?.display_name ?? "");
  const [bio, setBio] = useState(profile?.bio ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const cleanHandle = normalizeHandle(handle);
  const valid = isValidHandle(cleanHandle) && name.trim().length > 0;

  const pickAvatar = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) {
      setNotice(t("Choose a picture under 256 KB."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const data = reader.result;
        setNotice(null);
        void run(() => setPublicAvatar(data));
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="publishing-section">
      <h4 className="publishing-heading">{t("Public profile")}</h4>
      <p className="settings-row-description">
        {profile
          ? profile.taken_down
            ? t("The service took your profile down.")
            : publicProfileUrl(data.publication_url, profile.handle)
          : t(
              "Optional. A profile page lists your name, a short bio and what you publish. Nothing is shown until you create it.",
            )}
      </p>
      <label className="dialog-field">
        <span className="dialog-field-label">{t("Handle")}</span>
        <input
          className="dialog-input"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
        />
        <span className="dialog-field-hint">
          {t("3 to 32 lowercase letters, digits or hyphens. Your page: {url}", {
            url: publicProfileUrl(data.publication_url, cleanHandle || "…"),
          })}
        </span>
      </label>
      <label className="dialog-field">
        <span className="dialog-field-label">{t("Display name")}</span>
        <input
          className="dialog-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
        />
      </label>
      <label className="dialog-field">
        <span className="dialog-field-label">{t("Short bio")}</span>
        <textarea
          className="dialog-textarea"
          rows={3}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          maxLength={500}
        />
      </label>
      {notice ? (
        <p role="alert" className="settings-row-description">
          {notice}
        </p>
      ) : null}
      <div className="publishing-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !valid}
          onClick={() =>
            void run(() => savePublicProfile({ handle: cleanHandle, displayName: name, bio }))
          }
        >
          {profile ? t("Save profile") : t("Create profile")}
        </button>
        {profile ? (
          <>
            <label className="btn btn-secondary publishing-file">
              {t("Choose a picture")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => pickAvatar(event.target.files?.[0])}
              />
            </label>
            {profile.has_avatar ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void run(() => setPublicAvatar(null))}
              >
                {t("Remove picture")}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void run(() => deletePublicProfile())}
            >
              {t("Remove profile")}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function PagesList({ data, busy, run }: SectionProps) {
  const [copied, setCopied] = useState<string | null>(null);
  if (data.pages.length === 0)
    return (
      <section className="publishing-section">
        <h4 className="publishing-heading">{t("Published pages")}</h4>
        <p className="settings-row-description">{t("Nothing is published yet.")}</p>
      </section>
    );
  return (
    <section className="publishing-section">
      <h4 className="publishing-heading">{t("Published pages")}</h4>
      <ul className="publishing-list">
        {data.pages.map((page) => {
          const url = publicPageUrl(data.publication_url, page.slug);
          return (
            <li key={page.id}>
              <span className="publishing-item-title">{page.title}</span>
              <span className="settings-row-description">
                {page.taken_down ? t("Taken down by the service") : url}
              </span>
              <span className="publishing-actions">
                {page.taken_down ? null : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void writeText(url).then(() => setCopied(page.id))}
                  >
                    {copied === page.id ? t("Copied") : t("Copy")}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void run(() => unpublishPage(page.id))}
                >
                  {t("Unpublish")}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SitesEditor({ data, busy, run }: SectionProps) {
  const [editing, setEditing] = useState<PublishedSite | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const live = data.pages.filter((page) => !page.taken_down);
  if (live.length === 0 && data.sites.length === 0) return null;

  const begin = (site: PublishedSite | "new") => {
    setEditing(site);
    setTitle(site === "new" ? "" : site.title);
    setChosen(site === "new" ? [] : site.page_ids);
    setHome(site === "new" ? null : site.home_page_id);
  };
  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
    );
  const move = (id: string, step: -1 | 1) =>
    setChosen((current) => {
      const at = current.indexOf(id);
      const to = at + step;
      if (at < 0 || to < 0 || to >= current.length) return current;
      const next = [...current];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });
  const pageTitle = (id: string) => data.pages.find((page) => page.id === id)?.title ?? "";
  // A page belongs to one site at most: pages of another site are left out.
  const available = live.filter(
    (page) =>
      !page.site_id || (editing !== "new" && editing !== null && page.site_id === editing.id),
  );

  return (
    <section className="publishing-section">
      <h4 className="publishing-heading">{t("Sites")}</h4>
      <p className="settings-row-description">
        {t("A site groups published pages under one title, with a home page and navigation.")}
      </p>
      {data.sites.length > 0 ? (
        <ul className="publishing-list">
          {data.sites.map((site) => {
            const homePage = data.pages.find((page) => page.id === site.home_page_id);
            return (
              <li key={site.id}>
                <span className="publishing-item-title">{site.title}</span>
                <span className="settings-row-description">
                  {site.taken_down
                    ? t("Taken down by the service")
                    : homePage
                      ? publicPageUrl(data.publication_url, homePage.slug)
                      : t("{count} pages", { count: site.page_ids.length })}
                </span>
                <span className="publishing-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => begin(site)}
                  >
                    {t("Edit")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => void run(() => deletePublishedSite(site.id))}
                  >
                    {t("Delete site")}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {editing ? (
        <div className="publishing-site-form">
          <label className="dialog-field">
            <span className="dialog-field-label">{t("Site title")}</span>
            <input
              className="dialog-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
            />
          </label>
          <fieldset className="publish-permissions">
            <legend className="dialog-field-label">{t("Pages")}</legend>
            {available.map((page) => (
              <label key={page.id} className="publish-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(page.id)}
                  onChange={() => toggle(page.id)}
                />
                {page.title}
              </label>
            ))}
          </fieldset>
          {chosen.length > 0 ? (
            <ol className="publishing-order">
              {chosen.map((id, index) => (
                <li key={id}>
                  <label className="publish-check">
                    <input
                      type="radio"
                      name="site-home"
                      checked={(home ?? chosen[0]) === id}
                      onChange={() => setHome(id)}
                    />
                    {pageTitle(id)}
                    {(home ?? chosen[0]) === id ? ` (${t("home page")})` : ""}
                  </label>
                  <span className="publishing-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={index === 0}
                      onClick={() => move(id, -1)}
                    >
                      {t("Move up")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={index === chosen.length - 1}
                      onClick={() => move(id, 1)}
                    >
                      {t("Move down")}
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          <div className="publishing-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !title.trim() || chosen.length === 0}
              onClick={() =>
                void run(async () => {
                  await savePublishedSite({
                    id: editing === "new" ? undefined : editing.id,
                    title,
                    homePageId: home && chosen.includes(home) ? home : chosen[0],
                    pageIds: chosen,
                  });
                  setEditing(null);
                })
              }
            >
              {t("Publish site")}
            </button>
          </div>
        </div>
      ) : available.length > 0 ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => begin("new")}
        >
          {t("New site")}
        </button>
      ) : null}
    </section>
  );
}
