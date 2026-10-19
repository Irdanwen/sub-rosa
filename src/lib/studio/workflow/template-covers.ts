// The pictures made once for the built-in templates, shipped with the app
// and shown wherever a template is offered: the desktop library's cards and
// the phone's Apps screen.

const TEMPLATE_COVERS = import.meta.glob("../../../assets/workflow-covers/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

/** The shipped cover of a template, by its id; none for a workflow of yours. */
export function templateCover(id: string | undefined): string | undefined {
  return id ? TEMPLATE_COVERS[`../../../assets/workflow-covers/${id}.webp`] : undefined;
}
