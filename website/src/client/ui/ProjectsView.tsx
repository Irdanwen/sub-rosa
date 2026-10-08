import { useState } from "react";
import { date, t } from "../../lib/i18n";
import { AGENT_LITE } from "../codec";
import { readDocument } from "../documents/read";
import { listChats } from "../library";
import {
  addProjectFile,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  MAX_INSTRUCTIONS_CHARS,
  projectIdOfChat,
  removeProjectFile,
  renameProject,
  saveProjectSettings,
} from "../projects";
import { ACCEPTED_FILES, documentFailure } from "./AttachmentBar";
import type { ClientContext } from "./context";

/**
 * Projects in the browser (ADR-0085): create one, give it instructions, files
 * and its own memory, and keep chats in it. Everything here is the app's
 * rows, so a project made here is the same project on the phone.
 */
export function ProjectsView({
  ctx,
  onNewChat,
}: {
  ctx: ClientContext;
  /** Starts a new chat filed in this project. */
  onNewChat: (projectId: string) => void;
}) {
  const projects = listProjects(ctx.sync);
  const [selected, setSelected] = useState<string | null>(projects[0]?.id ?? null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const project = selected ? getProject(ctx.sync, selected) : null;
  const done = (message: string) => {
    setStatus(message);
    setError("");
    ctx.flush();
  };
  return (
    <section className="wc-view" aria-labelledby="wc-projects-title">
      <h1 id="wc-projects-title">{t("Projects", "Projets")}</h1>
      <p className="quiet">
        {t(
          "A project keeps chats together with instructions, files and, if you want, a memory of its own. It is the same project in the app.",
          "Un projet réunit des discussions avec des instructions, des fichiers et, si vous le voulez, une mémoire propre. C’est le même projet dans l’app.",
        )}
      </p>
      <form
        className="wc-row"
        onSubmit={(event) => {
          event.preventDefault();
          void createProject(ctx.sync, name).then((id) => {
            setName("");
            setSelected(id);
            done(t("Project created.", "Projet créé."));
          });
        }}
      >
        <label className="wc-grow">
          <span className="sr-only">{t("New project name", "Nom du nouveau projet")}</span>
          <input
            value={name}
            maxLength={200}
            placeholder={t("New project name", "Nom du nouveau projet")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button className="button primary" type="submit" disabled={!name.trim()}>
          {t("Create project", "Créer le projet")}
        </button>
      </form>
      <div className="wc-split">
        <nav className="wc-list" aria-label={t("Your projects", "Vos projets")}>
          {projects.length === 0 && (
            <p className="quiet">{t("No project yet.", "Aucun projet pour l’instant.")}</p>
          )}
          {projects.map((item) => (
            <button
              key={item.id}
              type="button"
              className="wc-chat-row"
              aria-current={item.id === selected ? "page" : undefined}
              onClick={() => setSelected(item.id)}
            >
              <strong>{item.name}</strong>
            </button>
          ))}
        </nav>
        {project && (
          <ProjectEditor
            key={project.id}
            ctx={ctx}
            projectId={project.id}
            onNewChat={() => onNewChat(project.id)}
            onDone={done}
            onError={setError}
            onDeleted={() => setSelected(null)}
          />
        )}
      </div>
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

function ProjectEditor({
  ctx,
  projectId,
  onNewChat,
  onDone,
  onError,
  onDeleted,
}: {
  ctx: ClientContext;
  projectId: string;
  onNewChat: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
  onDeleted: () => void;
}) {
  const project = getProject(ctx.sync, projectId);
  const [name, setName] = useState(project?.name ?? "");
  const [instructions, setInstructions] = useState(project?.instructions ?? "");
  const [mode, setMode] = useState(project?.memoryMode ?? AGENT_LITE.project.memoryDefault);
  const [confirm, setConfirm] = useState(false);
  if (!project) return null;
  const chats = listChats(ctx.sync).filter(
    (chat) => projectIdOfChat(ctx.sync, chat.id) === project.id,
  );
  return (
    <div className="wc-project form">
      <label>
        <span>{t("Name", "Nom")}</span>
        <input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{t("Instructions for this project", "Instructions pour ce projet")}</span>
        <textarea
          rows={5}
          maxLength={MAX_INSTRUCTIONS_CHARS}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <fieldset className="wc-choices">
        <legend>{t("Memory", "Mémoire")}</legend>
        <label className="check">
          <input
            type="radio"
            name={`memory-${project.id}`}
            checked={mode === AGENT_LITE.project.memoryDefault}
            onChange={() => setMode(AGENT_LITE.project.memoryDefault)}
          />
          {t(
            "Default: chats here use your memory",
            "Par défaut : les discussions ici utilisent votre mémoire",
          )}
        </label>
        <label className="check">
          <input
            type="radio"
            name={`memory-${project.id}`}
            checked={mode === AGENT_LITE.project.memoryProject}
            onChange={() => setMode(AGENT_LITE.project.memoryProject)}
          />
          {t(
            "Project only: chats here remember within this project, and see no other chat",
            "Projet uniquement : les discussions ici retiennent dans ce projet, et ne voient aucune autre discussion",
          )}
        </label>
      </fieldset>
      <div className="wc-row">
        <button
          className="button primary"
          type="button"
          disabled={!name.trim()}
          onClick={() =>
            void (async () => {
              await renameProject(ctx.sync, project.id, { name });
              await saveProjectSettings(ctx.sync, project.id, { instructions, memoryMode: mode });
              onDone(t("Project saved.", "Projet enregistré."));
            })()
          }
        >
          {t("Save project", "Enregistrer le projet")}
        </button>
        <button className="button" type="button" onClick={onNewChat}>
          {t("New chat in this project", "Nouvelle discussion dans ce projet")}
        </button>
      </div>
      <h2>{t("Files", "Fichiers")}</h2>
      <p className="quiet">
        {t(
          "Files are read in this browser. Their text travels with the project, so every device can search it.",
          "Les fichiers sont lus dans ce navigateur. Leur texte voyage avec le projet, pour que chaque appareil puisse y chercher.",
        )}
      </p>
      <ul className="wc-plain">
        {project.files.map((file) => (
          <li key={file.id} className="wc-row">
            <span>{file.name}</span>
            {file.status !== "ready" && (
              <span className="quiet">{t("Not readable yet", "Pas encore lisible")}</span>
            )}
            <button
              className="button"
              type="button"
              onClick={() =>
                void removeProjectFile(ctx.sync, file.id).then(() =>
                  onDone(t("File removed.", "Fichier retiré.")),
                )
              }
            >
              {t(`Remove ${file.name}`, `Retirer ${file.name}`)}
            </button>
          </li>
        ))}
      </ul>
      <label className="button wc-attach">
        {t("Add a file", "Ajouter un fichier")}
        <input
          className="sr-only"
          type="file"
          accept={ACCEPTED_FILES.replace("image/*,", "")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void (async () => {
              try {
                const read = await readDocument({
                  name: file.name,
                  bytes: new Uint8Array(await file.arrayBuffer()),
                });
                await addProjectFile(ctx.sync, project.id, {
                  name: file.name,
                  format: read.format,
                  text: read.text,
                });
                onDone(t("File added.", "Fichier ajouté."));
              } catch (failure) {
                onError(documentFailure(failure));
              }
            })();
          }}
        />
      </label>
      <h2>{t("Chats in this project", "Discussions de ce projet")}</h2>
      {chats.length === 0 ? (
        <p className="quiet">
          {t("No chat in this project yet.", "Aucune discussion dans ce projet.")}
        </p>
      ) : (
        <ul className="wc-plain">
          {chats.map((chat) => (
            <li key={chat.id}>
              <button type="button" className="wc-chat-row" onClick={() => ctx.openChat(chat.id)}>
                <strong>{chat.title || t("Untitled chat", "Discussion sans titre")}</strong>
                {chat.updatedAt && <span className="quiet">{date(chat.updatedAt)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wc-row">
        {confirm ? (
          <>
            <button
              className="button"
              type="button"
              onClick={() =>
                void deleteProject(ctx.sync, project.id).then(() => {
                  onDeleted();
                  onDone(
                    t(
                      "Project deleted. Its chats and memories are kept.",
                      "Projet supprimé. Ses discussions et souvenirs sont gardés.",
                    ),
                  );
                })
              }
            >
              {t("Delete this project", "Supprimer ce projet")}
            </button>
            <button className="button" type="button" onClick={() => setConfirm(false)}>
              {t("Keep it", "Le garder")}
            </button>
          </>
        ) : (
          <button className="button" type="button" onClick={() => setConfirm(true)}>
            {t("Delete project", "Supprimer le projet")}
          </button>
        )}
      </div>
    </div>
  );
}
