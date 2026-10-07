import type { ReactNode } from "react";
import { t } from "./i18n";
import { Markdown, webLink } from "./markdown";

/**
 * Chat blocks in a shared conversation, read on the website.
 *
 * In the app a reply can carry rich cards (ADR-0024): links, places, notes,
 * proposed actions, each a fenced JSON object tagged `subrosa:<kind>`. A share
 * keeps them as that JSON, and this page shows each one as a plain list:
 * no map, no photo, no button, and nothing fetched. Every value is written as
 * text through React, and a link is only ever a web link (`webLink`), so a
 * block cannot carry markup or a script into the page.
 */
export type MessagePart = { id: number } & (
  | { kind: "text"; text: string }
  | { kind: "block"; name: string; payload: Record<string, unknown> | null }
);

const FENCE = /^\s*```subrosa:([a-z][a-z0-9_-]{0,31})\s*$/i;

/** Splits a message into its prose and its chat blocks, in order. A block
 * whose JSON does not parse is kept as a block with no payload. */
export function splitChatBlocks(content: string): MessagePart[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const parts: MessagePart[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.join("\n").trim())
      parts.push({ id: parts.length, kind: "text", text: prose.join("\n") });
    prose = [];
  };
  let index = 0;
  while (index < lines.length) {
    const fence = FENCE.exec(lines[index]);
    if (!fence) {
      prose.push(lines[index]);
      index += 1;
      continue;
    }
    flush();
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !lines[index].trim().startsWith("```")) {
      body.push(lines[index]);
      index += 1;
    }
    index += 1;
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(body.join("\n"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
    parts.push({ id: parts.length, kind: "block", name: fence[1].toLowerCase(), payload });
  }
  flush();
  return parts;
}

function text(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** The objects of a block's list, at most fifty, each with its position as
 * a key: a block is read once and never reordered. */
function items(value: unknown): { key: string; item: Record<string, unknown> }[] {
  const out: { key: string; item: Record<string, unknown> }[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (out.length === 50) break;
    if (item && typeof item === "object" && !Array.isArray(item))
      out.push({ key: `row-${out.length}`, item: item as Record<string, unknown> });
  }
  return out;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function linkRows(payload: Record<string, unknown>): ReactNode[] {
  return items(payload.links).map(({ key, item: link }) => {
    const title = text(link.title, 200);
    const target = typeof link.url === "string" ? webLink(link.url) : null;
    const snippet = text(link.snippet);
    if (!title && !target) return null;
    return (
      <li key={key}>
        {target ? (
          <a href={target} target="_blank" rel="noreferrer noopener">
            {title || target}
          </a>
        ) : (
          <strong>{title}</strong>
        )}
        {target ? <span className="chat-block-meta"> · {domainOf(target)}</span> : null}
        {snippet ? <p>{snippet}</p> : null}
      </li>
    );
  });
}

function placeRows(payload: Record<string, unknown>): ReactNode[] {
  return items(payload.places).map(({ key, item: place }) => {
    const name = text(place.name, 200);
    if (!name) return null;
    const rating = typeof place.rating === "number" ? place.rating : null;
    const reviews = typeof place.reviews === "number" ? place.reviews : null;
    const details = [
      text(place.address),
      text(place.category, 80),
      rating !== null
        ? reviews !== null
          ? t(`Rated ${rating} (${reviews} reviews)`, `Noté ${rating} (${reviews} avis)`)
          : t(`Rated ${rating}`, `Noté ${rating}`)
        : "",
    ].filter(Boolean);
    const note = text(place.note);
    return (
      <li key={key}>
        <strong>{name}</strong>
        {details.length ? <span className="chat-block-meta"> · {details.join(" · ")}</span> : null}
        {note ? <p>{note}</p> : null}
      </li>
    );
  });
}

function noteRows(payload: Record<string, unknown>): ReactNode[] {
  return items(payload.notes).map(({ key, item: note }) => {
    const title = text(note.title, 200);
    if (!title) return null;
    const snippet = text(note.snippet);
    return (
      <li key={key}>
        <strong>{title}</strong>
        {snippet ? <p>{snippet}</p> : null}
      </li>
    );
  });
}

function actionRows(payload: Record<string, unknown>): ReactNode[] {
  return items(payload.actions).map(({ key, item: action }) => {
    const label = text(action.label, 200);
    return label ? <li key={key}>{label}</li> : null;
  });
}

const HEADINGS: Record<string, () => string> = {
  links: () => t("Links", "Liens"),
  places: () => t("Places", "Lieux"),
  notes: () => t("Notes cited", "Notes citées"),
  proposal: () => t("Suggested actions", "Actions proposées"),
};

/** One chat block as a titled list, or a quiet line for what only the app
 * can show (a generated image, an unknown kind, a block that did not parse). */
export function ChatBlockList({
  name,
  payload,
}: {
  name: string;
  payload: Record<string, unknown> | null;
}) {
  const rows = !payload
    ? []
    : name === "links"
      ? linkRows(payload)
      : name === "places"
        ? placeRows(payload)
        : name === "notes"
          ? noteRows(payload)
          : name === "proposal"
            ? actionRows(payload)
            : [];
  const shown = rows.filter(Boolean);
  if (shown.length === 0)
    return (
      <p className="chat-block chat-block-missing">
        {t(
          "This reply showed something only the app can display.",
          "Cette réponse affichait un contenu que seule l’application peut montrer.",
        )}
      </p>
    );
  const title = payload ? text(payload.title, 200) : "";
  return (
    <section className="chat-block" data-kind={name}>
      <h3>{title || HEADINGS[name]?.() || ""}</h3>
      <ul>{shown}</ul>
    </section>
  );
}

/** A message's prose as markdown and its blocks as lists. */
export function MessageBody({ content }: { content: string }) {
  return (
    <>
      {splitChatBlocks(content).map((part) =>
        part.kind === "text" ? (
          <Markdown key={part.id} text={part.text} />
        ) : (
          <ChatBlockList key={part.id} name={part.name} payload={part.payload} />
        ),
      )}
    </>
  );
}
