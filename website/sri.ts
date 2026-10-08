/**
 * Subresource Integrity for the scripts and stylesheets the built page names
 * (ADR 0096). The site already serves only its own origin; integrity adds that
 * a file altered after the build, in a cache or on the disk of the server,
 * is refused by the browser instead of run next to a spending key. Chunks the
 * entry imports at run time are not covered: a browser has no way to pin an
 * `import()`.
 */
export function addIntegrity(
  html: string,
  base: string,
  integrityOf: (fileName: string) => string | undefined,
): string {
  return html.replace(
    /<(script|link)\b([^>]*?)\s(src|href)="([^"]+)"([^>]*)>/g,
    (tag, element: string, before: string, attribute: string, url: string, after: string) => {
      if (/\sintegrity=/.test(tag) || !url.startsWith(base)) return tag;
      if (element === "link" && !/\brel="(stylesheet|modulepreload)"/.test(tag)) return tag;
      const integrity = integrityOf(url.slice(base.length));
      if (integrity === undefined) return tag;
      return `<${element}${before} ${attribute}="${url}"${after} integrity="${integrity}">`;
    },
  );
}
