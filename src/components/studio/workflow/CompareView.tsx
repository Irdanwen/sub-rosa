// Before and after, one over the other, with a slider deciding where the
// second begins: the way to see what an upscale, a cutout or a retouch did.

import { type CSSProperties, useState } from "react";
import { t } from "../../../lib/i18n";

export function CompareView({ before, after }: { before?: string; after?: string }) {
  const [split, setSplit] = useState(50);
  if (!before || !after) {
    return (
      <p className="studio-node-port-label">
        {t("Connect two pictures, then run what makes them.")}
      </p>
    );
  }
  const style = { "--compare-split": `${split}%` } as CSSProperties;
  return (
    <div className="studio-compare nodrag" style={style}>
      <img src={before} alt={t("Before")} />
      <img className="studio-compare-after" src={after} alt={t("After")} />
      <input
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label={t("Where the second picture begins")}
        onChange={(event) => setSplit(Number(event.target.value))}
      />
    </div>
  );
}
