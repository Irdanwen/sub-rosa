/**
 * Slides drafted with `make_document`'s own declaration (the documents export,
 * ADR-0090): in this pane the call is not a file in the gallery but a
 * proposal, built by the web client's ported writer and added to the open
 * presentation only when the person confirms (ADR-0102).
 */
import type { TurnAddition } from "../../../website/src/client/feature";
import {
  build,
  type DocumentRequest,
  packageParts,
  parseRequest,
} from "../../../website/src/client/documents/make";
import { DOCUMENTS } from "../../../website/src/client/documents/writers/exported";
import { parseSlides, type Slide } from "../../../website/src/client/documents/writers/pptx";
import { OFFICE } from "../words";

export interface Drafted {
  request: DocumentRequest;
  slides: Slide[];
}

/** The turn's addition, and what the model asked for once it called. */
export function slideDrafting(): { addition: TurnAddition; drafted: () => Drafted | null } {
  let drafted: Drafted | null = null;
  const name = DOCUMENTS.tool.function.name;
  return {
    addition: {
      tools: [DOCUMENTS.tool],
      prompt: OFFICE.powerpoint.section,
      run(called, args) {
        if (called !== name) return undefined;
        try {
          const request = parseRequest(args);
          if (request.kind !== "pptx") return OFFICE.powerpoint.refused;
          const slides = parseSlides(request.content);
          drafted = { request, slides };
          return OFFICE.powerpoint.proposed;
        } catch (error) {
          return `The slides were not drafted: ${error instanceof Error ? error.message : "invalid content"}`;
        }
      },
    },
    drafted: () => drafted,
  };
}

/** The deck's bytes, as the ported writer packages it. */
export async function deckBytes(request: DocumentRequest): Promise<Uint8Array> {
  return packageParts(build(request).parts);
}
