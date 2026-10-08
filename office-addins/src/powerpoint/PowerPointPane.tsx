import { useState } from "react";
import { t } from "../../../website/src/lib/i18n";
import { type Engine, officeTurn } from "../model";
import { ShownError } from "../pane/errors";
import { Proposal } from "../pane/Proposal";
import { useProposal } from "../pane/useProposal";
import { fill, OFFICE } from "../words";
import type { PowerPointHost } from "./host";
import { type Drafted, deckBytes, slideDrafting } from "./slides";

/**
 * PowerPoint: slides drafted from a request or a pasted note, listed for
 * review, and added to the presentation only on "Add" (ADR-0102).
 */
export function PowerPointPane({
  host,
  engine,
  canInsert,
}: {
  host: PowerPointHost;
  engine: Engine;
  /** PowerPointApi 1.2, which inserts slides. */
  canInsert: boolean;
}) {
  const { proposal, error, setError, ask, discard } = useProposal<Drafted>();
  const [request, setRequest] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");

  const draft = () =>
    ask(async ({ signal, onText }) => {
      setDone("");
      const drafting = slideDrafting();
      const question = note.trim()
        ? fill(OFFICE.powerpoint.withNote, { request: request.trim(), note: note.trim() })
        : request.trim();
      const answer = await officeTurn(engine, question, [drafting.addition], { signal, onText });
      const drafted = drafting.drafted();
      if (!drafted?.slides.length)
        throw new ShownError(
          t(
            "No slides were drafted. Say what the slides should cover and try again.",
            "Aucune diapositive n’a été rédigée. Dites ce qu’elles doivent couvrir et réessayez.",
          ),
        );
      return { text: answer, value: drafted };
    });

  const insert = async () => {
    const drafted = proposal?.value;
    if (!drafted) return;
    try {
      await host.insertSlides(await deckBytes(drafted.request));
      setDone(
        t(
          `Added ${drafted.slides.length} slides to the presentation.`,
          `${drafted.slides.length} diapositives ajoutées à la présentation.`,
        ),
      );
      discard();
    } catch {
      setError(
        t(
          "PowerPoint did not accept the slides. Try again.",
          "PowerPoint n’a pas accepté les diapositives. Réessayez.",
        ),
      );
    }
  };

  return (
    <>
      <section className="office-section">
        <label className="office-field">
          {t("What should the slides cover?", "Que doivent couvrir les diapositives ?")}
          <textarea rows={3} value={request} onChange={(event) => setRequest(event.target.value)} />
        </label>
        <label className="office-field">
          {t(
            "Paste a note to draw from (optional)",
            "Collez une note dont vous inspirer (facultatif)",
          )}
          <textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <button
          className="button primary"
          type="button"
          disabled={proposal?.pending || !request.trim()}
          onClick={() => void draft()}
        >
          {t("Draft the slides", "Rédiger les diapositives")}
        </button>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="notice" role="status">
          {done}
        </p>
      )}
      {proposal && (
        <Proposal
          text={proposal.text}
          pending={proposal.pending}
          onDiscard={discard}
          actions={
            proposal.value &&
            (canInsert ? (
              <button className="button primary" type="button" onClick={() => void insert()}>
                {t(
                  `Add ${proposal.value.slides.length} slides`,
                  `Ajouter ${proposal.value.slides.length} diapositives`,
                )}
              </button>
            ) : (
              <p className="quiet">
                {t(
                  "This version of PowerPoint cannot add slides from an add-in. Update Office to add them.",
                  "Cette version de PowerPoint ne peut pas ajouter de diapositives depuis un complément. Mettez Office à jour pour les ajouter.",
                )}
              </p>
            ))
          }
        >
          {proposal.value && (
            <ol className="office-slides">
              {proposal.value.slides.map((slide, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed once drafted.
                <li key={index}>
                  <strong>{slide.title}</strong>
                  {slide.subtitle && <span className="quiet"> {slide.subtitle}</span>}
                  {[...slide.bullets, ...slide.left.bullets, ...slide.right.bullets].length > 0 && (
                    <ul>
                      {[...slide.bullets, ...slide.left.bullets, ...slide.right.bullets].map(
                        (bullet, at) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
                          <li key={at}>{bullet.text}</li>
                        ),
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Proposal>
      )}
    </>
  );
}
