import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account } from "../../lib/api";
import { t } from "../../lib/i18n";
import type { Operator } from "../carpe-diem";
import { type FeatureStore, featureStore } from "../feature";
import { listProjects } from "../projects";
import { type ClientStore, availableClientStore } from "../store";
import type { SyncClient } from "../sync";
import {
  type Me,
  type OpenedInvitation,
  SPACES_ENABLED,
  type SpaceSummary,
  type SpaceView,
  type SpacesTransport,
  acceptInvitation,
  askAssistant,
  behindPreview,
  itemsOf,
  leave,
  listSpaces,
  loadIdentity,
  messagesOf,
  nameOf,
  openInvitation,
  openSpace,
  serviceSpaces,
  write,
} from "./client";
import {
  type MadeInvitation,
  type PendingInvitation,
  admit,
  createInvitation,
  createSpace,
  pendingInvitations,
  removeMember,
  revokeInvitation,
  rotateIfDue,
} from "./membership";
import "./spaces.css";

type Key = Uint8Array<ArrayBuffer>;

function failure(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "space_rollback")
    return t(
      "The service showed an older state of this shared project than this browser has already seen. Nothing was changed.",
      "Le service a montré un état de ce projet partagé plus ancien que celui que ce navigateur a déjà vu. Rien n’a été modifié.",
    );
  if (code === "spaces_disabled")
    return t(
      "Turn on shared projects first. They are a preview.",
      "Activez d’abord les projets partagés. C’est un aperçu.",
    );
  if (code === "space_acceptance_unverifiable")
    return t(
      "This acceptance could not be verified in this browser. Withdraw the invitation and send a new link from here.",
      "Cette acceptation n’a pas pu être vérifiée dans ce navigateur. Retirez l’invitation et envoyez un nouveau lien depuis ici.",
    );
  if (code === "space_owner_only")
    return t(
      "Only the owner of this shared project can do this.",
      "Seul le propriétaire de ce projet partagé peut faire cela.",
    );
  if (
    code === "space_invitation_invalid" ||
    code === "space_invitation_unavailable" ||
    code === "not_found" ||
    code === "conflict"
  )
    return t(
      "This invitation has expired, was already used, or was withdrawn. Ask for a new link.",
      "Cette invitation a expiré, a déjà servi ou a été retirée. Demandez un nouveau lien.",
    );
  return t(
    "This shared project could not be opened or verified. Nothing was changed.",
    "Ce projet partagé n’a pas pu être ouvert ni vérifié. Rien n’a été modifié.",
  );
}

/** Where an invitation link sends the person: this site's own `/app`. */
function appUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL ?? "/"}app`;
}

/** Opens a space and makes the rotation a signed departure (or, for the
 * owner, a vanished account) calls for, then reads it again if it made one. */
async function openAndRotate(
  transport: SpacesTransport,
  store: ClientStore,
  me: Me,
  spaceId: string,
): Promise<SpaceView> {
  const view = await openSpace(transport, store, me, spaceId);
  const rotated = await rotateIfDue(transport, me, view).catch(() => false);
  return rotated ? openSpace(transport, store, me, spaceId) : view;
}

/** The invitation code in this page's address, when it was opened from a link. */
function codeInAddress(): string | null {
  const match = /srspace1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/.exec(window.location.hash);
  return match ? match[0] : null;
}

/**
 * Shared projects in the web client (ADR-0098): a preview the person turns
 * on, read and written with the same protocol as the app. Registered by one
 * line in the client's sidebar.
 */
export function SpacesEntry({
  account,
  vaultKey,
  openKey,
  operator,
  model,
  transport: service = serviceSpaces,
  store: givenStore,
  sync = null,
}: {
  account: Account;
  vaultKey: Key;
  openKey: () => Promise<string | null>;
  operator: Operator;
  model: string;
  transport?: SpacesTransport;
  store?: ClientStore;
  /** The account's projects, the ones a person may share from here. */
  sync?: SyncClient | null;
}) {
  const [store, setStore] = useState<ClientStore | null>(givenStore ?? null);
  // Every call this panel makes reads the Preview switch first.
  const transport = useMemo(() => behindPreview(store, service), [store, service]);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [view, setView] = useState<SpaceView | null>(null);
  const [invitation, setInvitation] = useState<OpenedInvitation | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState("");
  const code = useMemo(codeInAddress, []);
  const projects = sync ? listProjects(sync) : [];
  const secrets = useMemo(
    () => (store ? featureStore(account.id, vaultKey, store, "spaces") : null),
    [store, account.id, vaultKey],
  );

  useEffect(() => {
    if (givenStore) return;
    void availableClientStore().then(setStore);
  }, [givenStore]);
  useEffect(() => {
    if (!store) return;
    void store
      .get<boolean>("local", SPACES_ENABLED)
      .then((on) => {
        setEnabled(on === true);
        if (code) setOpen(true);
      })
      .catch(() => undefined);
  }, [store, code]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(async () => {
    const identity = await loadIdentity(transport, vaultKey, account.id);
    setMe(identity);
    setSpaces(await listSpaces(transport));
    if (code && !invitation) setInvitation(await openInvitation(transport, identity, code));
    return identity;
  }, [transport, vaultKey, account.id, code, invitation]);
  useEffect(() => {
    if (open && enabled && !me) void run(start);
  }, [open, enabled, me, run, start]);

  if (!open)
    return (
      <button type="button" className="button wc-spaces-entry" onClick={() => setOpen(true)}>
        {t("Shared projects", "Projets partagés")}{" "}
        <span className="wc-spaces-badge">{t("Preview", "Aperçu")}</span>
      </button>
    );

  return (
    <section className="wc-spaces" aria-label={t("Shared projects", "Projets partagés")}>
      <div className="wc-row">
        <strong>{t("Shared projects", "Projets partagés")}</strong>
        <span className="wc-spaces-badge">{t("Preview", "Aperçu")}</span>
        <button type="button" className="button" onClick={() => setOpen(false)}>
          {t("Close", "Fermer")}
        </button>
      </div>
      {!enabled ? (
        <>
          <p className="quiet">
            {t(
              "Projects shared between Sub Rosa accounts, end-to-end encrypted. This is a preview: the protocol has not been independently reviewed yet, so do not rely on it for anything sensitive.",
              "Des projets partagés entre comptes Sub Rosa, chiffrés de bout en bout. C’est un aperçu : le protocole n’a pas encore été examiné de façon indépendante, ne vous y fiez pas pour quoi que ce soit de sensible.",
            )}
          </p>
          <button
            type="button"
            className="button primary"
            onClick={() =>
              void store?.put("local", SPACES_ENABLED, true).then(() => setEnabled(true))
            }
          >
            {t("Turn on shared projects", "Activer les projets partagés")}
          </button>
        </>
      ) : null}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="quiet">{notice}</p>}
      {enabled && me && invitation ? (
        <div className="wc-spaces-card">
          <p>
            <strong>{invitation.payload.space_name}</strong>
          </p>
          <p className="quiet">
            {t(
              "Before you join, compare this safety number with the owner's, in person or on a call. If it differs, do not join.",
              "Avant de rejoindre, comparez ce numéro de sécurité avec celui du propriétaire, en personne ou par téléphone. S’il diffère, ne rejoignez pas.",
            )}
          </p>
          <p className="wc-spaces-safety">{invitation.safetyNumber.join(" ")}</p>
          <div className="wc-row">
            <button
              type="button"
              className="button primary"
              disabled={busy || !store}
              onClick={() =>
                void run(async () => {
                  if (!store) return;
                  await acceptInvitation(transport, store, me, invitation);
                  setInvitation(null);
                  history.replaceState(null, "", window.location.pathname);
                  setNotice(
                    t(
                      "You asked to join. The project appears here once the owner lets you in.",
                      "Vous avez demandé à rejoindre. Le projet apparaît ici dès que le propriétaire vous fait entrer.",
                    ),
                  );
                })
              }
            >
              {t("Join", "Rejoindre")}
            </button>
            <button type="button" className="button" onClick={() => setInvitation(null)}>
              {t("Cancel", "Annuler")}
            </button>
          </div>
        </div>
      ) : null}
      {enabled && me && view && store && secrets ? (
        <SpaceRoom
          me={me}
          view={view}
          transport={transport}
          secrets={secrets}
          openKey={openKey}
          operator={operator}
          model={model}
          onBack={() => setView(null)}
          onReload={() => openAndRotate(transport, store, me, view.id).then(setView)}
          onLeft={() => {
            setView(null);
            void listSpaces(transport).then(setSpaces);
          }}
        />
      ) : enabled && me ? (
        <ul className="wc-spaces-list">
          {spaces.length === 0 && (
            <li className="quiet">
              {t(
                "No shared projects yet. Share one of your projects, or open an invitation link.",
                "Aucun projet partagé pour l’instant. Partagez l’un de vos projets, ou ouvrez un lien d’invitation.",
              )}
            </li>
          )}
          {projects.length > 0 && (
            <li className="wc-spaces-card wc-spaces-share">
              <label>
                {t("Share a project", "Partager un projet")}
                <select
                  className="wc-spaces-input"
                  value={sharing}
                  onChange={(event) => setSharing(event.target.value)}
                >
                  <option value="">{t("Choose a project", "Choisissez un projet")}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="quiet">
                {t(
                  "The shared project starts as a copy of its name, instructions and files. Your project stays as it is.",
                  "Le projet partagé commence par une copie de son nom, de ses instructions et de ses fichiers. Votre projet reste tel quel.",
                )}
              </p>
              <button
                type="button"
                className="button primary"
                disabled={busy || !store || !sharing}
                onClick={() =>
                  void run(async () => {
                    const project = projects.find((item) => item.id === sharing);
                    if (!store || !project) return;
                    // Only what was read from a file travels, as in the app.
                    const files = project.files.filter((file) => file.status === "ready");
                    setView(await createSpace(transport, store, me, { ...project, files }));
                    setSharing("");
                    void listSpaces(transport).then(setSpaces);
                  })
                }
              >
                {t("Share", "Partager")}
              </button>
            </li>
          )}
          {spaces.map((space) => (
            <li key={space.id}>
              <button
                type="button"
                className="wc-chat-row"
                disabled={busy || !store}
                onClick={() =>
                  void run(async () => {
                    if (store) setView(await openAndRotate(transport, store, me, space.id));
                  })
                }
              >
                {space.role === "owner"
                  ? t("Shared project, yours", "Projet partagé, le vôtre")
                  : t("Shared project", "Projet partagé")}{" "}
                ·{" "}
                {t("{count} members", "{count} membres").replace(
                  "{count}",
                  String(space.member_count),
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SpaceRoom({
  me,
  view,
  transport,
  secrets,
  openKey,
  operator,
  model,
  onBack,
  onReload,
  onLeft,
}: {
  me: Me;
  view: SpaceView;
  transport: SpacesTransport;
  secrets: FeatureStore;
  openKey: () => Promise<string | null>;
  operator: Operator;
  model: string;
  onBack: () => void;
  onReload: () => Promise<void>;
  onLeft: () => void;
}) {
  const conversations = itemsOf(view, "conversation");
  const [current, setCurrent] = useState<string | null>(conversations[0]?.id ?? null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = view.latest.owner === me.accountId;
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [made, setMade] = useState<MadeInvitation | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void pendingInvitations(secrets, me, view)
      .then((list) => {
        if (live) setInvitations(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [secrets, me, view]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await onReload();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
      setStreaming(null);
    }
  }
  const send = (ask: boolean) =>
    run(async () => {
      if (!current) return;
      await write(transport, me, view, "message", crypto.randomUUID(), {
        conversation_id: current,
        role: "user",
        text: draft.trim(),
      });
      setDraft("");
      if (!ask) return;
      const key = await openKey();
      if (!key) throw new Error("no key");
      setStreaming("");
      await askAssistant(transport, me, view, current, operator, key, model, setStreaming);
    });

  return (
    <div className="wc-spaces-room">
      <div className="wc-row">
        <button type="button" className="button" onClick={onBack}>
          {t("Back", "Retour")}
        </button>
        <strong>{view.name || t("Shared project", "Projet partagé")}</strong>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <details open={owner && invitations.some((i) => i.state === "ready")}>
        <summary>{t("Members and safety numbers", "Membres et numéros de sécurité")}</summary>
        <ul className="wc-spaces-list">
          {view.members.map((member) => (
            <li key={member.accountId}>
              <strong>
                {member.isMe ? t("You", "Vous") : (member.name ?? t("A member", "Un membre"))}
              </strong>
              {member.isMe ? null : (
                <span className="wc-spaces-safety">{member.safetyNumber.join(" ")}</span>
              )}
              {owner && !member.isMe ? (
                removing === member.accountId ? (
                  <div className="wc-spaces-card">
                    <p className="quiet">
                      {t(
                        "They keep everything they already downloaded, and every key up to now. They cannot read anything written after this.",
                        "Cette personne garde tout ce qu’elle a déjà téléchargé, et toutes les clés jusqu’à maintenant. Elle ne pourra rien lire de ce qui sera écrit ensuite.",
                      )}
                    </p>
                    <div className="wc-row">
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await removeMember(transport, me, view, member.accountId);
                            setRemoving(null);
                          })
                        }
                      >
                        {t("Remove", "Retirer")}
                      </button>
                      <button type="button" className="button" onClick={() => setRemoving(null)}>
                        {t("Cancel", "Annuler")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => setRemoving(member.accountId)}
                  >
                    {t("Remove from the project", "Retirer du projet")}
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
        {owner ? (
          <Invitations
            invitations={invitations}
            made={made}
            busy={busy}
            onInvite={() =>
              void run(async () => {
                setMade(await createInvitation(transport, secrets, me, view, appUrl()));
              })
            }
            onAdmit={(id) =>
              void run(async () => {
                await admit(transport, secrets, me, view, id);
              })
            }
            onWithdraw={(id) =>
              void run(async () => {
                await revokeInvitation(transport, secrets, view.id, id);
                if (made?.id === id) setMade(null);
              })
            }
          />
        ) : null}
      </details>
      <details>
        <summary>{t("Notes and files", "Notes et fichiers")}</summary>
        {view.instructions && <p className="quiet">{view.instructions}</p>}
        {[...itemsOf(view, "note"), ...itemsOf(view, "file")].map((item) => (
          <details key={item.id} className="wc-spaces-card">
            <summary>{String(item.data.title ?? item.data.name ?? "")}</summary>
            <p className="wc-spaces-text">{String(item.data.body ?? item.data.text ?? "")}</p>
          </details>
        ))}
      </details>
      <div className="wc-row">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className="button"
            aria-pressed={conversation.id === current}
            onClick={() => setCurrent(conversation.id)}
          >
            {String(conversation.data.title || t("Untitled chat", "Discussion sans titre"))}
          </button>
        ))}
      </div>
      <form
        className="wc-row"
        onSubmit={(event) => {
          event.preventDefault();
          const id = crypto.randomUUID();
          void run(async () => {
            await write(transport, me, view, "conversation", id, { title: title.trim() });
            setTitle("");
            setCurrent(id);
          });
        }}
      >
        <input
          className="wc-spaces-input"
          value={title}
          maxLength={300}
          placeholder={t("New chat", "Nouvelle discussion")}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" className="button" disabled={busy || !title.trim()}>
          {t("Add", "Ajouter")}
        </button>
      </form>
      {current ? (
        <>
          <ol className="wc-spaces-messages" aria-live="polite">
            {messagesOf(view, current).map((message) => (
              <li key={message.id} data-mine={message.author === me.accountId || undefined}>
                <span className="quiet">
                  {message.data.role === "assistant"
                    ? message.author === me.accountId
                      ? t(
                          "Assistant, answered with your key",
                          "Assistant, réponse payée avec votre clé",
                        )
                      : t(
                          "Assistant, answered with {name}'s key",
                          "Assistant, réponse payée avec la clé de {name}",
                        ).replace(
                          "{name}",
                          nameOf(view, message.author) ?? t("a member", "un membre"),
                        )
                    : message.author === me.accountId
                      ? t("You", "Vous")
                      : (nameOf(view, message.author) ?? t("A member", "Un membre"))}
                </span>
                <span className="wc-spaces-text">{String(message.data.text ?? "")}</span>
              </li>
            ))}
            {streaming !== null && (
              <li>
                <span className="quiet">
                  {t("The assistant is answering…", "L’assistant répond…")}
                </span>
                <span className="wc-spaces-text">{streaming}</span>
              </li>
            )}
          </ol>
          <textarea
            className="wc-spaces-input"
            rows={3}
            value={draft}
            aria-label={t("Message", "Message")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="wc-row">
            <button
              type="button"
              className="button"
              disabled={busy || !draft.trim()}
              onClick={() => void send(false)}
            >
              {t("Send", "Envoyer")}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || !draft.trim()}
              onClick={() => void send(true)}
            >
              {t("Send and ask the assistant", "Envoyer et demander à l’assistant")}
            </button>
          </div>
          <p className="quiet">
            {t(
              "The assistant answers from this browser, with its key: you pay for that reply, and everyone sees it.",
              "L’assistant répond depuis ce navigateur, avec sa clé : c’est vous qui payez cette réponse, et tout le monde le voit.",
            )}
          </p>
        </>
      ) : null}
      {owner ? null : (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await leave(transport, me, view);
              onLeft();
            })
          }
        >
          {t("Leave shared project", "Quitter le projet partagé")}
        </button>
      )}
    </div>
  );
}

/**
 * The owner's invitations: make a link, see who answered, and admit only
 * after comparing the safety number. A link made in the app is admitted from
 * the app: its secret is there, not here.
 */
function Invitations({
  invitations,
  made,
  busy,
  onInvite,
  onAdmit,
  onWithdraw,
}: {
  invitations: PendingInvitation[];
  made: MadeInvitation | null;
  busy: boolean;
  onInvite: () => void;
  onAdmit: (id: string) => void;
  onWithdraw: (id: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wc-spaces-room">
      <button type="button" className="button" disabled={busy} onClick={onInvite}>
        {t("Invite someone", "Inviter quelqu’un")}
      </button>
      {made ? (
        <div className="wc-spaces-card">
          <p className="quiet">
            {t(
              "Send this link to one person, through a channel you trust. It works once, for seven days. Keep this browser: their answer is checked here.",
              "Envoyez ce lien à une seule personne, par un canal de confiance. Il sert une fois, pendant sept jours. Gardez ce navigateur : sa réponse est vérifiée ici.",
            )}
          </p>
          <input
            className="wc-spaces-input"
            readOnly
            value={made.link}
            aria-label={t("Invitation link", "Lien d’invitation")}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="button"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(made.link)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? t("Copied", "Copié") : t("Copy link", "Copier le lien")}
          </button>
        </div>
      ) : null}
      {invitations.length ? (
        <ul className="wc-spaces-list">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="wc-spaces-card">
              {invitation.state === "waiting" ? (
                <p className="quiet">
                  {t(
                    "An invitation is waiting for an answer.",
                    "Une invitation attend une réponse.",
                  )}
                </p>
              ) : invitation.state === "unverifiable" ? (
                <p className="quiet">
                  {t(
                    "Someone answered a link made on another device. Admit them from that device, or withdraw it and send a new link from here.",
                    "Quelqu’un a répondu à un lien fait sur un autre appareil. Faites-le entrer depuis cet appareil, ou retirez-le et envoyez un nouveau lien depuis ici.",
                  )}
                </p>
              ) : (
                <>
                  <p>
                    {t(
                      "Someone accepted your invitation. Before you let them in, compare this safety number with theirs, in person or on a call. If it differs, do not admit them.",
                      "Quelqu’un a accepté votre invitation. Avant de la faire entrer, comparez ce numéro de sécurité avec le sien, en personne ou par téléphone. S’il diffère, ne la faites pas entrer.",
                    )}
                  </p>
                  <p className="wc-spaces-safety">{invitation.safetyNumber.join(" ")}</p>
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => onAdmit(invitation.id)}
                  >
                    {t("The numbers match, admit", "Les numéros correspondent, faire entrer")}
                  </button>
                </>
              )}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => onWithdraw(invitation.id)}
              >
                {t("Withdraw", "Retirer l’invitation")}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
