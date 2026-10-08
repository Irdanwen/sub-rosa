/**
 * What the research panel and the composer share in this tab: a question
 * handed from the composer to the panel, and a signal that a run changed so
 * an open panel reads the runs again.
 */
let handoff: string | null = null;
const listeners = new Set<() => void>();

/** The composer's draft, for the panel to start from. */
export function handOff(question: string) {
  handoff = question;
}
export function takeHandoff(): string | null {
  const value = handoff;
  handoff = null;
  return value;
}

export function changed() {
  for (const listener of listeners) listener();
}
export function onChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
