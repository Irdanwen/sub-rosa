import { t } from "../../i18n";
import type { CubeLut } from "./document";

/** .cube uses red-fastest order, matching a WebGL 3D texture's x axis. */
export function parseCube(text: string, name: string): CubeLut {
  let size = 0;
  const values: number[] = [],
    domainMin = [0, 0, 0],
    domainMax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line || line.startsWith("TITLE")) continue;
    const [key, ...args] = line.split(/\s+/);
    if (key === "LUT_3D_SIZE") {
      size = Number(args[0]);
      continue;
    }
    if (key === "DOMAIN_MIN" || key === "DOMAIN_MAX") {
      if (args.length !== 3 || args.some((v) => !Number.isFinite(Number(v))))
        throw new Error(t("The LUT contains an invalid domain."));
      (key === "DOMAIN_MIN" ? domainMin : domainMax).splice(0, 3, ...args.map(Number));
      continue;
    }
    if (key.startsWith("LUT_")) throw new Error(t("Choose a 3D .cube LUT."));
    const row = [key, ...args].map(Number);
    if (row.length !== 3 || row.some((n) => !Number.isFinite(n)))
      throw new Error(t("The LUT contains invalid colour values."));
    values.push(...row);
  }
  if (
    !Number.isInteger(size) ||
    size < 2 ||
    size > 65 ||
    values.length !== size ** 3 * 3 ||
    domainMax.some((n, i) => n <= domainMin[i])
  )
    throw new Error(
      t("The LUT size or domain is invalid. Use a 3D cube with 2 to 65 points per axis."),
    );
  return { name, size, values, domainMin, domainMax };
}
