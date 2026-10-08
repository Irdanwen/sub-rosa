import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { addIntegrity } from "./sri";

/** Writes the integrity of every entry file into the built HTML (see sri.ts). */
export function subresourceIntegrity(): Plugin {
  let base = "/";
  return {
    name: "subrosa-sri",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      base = config.base;
    },
    // After the files are written, from the bytes on disk: later build steps
    // still rewrite chunk code during generateBundle, and a digest of anything
    // but the final file would make the browser refuse the page.
    writeBundle(options, bundle) {
      const dir = options.dir ?? "dist";
      const integrityOf = (fileName: string) => {
        const path = join(dir, fileName);
        if (!existsSync(path)) return undefined;
        return `sha384-${createHash("sha384").update(readFileSync(path)).digest("base64")}`;
      };
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith(".html")) continue;
        const path = join(dir, fileName);
        writeFileSync(path, addIntegrity(readFileSync(path, "utf8"), base, integrityOf));
      }
    },
  };
}
